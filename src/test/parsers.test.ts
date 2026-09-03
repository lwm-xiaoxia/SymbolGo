import assert from 'node:assert/strict';
import test from 'node:test';

import { parseStyleRegion } from '../core/analyzer.js';
import { LineMap } from '../core/lineMap.js';
import { SymbolKind } from '../core/types.js';
import type { RawSymbol } from '../core/types.js';
import { resolveMarkupCursor } from '../parsers/markupContext.js';
import { extractOwnNames } from '../parsers/selector.js';
import { resolveStyleCursor } from '../parsers/styleContext.js';
import { parseStyle } from '../parsers/styleParser.js';
import { parseSfcBlocks } from '../parsers/vueParser.js';

function names(symbols: RawSymbol[], kind: SymbolKind): string[] {
  return symbols.filter((s) => s.kind === kind).map((s) => s.name);
}

function find(symbols: RawSymbol[], kind: SymbolKind, name: string): RawSymbol | undefined {
  return symbols.find((s) => s.kind === kind && s.name === name);
}

test('嵌套 & 能解析出完整类名，且不重复登记父类名', () => {
  const own = extractOwnNames('&__title', ['.user-card']);
  assert.deepEqual(
    own.map((n) => n.name),
    ['user-card__title']
  );

  const child = extractOwnNames('& .child', ['.user-card']);
  assert.deepEqual(
    child.map((n) => n.name),
    ['child']
  );

  const modifier = extractOwnNames('&.is-active', ['.user-card']);
  assert.deepEqual(
    modifier.map((n) => n.name),
    ['is-active']
  );
});

test('SCSS：嵌套类、变量、mixin、function、placeholder、keyframes', () => {
  const source = [
    '$primary: #06f;',
    '@mixin button-base($size) { padding: $size; }',
    '@function rem($px) { @return $px / 16 * 1rem; }',
    '%visually-hidden { position: absolute; }',
    '.user-card {',
    '  &__title { color: $primary; }',
    '  &--large .badge { font-size: rem(12); }',
    '  #main & { color: red; }',
    '  @media (min-width: 768px) { &__footer { display: flex; } }',
    '}',
    '@keyframes fade-in { from { opacity: 0; } }'
  ].join('\n');

  const { symbols } = parseStyle(source, 'scss');

  assert.deepEqual(names(symbols, SymbolKind.ScssVariable), ['primary']);
  assert.deepEqual(names(symbols, SymbolKind.ScssMixin), ['button-base']);
  assert.deepEqual(names(symbols, SymbolKind.ScssFunction), ['rem']);
  assert.deepEqual(names(symbols, SymbolKind.ScssPlaceholder), ['visually-hidden']);
  assert.deepEqual(names(symbols, SymbolKind.Keyframes), ['fade-in']);

  const classes = names(symbols, SymbolKind.CssClass);
  assert.ok(classes.includes('user-card'));
  assert.ok(classes.includes('user-card__title'));
  assert.ok(classes.includes('user-card--large'));
  assert.ok(classes.includes('badge'));
  // @media 内部仍应沿用外层父选择器
  assert.ok(classes.includes('user-card__footer'));
  // 后代选择器里父级的类名不应被重复登记到子块位置
  assert.equal(classes.filter((c) => c === 'user-card').length, 1);
  assert.deepEqual(names(symbols, SymbolKind.CssId), ['main']);
});

test('SCSS：符号位置指向名字本身', () => {
  const source = '.user-card {\n  &__title { color: red; }\n}\n';
  const { symbols } = parseStyle(source, 'scss');
  const title = find(symbols, SymbolKind.CssClass, 'user-card__title');
  assert.ok(title);
  assert.equal(title.range.start.line, 1);
  // `&__title` 中属于本层的部分是 `__title`
  assert.equal(source.split('\n')[1].slice(title.range.start.character, title.range.end.character), '__title');
});

