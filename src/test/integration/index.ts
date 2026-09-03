import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

/**
 * 在真实的 VS Code Extension Host 中验证跳转。
 *
 * 用法（需要本机已安装 VS Code）：
 *   code --extensionDevelopmentPath=<项目根> \
 *        --extensionTestsPath=<项目根>/out/test/integration/index.js \
 *        <项目根>/fixtures/demo
 *
 * 这里走的是 VS Code 原生的 `vscode.executeDefinitionProvider` 命令，
 * 与用户 Ctrl + 左键 / F12 触发的是同一条链路。
 */

interface Case {
  name: string;
  file: string;
  /** 在文件中查找这段文本 */
  needle: string;
  /** 光标相对 needle 起点的偏移 */
  delta: number;
  /** 期望跳转到的文件（以此结尾） */
  expectFile: string;
  /** 期望目标所在行（0 基），省略则不校验 */
  expectLine?: number;
}

const CASES: Case[] = [
  {
    name: 'Vue 模板 class -> 同文件 style 块嵌套定义',
    file: 'src/components/UserCard.vue',
    needle: 'class="user-card__title"',
    delta: 10,
    expectFile: 'src/components/UserCard.vue'
  },
  {
    name: 'Vue 模板 class -> @import 引入的 SCSS 嵌套定义',
    file: 'src/pages/Home.vue',
    needle: 'class="home-page__header"',
    delta: 10,
    expectFile: 'src/pages/home.scss'
  },
  {
    name: 'Vue 模板 id -> SCSS 中的 id 选择器',
    file: 'src/pages/Home.vue',
    needle: 'id="app-root"',
    delta: 6,
    expectFile: 'src/pages/home.scss'
  },
  {
    name: '未 import 的全局组件 -> 组件文件',
    file: 'src/pages/Home.vue',
    needle: '<UserCard',
    delta: 3,
    expectFile: 'src/components/UserCard.vue'
  },
  {
    name: 'SCSS 中的 keyframes 名 -> @keyframes 定义',
    file: 'src/components/UserCard.vue',
    needle: 'animation: fade-in',
    delta: 12,
    expectFile: 'src/styles/_variables.scss'
  },
  {
    name: 'Less 变量 -> 变量定义',
    file: 'src/theme/theme.less',
    needle: 'color: @primary',
    delta: 8,
    expectFile: 'src/theme/theme.less',
    expectLine: 0
  },
  {
    name: 'Less mixin 调用 -> mixin 定义',
    file: 'src/theme/theme.less',
    needle: '.bordered(2px)',
    delta: 3,
    expectFile: 'src/theme/theme.less',
    expectLine: 3
  },
  {
    name: 'JSX CSS Modules 成员 -> 模块内的 class',
    file: 'src/react/Card.tsx',
    needle: 'styles.card__title',
    delta: 10,
    expectFile: 'src/react/Card.module.scss'
  },
  {
    name: 'HTML class -> link 引入的样式文件',
    file: 'index.html',
    needle: 'class="home-page"',
    delta: 9,
    expectFile: 'src/pages/home.scss'
  }
];

export async function run(): Promise<void> {
  const lines: string[] = [];
  const log = (message: string): void => {
    lines.push(message);
    console.log(message);
  };

  try {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, '未打开 fixtures/demo 工作区');

    await vscode.extensions.getExtension('symbolgo.symbolgo')?.activate();
    // 等待首次索引完成
    await waitForIndex(folder.uri);

    let failed = 0;
    for (const testCase of CASES) {
      try {
        await runCase(folder.uri, testCase);
        log(`PASS  ${testCase.name}`);
      } catch (error) {
        failed++;
        const message = error instanceof Error ? error.message : String(error);
        log(`FAIL  ${testCase.name}\n      ${message}`);
      }
    }
    log(`\n通过 ${CASES.length - failed}/${CASES.length}`);
    if (failed > 0) {
      throw new Error(`${failed} 个用例失败`);
    }
  } catch (error) {
    log(`ERROR ${error instanceof Error ? error.message : String(error)}`);
    writeReport(lines);
    throw error;
  }
  writeReport(lines);
}

/** VS Code CLI 在 Windows 下不会把子进程 stdout 回传，因此把结果落盘到扩展目录。 */
function writeReport(lines: string[]): void {
  const target =
    process.env.SYMBOLGO_TEST_REPORT ?? path.join(__dirname, '..', '..', 'integration-report.txt');
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${lines.join('\n')}\n`, 'utf8');
  } catch {
    // 报告写入失败不应影响测试结论
  }
}

async function runCase(root: vscode.Uri, testCase: Case): Promise<void> {
  const uri = vscode.Uri.joinPath(root, ...testCase.file.split('/'));
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document, { preview: true });

  const index = document.getText().indexOf(testCase.needle);
  assert.notEqual(index, -1, `文件 ${testCase.file} 中找不到 ${testCase.needle}`);
  const position = document.positionAt(index + testCase.delta);

  const locations = await execDefinition(document.uri, position);
  assert.ok(locations.length > 0, `在 ${testCase.file}:${position.line + 1} 处没有得到任何定义`);

  const matched = locations.find((loc) =>
    normalize(loc.uri.path).endsWith(normalize(testCase.expectFile))
  );
  assert.ok(
    matched,
    `期望跳转到 ${testCase.expectFile}，实际得到：${locations
      .map((l) => `${l.uri.path}:${l.range.start.line + 1}`)
      .join(', ')}`
  );
  if (testCase.expectLine !== undefined) {
    assert.equal(matched.range.start.line, testCase.expectLine, '目标行不符合预期');
  }
}

interface FlatLocation {
  uri: vscode.Uri;
  range: vscode.Range;
}

/** 定义结果可能是 Location 或 LocationLink，统一成一种形态。 */
async function execDefinition(
  uri: vscode.Uri,
  position: vscode.Position
): Promise<FlatLocation[]> {
  const raw = await vscode.commands.executeCommand<
    (vscode.Location | vscode.LocationLink)[]
  >('vscode.executeDefinitionProvider', uri, position);
  return (raw ?? []).map((item) =>
    'targetUri' in item
      ? { uri: item.targetUri, range: item.targetSelectionRange ?? item.targetRange }
      : { uri: item.uri, range: item.range }
  );
}

/** 轮询等待索引可用：以一个必然存在的跳转作为探针。 */
async function waitForIndex(root: vscode.Uri): Promise<void> {
  const probe = vscode.Uri.joinPath(root, 'src', 'pages', 'Home.vue');
  const document = await vscode.workspace.openTextDocument(probe);
  const index = document.getText().indexOf('class="home-page__header"');
  const position = document.positionAt(index + 10);

  for (let attempt = 0; attempt < 40; attempt++) {
    const locations = await execDefinition(document.uri, position);
    if (locations.length > 0) {
      return;
    }
    await delay(250);
  }
  throw new Error('等待索引超时：10 秒内仍无法解析出定义');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalize(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase();
}
