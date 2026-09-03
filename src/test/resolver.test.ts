import assert from 'node:assert/strict';
import test from 'node:test';

// 必须最先引入：它会把 require('vscode') 换成内存桩
import {
  StubTextDocument,
  resetWorkspace,
  setConfig,
  setWorkspaceFolders,
  writeFile
} from './harness.js';

import { analyzeSource } from '../core/analyzer.js';
import { readConfig } from '../core/config.js';
import { DocumentCache } from '../core/documentCache.js';
import { Logger } from '../core/logger.js';
import { PathResolver } from '../core/pathResolver.js';
import { SymbolIndex } from '../core/symbolIndex.js';
import { SymbolResolver } from '../resolvers/symbolResolver.js';
import type { SymbolGoConfig } from '../core/config.js';
import type * as vscodeTypes from 'vscode';

const ROOT = 'file:///w';

interface Fixture {
  resolver: SymbolResolver;
  index: SymbolIndex;
  config: SymbolGoConfig;
}

/** 用一组内存文件搭出可跳转的工作区，并把样式文件全部索引好。 */
async function setup(
  fileMap: Record<string, string>,
  overrides: Record<string, unknown> = {}
): Promise<Fixture> {
  resetWorkspace();
  setConfig(overrides);
  setWorkspaceFolders([ROOT]);
  for (const [path, content] of Object.entries(fileMap)) {
    writeFile(`${ROOT}${path}`, content);
  }

  const config = readConfig();
  const logger = new Logger();
  const paths = new PathResolver(logger);
  await paths.reloadAliases(config);
  const index = new SymbolIndex();

  for (const [path, content] of Object.entries(fileMap)) {
    const uri = `${ROOT}${path}`;
    const analysis = analyzeSource(path, content);
    index.setFile(uri, analysis.symbols);
    const stem = path.split('/').pop() ?? '';
    if (/\.(vue|tsx|jsx)$/.test(stem)) {
      index.setComponent(uri, stem.replace(/\.\w+$/, ''));
    }
  }

  const docs = new DocumentCache(paths);
  const resolver = new SymbolResolver(index, docs, paths, logger, () => config);
  return { resolver, index, config };
}

/** 测试里把内存文档当成 vscode.TextDocument 使用，额外提供按文本定位光标的 positionOf。 */
type TestDocument = vscodeTypes.TextDocument & {
  positionOf(needle: string, delta?: number): vscodeTypes.Position;
};

function doc(path: string, content: string): TestDocument {
  return new StubTextDocument(`${ROOT}${path}`, content) as unknown as TestDocument;
}

test('Vue 模板中的 class 跳转到同文件 style 块的嵌套定义', async () => {
  const vue = [
    '<template>',
    '  <div class="user-card">',
    '    <h3 class="user-card__title">标题</h3>',
    '  </div>',
    '</template>',
    '',
    '<style lang="scss" scoped>',
    '.user-card {',
    '  &__title { color: red; }',
    '}',
    '</style>'
  ].join('\n');

  const { resolver } = await setup({ '/src/UserCard.vue': vue });
  const document = doc('/src/UserCard.vue', vue);

  const result = await resolver.resolve(document, document.positionOf('user-card__title', 3));
  assert.ok(result, '应当解析出定义');
  assert.equal(result.targets.length, 1);
  assert.equal(result.targets[0].uri.toString(), `${ROOT}/src/UserCard.vue`);
  // 定义位于 style 块中 `&__title` 那一行
  assert.equal(result.targets[0].range.start.line, 8);
});

test('Vue 模板中的 class 跳转到 import 进来的 SCSS 文件', async () => {
  const vue = [
    '<template><div class="panel__header"></div></template>',
    '<style lang="scss">',
    '@import "./panel.scss";',
    '</style>'
  ].join('\n');
  const scss = ['.panel {', '  &__header { color: blue; }', '}'].join('\n');

  const { resolver } = await setup({ '/src/Panel.vue': vue, '/src/panel.scss': scss });
  const document = doc('/src/Panel.vue', vue);

  const result = await resolver.resolve(document, document.positionOf('panel__header', 2));
  assert.ok(result);
  assert.equal(result.targets[0].uri.toString(), `${ROOT}/src/panel.scss`);
  assert.equal(result.targets[0].range.start.line, 1);
});

test('别名路径与 Less 变量跳转', async () => {
  const less = ['@primary: #06f;', '.btn { color: @primary; }'].join('\n');
  const { resolver } = await setup(
    { '/src/theme/vars.less': less },
    { alias: { '@': 'src' } }
  );
  const document = doc('/src/theme/vars.less', less);

  const result = await resolver.resolve(document, document.positionOf('color: @primary', 10));
  assert.ok(result);
  assert.equal(result.targets[0].range.start.line, 0);
});

