// 一条命令完成：升版本号 → 打包 → 发布到 VS Code Marketplace + GitHub Releases（可选 Open VSX）。
//
// 用法：
//   node scripts/release.mjs                # 补丁号 +1（1.0.2 → 1.0.3）
//   node scripts/release.mjs patch|minor|major
//   node scripts/release.mjs 1.2.0          # 指定版本号（必须比当前大）
//
// 常用开关：
//   --dry-run          只演练，不改文件、不 commit、不发布
//   --no-marketplace   不发 VS Code Marketplace
//   --no-github        不发 GitHub Release
//   --ovsx             额外发布到 Open VSX（默认不发）
//   --no-git           不 commit / tag / push（版本号仍会写进 package.json）
//   --publish-only     不升版本 / 不动 git，把当前版本补发到之前跳过或失败的平台
//   --strict          有想发的平台因缺凭据被跳过时，退出码 1（默认只警告、退出 0）
//   --skip-checks      跳过 typecheck + lint + build 预检
//   --yes              不再交互确认
//
// 顺序（关键）：写版本 → 打包 → 本地 commit + tag → 发 Marketplace/Open VSX →
//               这些都成功才 git push commit + tag → 最后发 GitHub Release。
//   —— GitHub 放最后：gh release create 会自己在远端建 tag，必须等本地 tag 先推上去，
//      否则本地 / 远端 tag 指向不一致，后续 push tag 被拒。
//   —— Marketplace/Open VSX 失败时 git 还没推，可干净回退（脚本会打印命令）。
//
// 凭据：
//   Marketplace : 环境变量 VSCE_PAT
//   Open VSX    : 环境变量 OVSX_PAT
//   GitHub      : 本机已 `gh auth login`（无需 token）

import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = join(root, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

// ── 参数解析 ───────────────────────────────────────────────
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const positional = argv.filter((a) => !a.startsWith('--'));

const dryRun = flags.has('--dry-run');
const doOvsx = flags.has('--ovsx');
const doGit = !flags.has('--no-git');
const skipChecks = flags.has('--skip-checks');
const assumeYes = flags.has('--yes');
const strict = flags.has('--strict'); // 有想发的平台被跳过时，非 0 退出（CI 用）
const publishOnly = flags.has('--publish-only');

// ── 计算版本号 ─────────────────────────────────────────────
const current = pkg.version;
const parts = current.split('.').map(Number);
if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n))) {
  fail(`package.json 里的 version 不是合法 x.y.z：${current}`);
}
const [maj, min, pat] = parts;

let next;
if (publishOnly) {
  next = current; // 只补发，不动版本号
} else {
  const bumpArg = positional[0] ?? 'patch';
  if (bumpArg === 'patch') next = `${maj}.${min}.${pat + 1}`;
  else if (bumpArg === 'minor') next = `${maj}.${min + 1}.0`;
  else if (bumpArg === 'major') next = `${maj + 1}.0.0`;
  else if (/^\d+\.\d+\.\d+$/.test(bumpArg)) next = bumpArg;
  else fail(`版本参数只接受 patch / minor / major / x.y.z，收到：${bumpArg}`);

  if (cmpVersion(next, current) <= 0) {
    fail(`新版本号 ${next} 必须大于当前 ${current}`);
  }
}
const tag = `v${next}`;
const willGit = doGit && !publishOnly && !dryRun;

// ── 前置检查：工作区干净 ──────────────────────────────────
if (existsSync(join(root, '.git')) && !dryRun && !publishOnly) {
  const dirty = run('git', ['status', '--porcelain'], { capture: true }).trim();
  if (dirty) {
    fail('工作区有未提交改动，请先提交或 stash：\n' + dirty);
  }
}

