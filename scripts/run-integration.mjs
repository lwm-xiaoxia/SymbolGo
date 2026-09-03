/**
 * 在本机已安装的 VS Code 中运行扩展集成测试。
 *
 * 走的是 VS Code 官方的 `--extensionDevelopmentPath` + `--extensionTestsPath` 机制，
 * 测试内部用 `vscode.executeDefinitionProvider` 触发，与用户 Ctrl + 左键 / F12 是同一条链路。
 *
 * 可用 VSCODE_PATH 环境变量指定 Code 可执行文件位置。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import os from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const report = join(root, 'out', 'integration-report.txt');

const candidates = [
  process.env.VSCODE_PATH,
  join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code', 'Code.exe'),
  'C:\\Program Files\\Microsoft VS Code\\Code.exe',
  '/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
  '/usr/share/code/code',
  '/usr/bin/code'
].filter(Boolean);

const executable = candidates.find((p) => existsSync(p));
if (!executable) {
  console.error('未找到 VS Code 可执行文件，请设置 VSCODE_PATH 环境变量后重试。');
  process.exit(1);
}

rmSync(report, { force: true });

// 独立的用户数据目录，避免复用正在运行的实例，也不污染用户配置
const userDataDir = join(os.tmpdir(), 'symbolgo-vscode-test');

const result = spawnSync(
  executable,
  [
    `--user-data-dir=${userDataDir}`,
    `--extensions-dir=${join(userDataDir, 'ext')}`,
    '--disable-workspace-trust',
    `--extensionDevelopmentPath=${root}`,
    `--extensionTestsPath=${join(root, 'out', 'test', 'integration', 'index.js')}`,
    join(root, 'fixtures', 'demo')
  ],
  { stdio: 'ignore' }
);

if (existsSync(report)) {
  console.log(readFileSync(report, 'utf8'));
} else {
  console.error('测试未产出报告，可能是扩展宿主启动失败。');
}

process.exit(result.status ?? 1);