test('Less：变量、mixin、detached ruleset 与嵌套', () => {
  const source = [
    '@primary: #06f;',
    '@ruleset: { color: red; };',
    '.bordered(@width: 1px) { border: @width solid @primary; }',
    '.panel {',
    '  &__header { .bordered(2px); }',
    '  @media screen { &__body { color: @primary; } }',
    '}'
  ].join('\n');

  const { symbols } = parseStyle(source, 'less');
  const lessVars = names(symbols, SymbolKind.LessVariable);
  assert.ok(lessVars.includes('primary'));
  assert.ok(lessVars.includes('ruleset'));
  assert.deepEqual(names(symbols, SymbolKind.LessMixin), ['bordered']);

  const classes = names(symbols, SymbolKind.CssClass);
  assert.ok(classes.includes('panel'));
  assert.ok(classes.includes('panel__header'));
  assert.ok(classes.includes('panel__body'));
});

test('CSS：自定义属性、@function 与注释容错', () => {
  const source = [
    ':root {',
    '  --brand-color: #06f; /* 主色 */',
    '}',
    '@function --double(--x) { result: calc(var(--x) * 2); }',
    '.box { color: var(--brand-color); background: url(http://a.com/b.png); }'
  ].join('\n');

  const { symbols } = parseStyle(source, 'css');
  assert.ok(names(symbols, SymbolKind.CssVariable).includes('--brand-color'));
  assert.deepEqual(names(symbols, SymbolKind.CssFunction), ['--double']);
  assert.ok(names(symbols, SymbolKind.CssClass).includes('box'));
});

test('样式解析忽略字符串与注释中的伪选择器', () => {
  const source = [
    '/* .commented-out {} */',
    '// .line-commented {}',
    '.real[data-x=".fake"] { content: ".not-a-class"; }'
  ].join('\n');
  const { symbols } = parseStyle(source, 'scss');
  assert.deepEqual(names(symbols, SymbolKind.CssClass), ['real']);
});

test('@import / @use 路径被收集', () => {
  const { imports } = parseStyle('@use "sass:math";\n@import "./variables", "./mixins";\n', 'scss');
  assert.deepEqual(imports, ['sass:math', './variables', './mixins']);
});

test('缩进语法 Sass 能解析出符号且位置回落到原文', () => {
  const source = ['$gap: 8px', '.user-card', '  &__title', '    color: red', '  padding: $gap'].join(
    '\n'
  );
  const { symbols } = parseStyleRegion(source, 'sass', 0, source.length, new LineMap(source));

  assert.deepEqual(names(symbols, SymbolKind.ScssVariable), ['gap']);
  const classes = names(symbols, SymbolKind.CssClass);
  assert.ok(classes.includes('user-card'));
  assert.ok(classes.includes('user-card__title'));

  const title = find(symbols, SymbolKind.CssClass, 'user-card__title');
  assert.ok(title);
  assert.equal(title.range.start.line, 2);
});

test('Vue SFC 块拆分与 style 块解析', () => {
  const source = [
    '<template>',
    '  <div class="user-card"><template v-if="ok">x</template></div>',
    '</template>',
    '',
    '<script setup lang="ts">',
    "import UserAvatar from './UserAvatar.vue';",
    "import styles from './card.module.css';",
    '</script>',
    '',
    '<style lang="scss" scoped>',
    '.user-card { &__title { color: red; } }',
    '</style>'
  ].join('\n');

  const blocks = parseSfcBlocks(source);
  assert.deepEqual(
    blocks.map((b) => b.tag),
    ['template', 'script', 'style']
  );
  const style = blocks[2];
  assert.equal(style.attrs.lang, 'scss');
  assert.ok('scoped' in style.attrs);

  const lineMap = new LineMap(source);
  const { symbols } = parseStyleRegion(
    source,
    'scss',
    style.contentStart,
    style.contentEnd,
    lineMap
  );
  const classes = names(symbols, SymbolKind.CssClass);
  assert.ok(classes.includes('user-card'));
  assert.ok(classes.includes('user-card__title'));
});