// ── 前置检查：目标平台 + 凭据 ─────────────────────────────
// 每个平台：enabled（用户没 --no-X）→ 检查凭据 → 决定 publish / skip / abort
const platforms = [
  {
    name: 'Marketplace',
    enabled: !flags.has('--no-marketplace'),
    ready: () => !!process.env.VSCE_PAT,
    missing: 'VSCE_PAT 环境变量',
    url: `https://marketplace.visualstudio.com/items?itemName=${pkg.publisher}.${pkg.name}`,
  },
  {
    name: 'Open VSX',
    enabled: doOvsx,
    ready: () => !!process.env.OVSX_PAT,
    missing: 'OVSX_PAT 环境变量',
    url: `https://open-vsx.org/extension/${pkg.publisher}/${pkg.name}`,
  },
  {
    name: 'GitHub',
    enabled: !flags.has('--no-github'),
    ready: () => ghReady(),
    missing: 'gh 未安装或未登录（gh auth login）',
    url: `${(pkg.repository?.url || '').replace(/\.git$/, '')}/releases/tag/${tag}`,
  },
];

const wanted = platforms.filter((p) => p.enabled);
const targets = wanted.filter((p) => p.ready());
const skipped = wanted.filter((p) => !p.ready());

const changelogNote = extractChangelogSection(next);

// ── 概览 + 确认 ────────────────────────────────────────────
console.log('──────────────────────────────────────────');
console.log(
  publishOnly
    ? `  补发 ${pkg.name}   ${current}（不升版本、不动 git）`
    : `  发布 ${pkg.name}   ${current} → ${next}`,
);
console.log(`  发布目标：${targets.map((p) => p.name).join(' + ') || '（无）'}`);
if (skipped.length > 0) {
  console.log(`  将跳过：  ${skipped.map((p) => `${p.name}（缺 ${p.missing}）`).join('，')}`);
}
if (willGit) console.log(`  git：     本地 commit + tag ${tag}，全部发布成功后才 push`);
if (!changelogNote && targets.some((p) => p.name === 'GitHub')) {
  console.log(`  ⚠ CHANGELOG.md 没有 "## ${next}" 小节，GitHub 发布说明将由 git 提交自动生成`);
}
if (dryRun) console.log('  [dry-run] 只演练，不会真正改动 / 发布');
console.log('──────────────────────────────────────────');

if (targets.length === 0 && !dryRun) {
  fail('没有可发布的平台。检查凭据，或用 --no-xxx 明确你的意图。');
}

if (!assumeYes && !dryRun) {
  const ans = await ask(
    skipped.length > 0 ? '有平台将被跳过（见上）。确认继续？(y/N) ' : '确认继续？(y/N) ',
  );
  if (ans !== 'y' && ans !== 'yes') process.exit(0);
}

// ── 预检：类型 / lint / 构建 ───────────────────────────────
if (!skipChecks) {
  step('类型检查 + lint + 构建');
  runNodeBin('node_modules/typescript/bin/tsc', ['--noEmit', '-p', 'tsconfig.json']);
  runNodeBin('node_modules/eslint/bin/eslint.js', ['src', '--ext', 'ts']);
  run('node', ['scripts/build.mjs', '--production']);
}

// ── 写版本号 ───────────────────────────────────────────────
if (!publishOnly && !dryRun) {
  step(`写入 version = ${next}`);
  pkg.version = next;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
}

// ── 打包 ───────────────────────────────────────────────────
const vsixName = `${pkg.name}-${next}.vsix`;
const vsixPath = join(root, vsixName);
if (publishOnly && existsSync(vsixPath)) {
  step(`复用已有产物 ${vsixName}`);
} else if (!dryRun) {
  step('vsce package');
  for (const f of readdirSync(root).filter((f) => f.endsWith('.vsix'))) {
    unlinkSync(join(root, f));
  }
  run('node', ['./node_modules/@vscode/vsce/vsce', 'package', '--no-dependencies', '-o', vsixPath]);
} else {
  step(`[dry-run] 会生成 ${vsixName}`);
}

// ── 本地 commit + tag（先不 push）─────────────────────────
let committed = false;
if (willGit) {
  step(`git commit + tag ${tag}（本地）`);
  run('git', ['add', 'package.json', 'CHANGELOG.md']);
  run('git', ['commit', '-m', `chore: release ${tag}`]);
  run('git', ['tag', tag]);
  committed = true;
}

