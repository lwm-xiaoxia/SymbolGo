import { LineMap } from './lineMap.js';
import { docKindOfPath, isStyleSource, styleSyntaxOfPath } from './languages.js';
import type { DocKind } from './languages.js';
import { MappedPositionMapper, sassToBraces } from '../parsers/sassIndented.js';
import { parseScriptImports } from '../parsers/scriptImports.js';
import type { ImportBinding } from '../parsers/scriptImports.js';
import { parseStyle } from '../parsers/styleParser.js';
import { blockAt, parseSfcBlocks, styleSyntaxFromLang } from '../parsers/vueParser.js';
import type { SfcBlock } from '../parsers/vueParser.js';
import type { RawSymbol, StyleSyntax } from './types.js';

export interface FileAnalysis {
  kind: DocKind;
  /** 文件内定义的符号 */
  symbols: RawSymbol[];
  /** 该文件直接关联的样式模块路径（未解析成绝对路径） */
  styleSources: string[];
  /** 脚本中的 import 绑定，用于组件与 CSS Modules 解析 */
  bindings: ImportBinding[];
  /** Vue SFC 的块信息，非 SFC 为空数组 */
  blocks: SfcBlock[];
}

const EMPTY: FileAnalysis = { kind: 'script', symbols: [], styleSources: [], bindings: [], blocks: [] };

/**
 * 解析一份源码，产出索引与跳转所需的全部信息。
 *
 * 这是唯一的解析入口：索引构建与 Provider 实时解析共用它，
 * 保证“索引里看到的”和“光标处判断的”始终一致。
 */
export function analyzeSource(fsPath: string, text: string): FileAnalysis {
  const kind = docKindOfPath(fsPath);
  if (!kind) {
    return EMPTY;
  }
  switch (kind) {
    case 'style':
      return analyzeStyleFile(fsPath, text);
    case 'vue':
      return analyzeVue(text);
    case 'html':
      return analyzeHtml(text);
    case 'script':
      return analyzeScript(text);
    default:
      return EMPTY;
  }
}

function analyzeStyleFile(fsPath: string, text: string): FileAnalysis {
  const syntax = styleSyntaxOfPath(fsPath) ?? 'css';
  const result = parseStyleRegion(text, syntax, 0, text.length);
  return {
    kind: 'style',
    symbols: result.symbols,
    styleSources: result.imports,
    bindings: [],
    blocks: []
  };
}

/**
 * 解析一段样式区域。缩进语法 Sass 会先转成花括号语法，
 * 再通过位置映射把符号位置还原到原文。
 */
export function parseStyleRegion(
  source: string,
  syntax: StyleSyntax,
  start: number,
  end: number,
  lineMap?: LineMap
): { symbols: RawSymbol[]; imports: string[] } {
  const map = lineMap ?? new LineMap(source);
  if (syntax !== 'sass') {
    return parseStyle(source, syntax, { lineMap: map, start, end });
  }
  const region = source.slice(start, end);
  const converted = sassToBraces(region);
  // 转换发生在 region 内部，映射回原文时需要补上 region 的起始偏移
  const shifted = converted.map.map((v) => (v < 0 ? -1 : v + start));
  return parseStyle(converted.text, 'sass', {
    lineMap: new MappedPositionMapper(shifted, map)
  });
}

function analyzeVue(text: string): FileAnalysis {
  const lineMap = new LineMap(text);
  const blocks = parseSfcBlocks(text);
  const symbols: RawSymbol[] = [];
  const styleSources: string[] = [];
  const bindings: ImportBinding[] = [];

  for (const block of blocks) {
    if (block.tag === 'style') {
      const src = block.attrs.src;
      if (src) {
        styleSources.push(src);
      }
      if (block.contentEnd > block.contentStart) {
        const syntax = styleSyntaxFromLang(block.attrs.lang);
        const result = parseStyleRegion(
          text,
          syntax,
          block.contentStart,
          block.contentEnd,
          lineMap
        );
        symbols.push(...result.symbols);
        styleSources.push(...result.imports);
      }
      continue;
    }
    if (block.tag === 'script') {
      const src = block.attrs.src;
      if (src) {
        // `<script src>` 本身不是样式，但仍记录以便将来扩展
        continue;
      }
      const scriptText = text.slice(block.contentStart, block.contentEnd);
      const parsed = parseScriptImports(scriptText);
      for (const binding of parsed.bindings) {
        bindings.push({ ...binding, offset: binding.offset + block.contentStart });
      }
      styleSources.push(...parsed.sources.filter(isStyleSource));
    }
  }

  return { kind: 'vue', symbols, styleSources, bindings, blocks };
}

const LINK_RE = /<link\b[^>]*>/gi;
const HREF_RE = /href\s*=\s*("([^"]*)"|'([^']*)'|[^\s>]+)/i;

function analyzeHtml(text: string): FileAnalysis {
  const lineMap = new LineMap(text);
  const symbols: RawSymbol[] = [];
  const styleSources: string[] = [];
  const bindings: ImportBinding[] = [];

  LINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LINK_RE.exec(text)) !== null) {
    const tag = m[0];
    if (!/rel\s*=\s*["']?stylesheet/i.test(tag)) {
      continue;
    }
    const href = HREF_RE.exec(tag);
    const value = href ? (href[2] ?? href[3] ?? href[1]) : undefined;
    if (value) {
      styleSources.push(value);
    }
  }

  // 内联 <style> 与 <script> 块
  const blocks = parseSfcBlocks(text);
  for (const block of blocks) {
    if (block.tag === 'style' && block.contentEnd > block.contentStart) {
      const syntax = styleSyntaxFromLang(block.attrs.lang);
      const result = parseStyleRegion(text, syntax, block.contentStart, block.contentEnd, lineMap);
      symbols.push(...result.symbols);
      styleSources.push(...result.imports);
    } else if (block.tag === 'script' && block.contentEnd > block.contentStart) {
      const parsed = parseScriptImports(text.slice(block.contentStart, block.contentEnd));
      for (const binding of parsed.bindings) {
        bindings.push({ ...binding, offset: binding.offset + block.contentStart });
      }
      styleSources.push(...parsed.sources.filter(isStyleSource));
    }
  }

  return { kind: 'html', symbols, styleSources, bindings, blocks };
}

function analyzeScript(text: string): FileAnalysis {
  const parsed = parseScriptImports(text);
  return {
    kind: 'script',
    symbols: [],
    styleSources: parsed.sources.filter(isStyleSource),
    bindings: parsed.bindings,
    blocks: []
  };
}

/** 判断 Vue SFC 中某个偏移是否位于 style 块内，并返回该块的方言。 */
export function styleBlockAt(
  blocks: SfcBlock[],
  offset: number
): { block: SfcBlock; syntax: StyleSyntax } | undefined {
  const block = blockAt(blocks, offset);
  if (!block || block.tag !== 'style') {
    return undefined;
  }
  return { block, syntax: styleSyntaxFromLang(block.attrs.lang) };
}
