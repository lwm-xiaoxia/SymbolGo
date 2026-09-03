import { LineMap } from '../core/lineMap.js';
import type { PositionMapper } from '../core/lineMap.js';
import { SymbolKind } from '../core/types.js';
import type { PlainRange, RawSymbol, StyleParseResult, StyleSyntax } from '../core/types.js';
import { extractOwnNames, resolveSelectors, splitSelectorList } from './selector.js';

export interface ParseStyleOptions {
  /** 复用外部构建的 LineMap（Vue SFC 场景下由整份文档共享） */
  lineMap?: PositionMapper;
  /** 扫描起点，默认 0 */
  start?: number;
  /** 扫描终点，默认 source.length */
  end?: number;
}

/** 这些 at-rule 的花括号块是“透明”的：内部选择器仍然沿用外层父选择器。 */
const TRANSPARENT_AT_RULES = new Set([
  'media',
  'supports',
  'container',
  'layer',
  'scope',
  'document',
  'if',
  'else',
  'each',
  'for',
  'while',
  'at-root',
  'starting-style'
]);

interface BlockContext {
  /** 该块内部的父选择器列表（已展开 `&`） */
  selectors: string[];
}

/**
 * 解析一段 CSS / SCSS / Less 源码，产出其中定义的符号与 import 路径。
 *
 * 采用单遍字符扫描而非完整 AST：足够覆盖“找定义”所需的信息，
 * 且对语法错误、模板插值等不规范内容有较强容错，不会因解析失败丢掉整份文件。
 */
export function parseStyle(
  source: string,
  syntax: StyleSyntax,
  options: ParseStyleOptions = {}
): StyleParseResult {
  const lineMap = options.lineMap ?? new LineMap(source);
  const start = options.start ?? 0;
  const end = options.end ?? source.length;
  const supportsLineComment = syntax !== 'css';

  const symbols: RawSymbol[] = [];
  const imports: string[] = [];
  const stack: BlockContext[] = [];

  let stmtStart = start;
  let parenDepth = 0;

  const currentSelectors = (): string[] =>
    stack.length > 0 ? stack[stack.length - 1].selectors : [];

  for (let i = start; i < end; i++) {
    const ch = source[i];

    // 块注释
    if (ch === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2);
      i = close === -1 ? end : close + 1;
      continue;
    }
    // 行注释：括号内（如 url(http://...)）不视为注释
    if (supportsLineComment && ch === '/' && source[i + 1] === '/' && parenDepth === 0) {
      const nl = source.indexOf('\n', i + 2);
      i = nl === -1 ? end : nl - 1;
      continue;
    }
    // 字符串
    if (ch === '"' || ch === "'") {
      i = skipString(source, i, end);
      continue;
    }
    if (ch === '(') {
      parenDepth++;
      continue;
    }
    if (ch === ')') {
      parenDepth = Math.max(0, parenDepth - 1);
      continue;
    }

    if (ch === '{') {
      const block = handlePrelude(
        source,
        stmtStart,
        i,
        syntax,
        currentSelectors(),
        lineMap,
        symbols
      );
      stack.push(block);
      stmtStart = i + 1;
      parenDepth = 0;
      continue;
    }

    if (ch === '}') {
      // 块内最后一条声明可以省略分号
      handleDeclaration(source, stmtStart, i, syntax, lineMap, symbols, imports);
      stack.pop();
      stmtStart = i + 1;
      parenDepth = 0;
      continue;
    }

    if (ch === ';' && parenDepth === 0) {
      handleDeclaration(source, stmtStart, i, syntax, lineMap, symbols, imports);
      stmtStart = i + 1;
      continue;
    }
  }

  // 文件末尾可能还有一条未闭合的声明（例如无分号的 @import）
  handleDeclaration(source, stmtStart, end, syntax, lineMap, symbols, imports);

  return { symbols, imports };
}

function skipString(source: string, quoteIndex: number, end: number): number {
  const quote = source[quoteIndex];
  for (let i = quoteIndex + 1; i < end; i++) {
    const ch = source[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === quote) {
      return i;
    }
    if (ch === '\n') {
      // 未闭合的字符串不跨行吞掉整份文件
      return i;
    }
  }
  return end;
}

interface Statement {
  /** 注释已被替换为等长空格的文本，用于所有解析判断 */
  text: string;
  /** 原始文本，用于 Hover 展示 */
  raw: string;
  /** text[0] 在源码中的绝对偏移 */
  offset: number;
}

