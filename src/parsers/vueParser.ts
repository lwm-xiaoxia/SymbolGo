import type { StyleSyntax } from '../core/types.js';

export interface SfcBlock {
  tag: 'template' | 'script' | 'style';
  attrs: Record<string, string>;
  /** `<tag ...>` 中 `<` 的偏移 */
  tagStart: number;
  /** 块内容起始偏移 */
  contentStart: number;
  /** 块内容结束偏移（不含 `</tag>`） */
  contentEnd: number;
}

const BLOCK_TAG_RE = /^<(template|script|style)(\s[^>]*|\s*\/?)>/i;

/**
 * 拆分 Vue SFC 的顶层块。
 *
 * 只识别顶层的 template / script / style；进入某个块后会直接跳到它的结束标签，
 * 因此模板内部嵌套的 `<template>` 不会被误当成顶层块。
 */
export function parseSfcBlocks(source: string): SfcBlock[] {
  const blocks: SfcBlock[] = [];
  // 标签匹配需要忽略大小写，整份文本只转换一次，避免在循环里反复 toLowerCase
  const lower = source.toLowerCase();
  let i = 0;
  while (i < source.length) {
    const lt = source.indexOf('<', i);
    if (lt === -1) {
      break;
    }
    const match = BLOCK_TAG_RE.exec(source.slice(lt, lt + 1000));
    if (!match) {
      i = lt + 1;
      continue;
    }
    const tag = match[1].toLowerCase() as SfcBlock['tag'];
    const attrsText = match[2] ?? '';
    const contentStart = lt + match[0].length;
    // 自闭合块（如 `<style src="./a.css" />`）没有内容
    if (attrsText.trimEnd().endsWith('/')) {
      blocks.push({
        tag,
        attrs: parseAttrs(attrsText),
        tagStart: lt,
        contentStart,
        contentEnd: contentStart
      });
      i = contentStart;
      continue;
    }
    const contentEnd = findBlockEnd(lower, tag, contentStart);
    blocks.push({ tag, attrs: parseAttrs(attrsText), tagStart: lt, contentStart, contentEnd });
    i = contentEnd + `</${tag}>`.length;
  }
  return blocks;
}

/** 在已小写化的文本中找到块的结束位置（`</tag` 的偏移）。 */
function findBlockEnd(lower: string, tag: string, from: number): number {
  const close = `</${tag}`;
  const open = `<${tag}`;
  let depth = 0;
  let i = from;
  while (i < lower.length) {
    const nextClose = lower.indexOf(close, i);
    if (nextClose === -1) {
      return lower.length;
    }
    // template 允许嵌套，需要配对计数；script / style 不会嵌套
    if (tag === 'template') {
      let nextOpen = lower.indexOf(open, i);
      while (nextOpen !== -1 && nextOpen < nextClose) {
        const after = lower[nextOpen + open.length];
        if (after === undefined || /[\s>/]/.test(after)) {
          depth++;
        }
        nextOpen = lower.indexOf(open, nextOpen + open.length);
      }
    }
    if (depth === 0) {
      return nextClose;
    }
    depth--;
    i = nextClose + close.length;
  }
  return lower.length;
}

/** 解析开始标签中的属性文本，布尔属性的值记为空串。 */
export function parseAttrs(text: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([^\s=/>]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|[^\s>]+))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const name = m[1].toLowerCase();
    if (!name || name === '/') {
      continue;
    }
    const value = m[3] ?? m[4] ?? (m[2] ? m[2] : '');
    attrs[name] = value;
  }
  return attrs;
}

/** 根据 `<style lang="...">` 推断样式方言。 */
export function styleSyntaxFromLang(lang: string | undefined): StyleSyntax {
  switch ((lang ?? '').toLowerCase()) {
    case 'scss':
      return 'scss';
    case 'sass':
      return 'sass';
    case 'less':
      return 'less';
    default:
      return 'css';
  }
}

/** 找到包含指定偏移的块。 */
export function blockAt(blocks: SfcBlock[], offset: number): SfcBlock | undefined {
  return blocks.find((b) => offset >= b.contentStart && offset <= b.contentEnd);
}