test('SCSS @use 路径跳转到 partial 文件', async () => {
  const main = '@use "@/styles/variables";\n.a { color: red; }\n';
  const { resolver } = await setup(
    { '/src/main.scss': main, '/src/styles/_variables.scss': '$primary: #06f;\n' },
    { alias: { '@': 'src' } }
  );
  const document = doc('/src/main.scss', main);

  const result = await resolver.resolve(document, document.positionOf('@/styles/variables', 4));
  assert.ok(result);
  assert.equal(result.targets[0].uri.toString(), `${ROOT}/src/styles/_variables.scss`);
});

test('JSX 的 CSS Modules 成员只在对应模块中查找', async () => {
  const tsx = [
    "import styles from './Card.module.scss';",
    'export const Card = () => <div className={styles.title} />;'
  ].join('\n');
  const own = '.title { color: red; }\n';
  const other = '.title { color: blue; }\n';

  const { resolver } = await setup({
    '/src/Card.tsx': tsx,
    '/src/Card.module.scss': own,
    '/src/Other.scss': other
  });
  const document = doc('/src/Card.tsx', tsx);

  const result = await resolver.resolve(document, document.positionOf('styles.title', 8));
  assert.ok(result);
  assert.equal(result.targets.length, 1);
  assert.equal(result.targets[0].uri.toString(), `${ROOT}/src/Card.module.scss`);
});

test('组件跳转：未 import 的全局组件由 SymbolGo 兜底，已 import 的交给内置跳转', async () => {
  const globalUse = '<template><UserCard /></template>\n';
  const imported = [
    '<template><UserCard /></template>',
    '<script setup>',
    "import UserCard from './UserCard.vue';",
    '</script>'
  ].join('\n');

  const { resolver } = await setup({
    '/src/Page.vue': globalUse,
    '/src/Imported.vue': imported,
    '/src/UserCard.vue': '<template><div /></template>\n'
  });

  const globalDoc = doc('/src/Page.vue', globalUse);
  const globalResult = await resolver.resolve(globalDoc, globalDoc.positionOf('UserCard', 2));
  assert.ok(globalResult);
  assert.equal(globalResult.targets[0].uri.toString(), `${ROOT}/src/UserCard.vue`);

  const importedDoc = doc('/src/Imported.vue', imported);
  const importedResult = await resolver.resolve(
    importedDoc,
    importedDoc.positionOf('UserCard', 2)
  );
  assert.equal(importedResult, undefined, 'auto 模式下已 import 的组件不应重复提供结果');
});

test('kebab-case 标签能匹配 PascalCase 组件文件', async () => {
  const page = '<template><user-card /></template>\n';
  const { resolver } = await setup({
    '/src/Page.vue': page,
    '/src/UserCard.vue': '<template><div /></template>\n'
  });
  const document = doc('/src/Page.vue', page);
  const result = await resolver.resolve(document, document.positionOf('user-card', 2));
  assert.ok(result);
  assert.equal(result.targets[0].uri.toString(), `${ROOT}/src/UserCard.vue`);
});

test('原生 HTML 标签不会被当作组件', async () => {
  const page = '<template><div class="x" /></template>\n';
  const { resolver } = await setup({ '/src/Page.vue': page });
  const document = doc('/src/Page.vue', page);
  assert.equal(await resolver.resolve(document, document.positionOf('div', 1)), undefined);
});

test('style.scope 为 related 时不返回无关文件中的同名 class', async () => {
  const html = '<html><body><div class="lonely"></div></body></html>';
  const { resolver } = await setup(
    { '/src/page.html': html, '/src/unrelated.css': '.lonely { color: red; }\n' },
    { 'style.scope': 'related' }
  );
  const document = doc('/src/page.html', html);
  assert.equal(
    await resolver.resolve(document, document.positionOf('lonely', 2)),
    undefined
  );
});

test('style.scope 默认 smart：无关联样式时回退到整个工作区', async () => {
  const html = '<html><body><div class="lonely"></div></body></html>';
  const { resolver } = await setup({
    '/src/page.html': html,
    '/src/unrelated.css': '.lonely { color: red; }\n'
  });
  const document = doc('/src/page.html', html);
  const result = await resolver.resolve(document, document.positionOf('lonely', 2));
  assert.ok(result);
  assert.equal(result.targets[0].uri.toString(), `${ROOT}/src/unrelated.css`);
});

test('多处同名定义会全部返回，且关联文件排在前面', async () => {
  const vue = [
    '<template><div class="box"></div></template>',
    '<style>',
    '@import "./a.css";',
    '</style>'
  ].join('\n');
  const { resolver } = await setup(
    {
      '/src/Page.vue': vue,
      '/src/a.css': '.box { color: red; }\n',
      '/src/b.css': '.box { color: blue; }\n'
    },
    { 'style.scope': 'workspace' }
  );
  const document = doc('/src/Page.vue', vue);
  const result = await resolver.resolve(document, document.positionOf('"box"', 2));
  assert.ok(result);
  assert.equal(result.targets.length, 2);
  assert.equal(result.targets[0].uri.toString(), `${ROOT}/src/a.css`);
});