/**
 * 取出一段语句：先把其中的注释替换成等长空格，再去掉首尾空白。
 *
 * 主扫描循环虽然会跳过注释，但语句文本是按“上一个分隔符到当前分隔符”整段切出来的，
 * 中间的注释仍会留在里面（例如 `/* 主色 *\/ .btn { }`）。用等长空格屏蔽既能避免误解析，
 * 又能保证偏移量不变。
 */
function sliceStatement(
  source: string,
  start: number,
  end: number,
  lineComments: boolean
): Statement {
  const raw = source.slice(start, end);
  const masked = maskComments(raw, lineComments);
  let s = 0;
  let e = masked.length;
  while (s < e && /\s/.test(masked[s])) {
    s++;
  }
  while (e > s && /\s/.test(masked[e - 1])) {
    e--;
  }
  return { text: masked.slice(s, e), raw: raw.slice(s, e), offset: start + s };
}

/** 把注释内容替换成等长空格（换行保留），字符串内部不受影响。 */
export function maskComments(text: string, lineComments: boolean): string {
  let out = '';
  // `url(http://a.com/b.png)` 里的 `//` 不是注释，用括号深度区分
  let parenDepth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') {
      parenDepth++;
      out += ch;
      continue;
    }
    if (ch === ')') {
      parenDepth = Math.max(0, parenDepth - 1);
      out += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const start = i;
      i++;
      while (i < text.length && text[i] !== ch) {
        if (text[i] === '\\') {
          i++;
        }
        i++;
      }
      out += text.slice(start, Math.min(i + 1, text.length));
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      const stop = close === -1 ? text.length : close + 2;
      out += blank(text.slice(i, stop));
      i = stop - 1;
      continue;
    }
    if (lineComments && parenDepth === 0 && ch === '/' && text[i + 1] === '/') {
      let nl = text.indexOf('\n', i + 2);
      if (nl === -1) {
        nl = text.length;
      }
      out += blank(text.slice(i, nl));
      i = nl - 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/** 用等长空格替换文本，保留换行以免行号错位。 */
function blank(text: string): string {
  let out = '';
  for (const ch of text) {
    out += ch === '\n' || ch === '\r' ? ch : ' ';
  }
  return out;
}

/**
 * 处理 `{` 之前的前导文本：可能是选择器列表，也可能是 at-rule。
 * 返回新块的上下文（供内部嵌套使用）。
 */
function handlePrelude(
  source: string,
  start: number,
  braceIndex: number,
  syntax: StyleSyntax,
  parents: string[],
  lineMap: PositionMapper,
  symbols: RawSymbol[]
): BlockContext {
  const { text, raw, offset } = sliceStatement(source, start, braceIndex, syntax !== 'css');
  if (!text) {
    return { selectors: parents };
  }
  const fullRange = lineMap.rangeAt(offset, offset + text.length);

  if (text.startsWith('@')) {
    return handleAtRulePrelude(text, raw, offset, syntax, parents, lineMap, symbols, fullRange);
  }

  // SCSS 占位符选择器 %name
  if (syntax === 'scss' || syntax === 'sass') {
    const placeholderRe = /(^|[\s,>+~(])%([-_a-zA-Z][-\w]*)/g;
    let ph: RegExpExecArray | null;
    while ((ph = placeholderRe.exec(text)) !== null) {
      const nameStart = offset + ph.index + ph[1].length + 1;
      symbols.push({
        kind: SymbolKind.ScssPlaceholder,
        name: ph[2],
        range: lineMap.rangeAt(nameStart, nameStart + ph[2].length),
        fullRange,
        detail: raw
      });
    }
  }

  // Less mixin 定义：.mixin(...) { } / #ns(...) { }
  if (syntax === 'less') {
    const mixin = /^([.#])([-_a-zA-Z][-\w]*)\s*\(/.exec(text);
    if (mixin) {
      const nameStart = offset + 1;
      symbols.push({
        kind: SymbolKind.LessMixin,
        name: mixin[2],
        range: lineMap.rangeAt(nameStart, nameStart + mixin[2].length),
        fullRange,
        detail: raw
      });
    }
  }

  const parts = splitSelectorList(text);
  for (const part of parts) {
    const names = extractOwnNames(part.text, parents);
    for (const name of names) {
      const nameStart = offset + part.offset + name.start;
      symbols.push({
        kind: name.kind === 'class' ? SymbolKind.CssClass : SymbolKind.CssId,
        name: name.name,
        range: lineMap.rangeAt(nameStart, offset + part.offset + name.end),
        fullRange,
        detail: raw,
        container: parents.length > 0 ? parents[0] : undefined
      });
    }
  }

  return { selectors: resolveSelectors(parts, parents) };
}

function handleAtRulePrelude(
  text: string,
  raw: string,
  offset: number,
  syntax: StyleSyntax,
  parents: string[],
  lineMap: PositionMapper,
  symbols: RawSymbol[],
  fullRange: PlainRange
): BlockContext {
  const at = /^@(-[\w]+-)?([\w-]+)/.exec(text);
  const keyword = at ? at[2].toLowerCase() : '';

  const push = (kind: SymbolKind, name: string, nameIndexInText: number): void => {
    const nameStart = offset + nameIndexInText;
    symbols.push({
      kind,
      name,
      range: lineMap.rangeAt(nameStart, nameStart + name.length),
      fullRange,
      detail: raw
    });
  };

  if (keyword === 'keyframes') {
    const m = /^@(?:-[\w]+-)?keyframes\s+([^\s{'"]+)/.exec(text);
    if (m && !m[1].includes('#{')) {
      push(SymbolKind.Keyframes, m[1], m[0].length - m[1].length);
    }
    // keyframes 内部是 from / to / 百分比，不参与选择器嵌套
    return { selectors: [] };
  }

  if (keyword === 'mixin' && (syntax === 'scss' || syntax === 'sass')) {
    const m = /^@mixin\s+([-\w]+)/.exec(text);
    if (m) {
      push(SymbolKind.ScssMixin, m[1], m[0].length - m[1].length);
    }
    return { selectors: parents };
  }

  if (keyword === 'function') {
    const m = /^@function\s+(--[-\w]+|[-\w]+)/.exec(text);
    if (m) {
      const kind = m[1].startsWith('--') ? SymbolKind.CssFunction : SymbolKind.ScssFunction;
      push(kind, m[1], m[0].length - m[1].length);
    }
    return { selectors: [] };
  }

  // Less 的 detached ruleset：@name: { ... }
  if (syntax === 'less') {
    const m = /^@([-\w]+)\s*:\s*$/.exec(text);
    if (m) {
      push(SymbolKind.LessVariable, m[1], 1);
      return { selectors: [] };
    }
  }

  if (TRANSPARENT_AT_RULES.has(keyword)) {
    return { selectors: parents };
  }

  return { selectors: parents };
}

/** 处理以 `;` 或 `}` 结束的一条声明 / 语句。 */
function handleDeclaration(
  source: string,
  start: number,
  end: number,
  syntax: StyleSyntax,
  lineMap: PositionMapper,
  symbols: RawSymbol[],
  imports: string[]
): void {
  const { text, raw, offset } = sliceStatement(source, start, end, syntax !== 'css');
  if (!text) {
    return;
  }
  const fullRange = lineMap.rangeAt(offset, offset + text.length);

  // CSS 自定义属性
  const cssVar = /^(--[-\w]+)\s*:/.exec(text);
  if (cssVar) {
    symbols.push({
      kind: SymbolKind.CssVariable,
      name: cssVar[1],
      range: lineMap.rangeAt(offset, offset + cssVar[1].length),
      fullRange,
      detail: raw
    });
    return;
  }

  if ((syntax === 'scss' || syntax === 'sass') && text.startsWith('$')) {
    const m = /^\$([-\w]+)\s*:/.exec(text);
    if (m) {
      symbols.push({
        kind: SymbolKind.ScssVariable,
        name: m[1],
        range: lineMap.rangeAt(offset + 1, offset + 1 + m[1].length),
        fullRange,
        detail: raw
      });
    }
    return;
  }

  if (text.startsWith('@')) {
    const at = /^@([\w-]+)/.exec(text);
    const keyword = at ? at[1].toLowerCase() : '';
    if (keyword === 'import' || keyword === 'use' || keyword === 'forward') {
      imports.push(...extractQuoted(text));
      return;
    }
    if (syntax === 'less') {
      const m = /^@([-\w]+)\s*:/.exec(text);
      if (m) {
        symbols.push({
          kind: SymbolKind.LessVariable,
          name: m[1],
          range: lineMap.rangeAt(offset + 1, offset + 1 + m[1].length),
          fullRange,
          detail: raw
        });
      }
    }
  }
}

/** 取出语句中所有引号包裹的路径。 */
export function extractQuoted(text: string): string[] {
  const result: string[] = [];
  const re = /(['"])([^'"]*)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[2].trim()) {
      result.push(m[2].trim());
    }
  }
  return result;
}