// GitHub Release 要在 tag 已推到远端之后再发（否则 gh 会自己在远端旧 HEAD 上建 tag，
// 造成本地 tag 与远端 tag 指向不一致、后续 git push tag 被拒）。
// 因此顺序：先发 Marketplace/Open VSX → 都成功才 git push commit+tag → 最后发 GitHub。
const preGitTargets = targets.filter((p) => p.name !== 'GitHub');
const githubTarget = targets.find((p) => p.name === 'GitHub');

// ── 阶段 1：发 Marketplace / Open VSX（不碰 git）────────────
const results = [];
for (const p of preGitTargets) {
  step(`发布到 ${p.name}`);
  if (dryRun) {
    results.push([p.name, 'dry-run', vsixName]);
    continue;
  }
  try {
    publishTo(p.name);
    results.push([p.name, 'ok', p.url]);
  } catch (e) {
    results.push([p.name, 'fail', firstLine(e)]);
  }
}
const preGitFailed = results.some((r) => r[1] === 'fail');

// ── 阶段 2：前序平台都成功 → 推 commit + tag ──────────────
let pushed = false;
if (committed && !preGitFailed && !dryRun) {
  step(`git push commit + ${tag}`);
  run('git', ['push']);
  run('git', ['push', 'origin', tag]);
  pushed = true;
}

// ── 阶段 3：发 GitHub Release（tag 此时已在远端）──────────
if (githubTarget) {
  step('发布到 GitHub');
  if (dryRun) {
    results.push(['GitHub', 'dry-run', vsixName]);
  } else if (willGit && !pushed) {
    // 前序平台失败、没 push，不建 Release，免得又产生游离 tag
    results.push(['GitHub', 'skip', '前序平台失败、未 push，跳过']);
  } else {
    try {
      publishTo('GitHub');
      results.push(['GitHub', 'ok', githubTarget.url]);
    } catch (e) {
      results.push(['GitHub', 'fail', firstLine(e)]);
    }
  }
}

for (const p of skipped) {
  results.push([p.name, 'skip', `缺 ${p.missing}`]);
}

const anyOk = results.some((r) => r[1] === 'ok');
const anyFail = results.some((r) => r[1] === 'fail');

// ── 汇总 ───────────────────────────────────────────────────
console.log('\n──────────────── 结果 ────────────────');
for (const [name, state, detail] of results) {
  const mark = { ok: '✔', fail: '✗', skip: '—', 'dry-run': '·' }[state] ?? '?';
  console.log(`  ${mark} ${name.padEnd(12)} ${detail}`);
}
if (committed) {
  console.log(`  ${pushed ? '✔' : '·'} git          ${pushed ? `已推送 commit + ${tag}` : `本地已 commit + tag ${tag}（未 push）`}`);
}
console.log(`\n本地产物：${vsixName}`);

// ── 失败时的收尾指引 ─────────────────────────────────────
if (anyFail) {
  console.log('\n──────────────── 收尾 ────────────────');
  if (committed && !pushed) {
    // 前序平台失败，没 push —— git 历史还没动，可以干净回退 / 或补发
    if (!anyOk) {
      console.log('  所有平台都没发出去，git 未推送。回退本地这次发布提交：');
      console.log(`    git reset --hard HEAD~1 && git tag -d ${tag}`);
    } else {
      console.log('  部分平台已发布、git 未推送。修好失败平台后：');
      console.log(`    $env:VSCE_PAT="..."; node scripts/release.mjs --publish-only --yes`);
      console.log(`    git push; git push origin ${tag}          # 再手动把本次提交推上去`);
    }
  } else {
    // commit+tag 已推送（或 --no-git），只是某平台没发成
    console.log('  commit + tag 已就绪，只是有平台没发成。配好凭据后补发即可：');
    console.log(`    node scripts/release.mjs --publish-only --yes`);
  }
}

