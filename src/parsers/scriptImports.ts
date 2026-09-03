/**
 * 轻量的 import 语句解析。
 *
 * 只需要“本地名 -> 模块路径”这一层信息，用来判断：
 * - 组件是否已经被当前文件 import（决定是否让内置 JS/TS 跳转接管）；
 * - `styles.foo` 中的 `styles` 是否指向某个样式文件；
 * - 当前文件直接关联了哪些样式文件。
 */

export interface ImportBinding {
  /** 本地绑定名；副作用导入没有绑定名 */
  local: string;
  /** 原始模块路径，未做解析 */
  source: string;
  /** import 语句在源码中的偏移，便于排序或调试 */
  offset: number;
}

export interface ScriptImports {
  bindings: ImportBinding[];
  /** 所有被引入的模块路径，含副作用导入 */
  sources: string[];
}

const IMPORT_FROM_RE = /\bimport\s+([\s\S]*?)\s+from\s*['"]([^'"]+)['"]/g;
const SIDE_EFFECT_RE = /\bimport\s*['"]([^'"]+)['"]/g;
const REQUIRE_RE = /\b(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g;
const BARE_REQUIRE_RE = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;
/** `const Foo = defineAsyncComponent(() => import('./Foo.vue'))` 之类的异步组件写法 */
const DYNAMIC_RE =
  /\b(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*[\s\S]{0,120}?\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

/** 解析脚本中的 import / require，返回绑定表与全部模块路径。 */
export function parseScriptImports(source: string): ScriptImports {
  const bindings: ImportBinding[] = [];
  const sources = new Set<string>();

  let m: RegExpExecArray | null;

  IMPORT_FROM_RE.lastIndex = 0;
  while ((m = IMPORT_FROM_RE.exec(source)) !== null) {
    const clause = m[1];
    const from = m[2];
    sources.add(from);
    for (const local of parseImportClause(clause)) {
      bindings.push({ local, source: from, offset: m.index });
    }
  }

  SIDE_EFFECT_RE.lastIndex = 0;
  while ((m = SIDE_EFFECT_RE.exec(source)) !== null) {
    sources.add(m[1]);
  }

  REQUIRE_RE.lastIndex = 0;
  while ((m = REQUIRE_RE.exec(source)) !== null) {
    bindings.push({ local: m[1], source: m[2], offset: m.index });
    sources.add(m[2]);
  }

  BARE_REQUIRE_RE.lastIndex = 0;
  while ((m = BARE_REQUIRE_RE.exec(source)) !== null) {
    sources.add(m[1]);
  }

  DYNAMIC_RE.lastIndex = 0;
  while ((m = DYNAMIC_RE.exec(source)) !== null) {
    bindings.push({ local: m[1], source: m[2], offset: m.index });
    sources.add(m[2]);
  }

  return { bindings, sources: [...sources] };
}

/**
 * 解析 import 子句中的本地绑定名。
 * 支持 `Foo`、`* as ns`、`{ a, b as c }`、`type` 修饰以及它们的组合。
 */
export function parseImportClause(clause: string): string[] {
  const locals: string[] = [];
  const text = clause.replace(/^\s*type\s+/, '').trim();
  if (!text) {
    return locals;
  }

  const braceStart = text.indexOf('{');
  const head = braceStart === -1 ? text : text.slice(0, braceStart);
  const braces = braceStart === -1 ? '' : text.slice(braceStart + 1, text.lastIndexOf('}'));

  for (const piece of head.split(',')) {
    const t = piece.trim();
    if (!t) {
      continue;
    }
    const ns = /^\*\s+as\s+([A-Za-z0-9_$]+)$/.exec(t);
    if (ns) {
      locals.push(ns[1]);
      continue;
    }
    if (/^[A-Za-z0-9_$]+$/.test(t)) {
      locals.push(t);
    }
  }

  for (const piece of braces.split(',')) {
    const t = piece.trim().replace(/^type\s+/, '');
    if (!t) {
      continue;
    }
    const aliased = /^[\w$]+\s+as\s+([A-Za-z0-9_$]+)$/.exec(t);
    if (aliased) {
      locals.push(aliased[1]);
      continue;
    }
    if (/^[A-Za-z0-9_$]+$/.test(t)) {
      locals.push(t);
    }
  }

  return locals;
}