test('模板中识别 class / id / 组件 / CSS Modules 成员', () => {
  const html = '<div class="user-card is-active" id="main"><UserAvatar :size="2" /></div>';

  const onClass = resolveMarkupCursor(html, html.indexOf('is-active') + 2);
  assert.deepEqual(onClass && { kind: onClass.kind, name: onClass.name }, {
    kind: 'class',
    name: 'is-active'
  });

  const onId = resolveMarkupCursor(html, html.indexOf('"main"') + 3);
  assert.deepEqual(onId && { kind: onId.kind, name: onId.name }, { kind: 'id', name: 'main' });

  const onTag = resolveMarkupCursor(html, html.indexOf('UserAvatar') + 3);
  assert.deepEqual(onTag && { kind: onTag.kind, name: onTag.name }, {
    kind: 'component',
    name: 'UserAvatar'
  });

  // 标签外的同名文本不应被识别
  assert.equal(resolveMarkupCursor('<p>user-card</p>', 5), null);
});

test('动态 class 表达式中只取光标所在的字面量或对象键', () => {
  const vue = `<div :class="['user-card', { 'is-active': ok, disabled: no }]"></div>`;
  const onLiteral = resolveMarkupCursor(vue, vue.indexOf('user-card') + 2);
  assert.equal(onLiteral?.name, 'user-card');

  const onKey = resolveMarkupCursor(vue, vue.indexOf('is-active') + 2);
  assert.equal(onKey?.name, 'is-active');

  const onBareKey = resolveMarkupCursor(vue, vue.indexOf('disabled') + 2);
  assert.equal(onBareKey?.name, 'disabled');

  // 变量名不是类名，不应被识别
  assert.equal(resolveMarkupCursor(vue, vue.indexOf('ok,') + 1)?.kind, undefined);
});

test('JSX 的 className 与 CSS Modules 成员访问', () => {
  const jsx = 'const A = () => <div className={styles.userCard} id="root" />;';
  const onMember = resolveMarkupCursor(jsx, jsx.indexOf('userCard') + 2);
  assert.deepEqual(onMember && { kind: onMember.kind, name: onMember.name, object: onMember.object }, {
    kind: 'member',
    name: 'userCard',
    object: 'styles'
  });

  const bracket = "styles['user-card']";
  const onBracket = resolveMarkupCursor(bracket, bracket.indexOf('user-card') + 2);
  assert.equal(onBracket?.object, 'styles');
  assert.equal(onBracket?.name, 'user-card');

  const staticJsx = '<div className="a-b c-d" />';
  assert.equal(resolveMarkupCursor(staticJsx, staticJsx.indexOf('c-d') + 1)?.name, 'c-d');
});

test('样式代码中的光标语义识别', () => {
  const scss = '.a { color: $primary; @include button-base(1); animation: fade-in 1s; }';
  assert.deepEqual(pick(scss, '$primary', 2, 'scss'), {
    kind: SymbolKind.ScssVariable,
    name: 'primary'
  });
  assert.deepEqual(pick(scss, 'button-base', 2, 'scss'), {
    kind: SymbolKind.ScssMixin,
    name: 'button-base'
  });
  assert.deepEqual(pick(scss, 'fade-in', 2, 'scss'), {
    kind: SymbolKind.Keyframes,
    name: 'fade-in'
  });

  const less = '.a { color: @primary; .bordered(2px); }';
  assert.deepEqual(pick(less, '@primary', 2, 'less'), {
    kind: SymbolKind.LessVariable,
    name: 'primary'
  });
  assert.deepEqual(pick(less, '.bordered', 3, 'less'), {
    kind: SymbolKind.LessMixin,
    name: 'bordered'
  });

  const css = '.a { color: var(--brand-color); }';
  assert.deepEqual(pick(css, '--brand-color', 3, 'css'), {
    kind: SymbolKind.CssVariable,
    name: '--brand-color'
  });

  // 命名空间形式的 @include 不能被当成类选择器
  const namespaced = '.a { @include mixins.button-base(); }';
  assert.deepEqual(pick(namespaced, 'button-base', 2, 'scss'), {
    kind: SymbolKind.ScssMixin,
    name: 'button-base'
  });
});

function pick(
  source: string,
  needle: string,
  innerOffset: number,
  syntax: 'css' | 'scss' | 'sass' | 'less'
): { kind: SymbolKind; name: string } | null {
  const cursor = resolveStyleCursor(source, source.indexOf(needle) + innerOffset, syntax);
  return cursor ? { kind: cursor.kinds[0], name: cursor.name } : null;
}
