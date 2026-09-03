import { SymbolKind } from '../core/types.js';
import type { StyleSyntax } from '../core/types.js';

/** 样式代码中光标处识别出的跳转目标。 */
export interface StyleCursor {
  /** 候选符号种类，按优先级排列 */
  kinds: SymbolKind[];
  name: string;
  start: number;
  end: number;
  /** 命中的是 `@import` / `@use` / `@forward` 的路径时提供 */
  importPath?: string;
}

const WORD_RE = /[A-Za-z0-9_-]/;
/** 语句起点回溯上限，防止在超长压缩样式里退化 */
const STATEMENT_LOOKBEHIND = 4000;

/**
 * 识别样式代码中光标处的符号。
 *
 * 判定顺序：先看所在语句的关键字（`@include`、`@extend`、`@keyframes` 等），
 * 再看符号前缀（`$` `@` `%` `--` `.` `#`），最后看是否是函数调用或动画名。
 * 语句关键字优先是必要的：`@include mixins.button-base` 里的 `.` 是命名空间分隔符，
 * 不能当成类选择器。
 */
export function resolveStyleCursor(
  source: string,
  offset: number,
  syntax: StyleSyntax,
  regionStart = 0
): StyleCursor | null {
  const stmtStart = findStatementStart(source, offset, regionStart);
  const statement = source.slice(stmtStart, offset + 200);
  const keyword = /^\s*@([\w-]+)/.exec(statement)?.[1]?.toLowerCase() ?? '';

  // @import / @use / @forward 的路径
  if (keyword === 'import' || keyword === 'use' || keyword === 'forward') {
    const quoted = findQuotedAround(source, offset, stmtStart);
    if (quoted) {
      return {
        kinds: [],
        name: quoted.text,
        start: quoted.start,
        end: quoted.end,
        importPath: quoted.text
      };
    }
  }

  const word = wordAt(source, offset);
  if (!word) {
    return null;
  }
  const prefix = source[word.start - 1];

  if (keyword === 'include') {
    return { kinds: [SymbolKind.ScssMixin], name: word.text, start: word.start, end: word.end };
  }
  if (keyword === 'extend') {
    const kinds = prefix === '%' ? [SymbolKind.ScssPlaceholder] : [SymbolKind.CssClass];
    return { kinds, name: word.text, start: word.start, end: word.end };
  }
  if (keyword === 'keyframes' && prefix !== '.' && prefix !== '#') {
    return { kinds: [SymbolKind.Keyframes], name: word.text, start: word.start, end: word.end };
  }

  if (prefix === '$') {
    return {
      kinds: [SymbolKind.ScssVariable],
      name: word.text,
      start: word.start,
      end: word.end
    };
  }
  if (prefix === '%') {
    return {
      kinds: [SymbolKind.ScssPlaceholder],
      name: word.text,
      start: word.start,
      end: word.end
    };
  }
  // Less 变量：`@name` 与插值 `@{name}`
  if (prefix === '@' || (prefix === '{' && source[word.start - 2] === '@')) {
    return {
      kinds: [SymbolKind.LessVariable],
      name: word.text,
      start: word.start,
      end: word.end
    };
  }
  if (word.text.startsWith('--')) {
    const kinds = nextNonSpace(source, word.end) === '('
      ? [SymbolKind.CssFunction, SymbolKind.CssVariable]
      : [SymbolKind.CssVariable];
    return { kinds, name: word.text, start: word.start, end: word.end };
  }
  if (prefix === '.') {
    const kinds =
      syntax === 'less'
        ? [SymbolKind.LessMixin, SymbolKind.CssClass]
        : [SymbolKind.CssClass];
    return { kinds, name: word.text, start: word.start, end: word.end };
  }
  if (prefix === '#') {
    const kinds =
      syntax === 'less' ? [SymbolKind.LessMixin, SymbolKind.CssId] : [SymbolKind.CssId];
    return { kinds, name: word.text, start: word.start, end: word.end };
  }

  // 函数调用
  if (nextNonSpace(source, word.end) === '(') {
    return {
      kinds: [SymbolKind.ScssFunction, SymbolKind.CssFunction, SymbolKind.LessMixin],
      name: word.text,
      start: word.start,
      end: word.end
    };
  }

  // animation / animation-name 的值是 keyframes 名
  const property = /^\s*([-\w]+)\s*:/.exec(statement)?.[1]?.toLowerCase();
  if (property === 'animation' || property === 'animation-name') {
    return { kinds: [SymbolKind.Keyframes], name: word.text, start: word.start, end: word.end };
  }

  return null;
}

function wordAt(source: string, offset: number): { text: string; start: number; end: number } | null {
  let s = offset;
  while (s > 0 && WORD_RE.test(source[s - 1])) {
    s--;
  }
  let e = offset;
  while (e < source.length && WORD_RE.test(source[e])) {
    e++;
  }
  if (e <= s) {
    return null;
  }
  return { text: source.slice(s, e), start: s, end: e };
}

function nextNonSpace(source: string, from: number): string | undefined {
  let i = from;
  while (i < source.length && /\s/.test(source[i])) {
    i++;
  }
  return source[i];
}

/** 向前回溯到最近的 `;` / `{` / `}`，即当前语句的起点。 */
function findStatementStart(source: string, offset: number, regionStart: number): number {
  const limit = Math.max(regionStart, offset - STATEMENT_LOOKBEHIND);
  for (let i = offset - 1; i >= limit; i--) {
    const ch = source[i];
    if (ch === ';' || ch === '{' || ch === '}') {
      return i + 1;
    }
  }
  return limit;
}

function findQuotedAround(
  source: string,
  offset: number,
  from: number
): { text: string; start: number; end: number } | null {
  let i = from;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '"' || ch === "'") {
      const end = source.indexOf(ch, i + 1);
      if (end === -1) {
        return null;
      }
      if (offset > i && offset <= end) {
        return { text: source.slice(i + 1, end), start: i + 1, end };
      }
      i = end + 1;
      continue;
    }
    if (ch === ';' || ch === '{') {
      return null;
    }
    i++;
  }
  return null;
}
