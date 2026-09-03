import type { StyleSyntax } from './types.js';

/** SymbolGo 关心的文档大类。 */
export type DocKind = 'style' | 'vue' | 'html' | 'script';

/** 参与 class / id 跳转的标记语言文档。 */
export const MARKUP_LANGUAGES = [
  'vue',
  'html',
  'javascriptreact',
  'typescriptreact',
  'javascript',
  'typescript'
] as const;

/** 参与样式内部符号跳转的文档（Vue 的 style 块由 vue 文档一并处理）。 */
export const STYLE_LANGUAGES = ['css', 'scss', 'sass', 'less'] as const;

/**
 * 按文件名匹配的兜底 glob。
 *
 * `.vue` 的语言 id 由 Vue 官方扩展提供、`.sass` 缩进语法没有内置语言 id，
 * 未安装对应扩展时这些文件会落到 plaintext，仅靠 language id 注册会完全失效。
 * 追加 glob 选择器可以保证跳转始终可用。
 */
export const FILE_PATTERNS = ['**/*.vue', '**/*.sass'] as const;

const EXT_TO_STYLE: Record<string, StyleSyntax> = {
  css: 'css',
  scss: 'scss',
  sass: 'sass',
  less: 'less',
  pcss: 'css',
  postcss: 'css'
};

const SCRIPT_EXTS = new Set(['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts']);

/** 样式文件扩展名，用于判断某个 import 路径是不是样式模块。 */
export const STYLE_EXTS = Object.keys(EXT_TO_STYLE);

/** 组件文件扩展名，按解析优先级排列。 */
export const COMPONENT_EXTS = ['vue', 'tsx', 'jsx', 'ts', 'js', 'mts', 'mjs'];

export function extensionOf(fsPath: string): string {
  const base = fsPath.replace(/\\/g, '/').split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot === -1 ? '' : base.slice(dot + 1).toLowerCase();
}

export function baseNameOf(fsPath: string): string {
  return fsPath.replace(/\\/g, '/').split('/').pop() ?? '';
}

/** 去掉扩展名的文件名。 */
export function stemOf(fsPath: string): string {
  const base = baseNameOf(fsPath);
  const dot = base.lastIndexOf('.');
  return dot === -1 ? base : base.slice(0, dot);
}

export function dirNameOf(fsPath: string): string {
  const normalized = fsPath.replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  return slash === -1 ? '' : normalized.slice(0, slash);
}

/** 由文件路径推断文档大类；无法识别时返回 undefined。 */
export function docKindOfPath(fsPath: string): DocKind | undefined {
  const ext = extensionOf(fsPath);
  if (EXT_TO_STYLE[ext]) {
    return 'style';
  }
  if (ext === 'vue') {
    return 'vue';
  }
  if (ext === 'html' || ext === 'htm') {
    return 'html';
  }
  if (SCRIPT_EXTS.has(ext)) {
    return 'script';
  }
  return undefined;
}

/** 由文件路径推断样式方言。 */
export function styleSyntaxOfPath(fsPath: string): StyleSyntax | undefined {
  return EXT_TO_STYLE[extensionOf(fsPath)];
}

/** 判断某个 import 路径是否指向样式模块（允许带 `?inline` 之类的查询串）。 */
export function isStyleSource(source: string): boolean {
  const clean = source.split('?')[0];
  const ext = extensionOf(clean);
  return Boolean(EXT_TO_STYLE[ext]);
}

/**
 * 组件名归一化：忽略大小写、连字符与下划线。
 * 于是 `<user-card>`、`<UserCard>`、`user_card.vue` 可以互相匹配。
 */
export function normalizeComponentName(name: string): string {
  return name.replace(/[-_]/g, '').toLowerCase();
}

/** 判断标签名是否可能是组件（排除原生 HTML 标签）。 */
export function looksLikeComponent(tagName: string): boolean {
  if (!tagName) {
    return false;
  }
  // `Foo.Bar` 这类命名空间组件
  if (tagName.includes('.')) {
    return true;
  }
  if (/^[A-Z]/.test(tagName)) {
    return true;
  }
  return tagName.includes('-') && !HTML_TAGS.has(tagName.toLowerCase());
}

/** 原生 HTML 标签集合，用于排除 `<div>` 之类的误判。 */
export const HTML_TAGS = new Set([
  'a','abbr','address','area','article','aside','audio','b','base','bdi','bdo','blockquote','body',
  'br','button','canvas','caption','cite','code','col','colgroup','data','datalist','dd','del',
  'details','dfn','dialog','div','dl','dt','em','embed','fieldset','figcaption','figure','footer',
  'form','h1','h2','h3','h4','h5','h6','head','header','hgroup','hr','html','i','iframe','img',
  'input','ins','kbd','label','legend','li','link','main','map','mark','menu','meta','meter','nav',
  'noscript','object','ol','optgroup','option','output','p','picture','pre','progress','q','rp',
  'rt','ruby','s','samp','script','search','section','select','slot','small','source','span',
  'strong','style','sub','summary','sup','table','tbody','td','template','textarea','tfoot','th',
  'thead','time','title','tr','track','u','ul','var','video','wbr',
  'svg','path','circle','rect','line','polyline','polygon','g','defs','use','text','tspan'
]);