// 被跳过（缺凭据）不算失败——概览里已列出、交互也确认过了，只留一句提醒。
if (skipped.length > 0 && !anyFail) {
  console.log(
    `\n提醒：${skipped
      .map((p) => p.name)
      .join(' / ')} 未发布（缺凭据）。配好后补发：node scripts/release.mjs --publish-only --yes`,
  );
}

// 退出码：发布出错 → 1；只是缺凭据被跳过 → 默认 0，加 --strict 才 1
if (anyFail) {
  console.log('\n有平台发布失败（见上），退出码 1。');
  process.exit(1);
}
if (strict && skipped.length > 0) {
  console.log('\n--strict：有平台被跳过，退出码 1。');
  process.exit(1);
}

// ── 具体发布动作 ──────────────────────────────────────────
function publishTo(name) {
  if (name === 'Marketplace') {
    run('node', [
      './node_modules/@vscode/vsce/vsce',
      'publish',
      '--no-dependencies',
      '--skip-duplicate',
      '--packagePath',
      vsixPath,
    ]);
    return;
  }
  if (name === 'Open VSX') {
    run('npx', ['ovsx', 'publish', vsixPath], {
      shell: true,
      env: { ...process.env, OVSX_PAT: process.env.OVSX_PAT },
    });
    return;
  }
  if (name === 'GitHub') {
    const repoArg = repoSlug();
    const repoFlag = repoArg ? ['--repo', repoArg] : [];
    const exists = tryRun('gh', ['release', 'view', tag, ...repoFlag]);
    if (exists) {
      // release 已存在（补发 / 重跑）：只更新 vsix 附件
      run('gh', ['release', 'upload', tag, vsixPath, '--clobber', ...repoFlag]);
    } else {
      const args = ['release', 'create', tag, vsixPath, '--title', `${pkg.displayName || pkg.name} ${tag}`];
      if (changelogNote) args.push('--notes', changelogNote);
      else args.push('--generate-notes');
      run('gh', [...args, ...repoFlag]);
    }
  }
}

// ── 工具函数 ───────────────────────────────────────────────
function step(msg) {
  console.log(`\n▶ ${msg}`);
}
function fail(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}
async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(question)).trim().toLowerCase();
  rl.close();
  return a;
}
function run(cmd, args, opts = {}) {
  // 默认不经过 shell：Windows 下 shell:true 会把 args 拼成字符串且不转义，
  // 导致带空格 / 特殊字符的参数（提交信息、--notes 正文）被拆散。
  // git / gh / node 都是真实可执行文件，直接 spawn 即可。
  return (
    execFileSync(cmd, args, {
      cwd: root,
      stdio: opts.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
      encoding: 'utf8',
      shell: opts.shell === true,
      env: opts.env ?? process.env,
    }) ?? ''
  );
}
// 用 node 直接跑 node_modules 里的 CLI，绕开 Windows 上的 npx.cmd（.cmd 需要 shell）。
function runNodeBin(relBinPath, args) {
  run('node', [join(root, relBinPath), ...args]);
}
/** 静默执行，成功返回 true，失败返回 false（用于探测型命令）。 */
function tryRun(cmd, args) {
  try {
    execFileSync(cmd, args, { cwd: root, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
/** owner/repo，取自 package.json 的 repository.url。 */
function repoSlug() {
  const m = /github\.com[/:]([^/]+\/[^/.]+)/.exec(pkg.repository?.url ?? '');
  return m ? m[1] : '';
}
function ghReady() {
  return tryRun('gh', ['auth', 'status']);
}
function cmpVersion(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}
function firstLine(err) {
  return String(err?.message ?? err).split('\n')[0];
}
function extractChangelogSection(version) {
  const p = join(root, 'CHANGELOG.md');
  if (!existsSync(p)) return '';
  const text = readFileSync(p, 'utf8');
  const re = new RegExp(`^##\\s+\\[?${version.replace(/\./g, '\\.')}\\]?.*$`, 'm');
  const m = re.exec(text);
  if (!m) return '';
  const rest = text.slice(m.index + m[0].length);
  const nextHeading = rest.search(/^##\s+/m);
  return rest.slice(0, nextHeading === -1 ? undefined : nextHeading).trim();
}
