/**
 * 标记语言（Vue template / HTML / JSX）中的“光标语义识别”。
 *
 * 只做纯文本分析，不依赖 vscode，也不构建完整 AST：
 * 从光标处向外找到最近的开始标签，再定位光标落在标签名还是某个属性值里，
 * 最后从属性值中切出光标所指的那一个 class / id。
 */

export type MarkupCursorKind = 'class' | 'id' | 'component' | 'member';

export interface MarkupCursor {
  kind: MarkupCursorKind;
  /** 归一化后的名字（class 名、id 名、组件名、成员名） */
  name: string;
  start: number;
  end: number;
  /** kind 为 member 时的对象名，例如 `styles`、`$style` */
  object?: string;
}

const IDENT_RE = /[A-Za-z0-9_$]/;
const CLASS_CHAR_RE = /[A-Za-z0-9_$\u00A0-\uFFFF-]/;
/** 向前查找开始标签的最大回溯距离，避免超长文件里退化成全文扫描 */
const TAG_LOOKBEHIND = 8000;

export interface TagInfo {
  name: string;
  nameStart: number;
  nameEnd: number;
  /** `>` 或 `/>` 中 `>` 的偏移 */
  tagEnd: number;
  attrs: AttrInfo[];
  closing: boolean;
}

export interface AttrInfo {
  name: string;
  nameStart: number;
  /** 属性值内容起始（不含引号 / 花括号） */
  valueStart: number;
  valueEnd: number;
  /** 值的包裹形式 */
  wrapper: 'double' | 'single' | 'backtick' | 'brace' | 'none';
}

/**
 * 识别光标处的可跳转目标；识别不到返回 null。
 *
 * 成员访问优先（`styles.foo`），但 `<Foo.Bar />` 这类命名空间标签同样满足成员访问的形状，
 * 因此调用方在成员访问无结果时应回落到 {@link resolveTagCursor}。
 */
export function resolveMarkupCursor(source: string, offset: number): MarkupCursor | null {
  return matchMemberAccess(source, offset) ?? resolveTagCursor(source, offset);
}

/** 只识别标签名与 class / id 属性值，不考虑成员访问。 */
export function resolveTagCursor(source: string, offset: number): MarkupCursor | null {
  const tag = findEnclosingTag(source, offset);
  if (!tag) {
    return null;
  }

  if (offset >= tag.nameStart && offset <= tag.nameEnd) {
    return {
      kind: 'component',
      name: source.slice(tag.nameStart, tag.nameEnd),
      start: tag.nameStart,
      end: tag.nameEnd
    };
  }

  const attr = tag.attrs.find((a) => offset >= a.valueStart && offset <= a.valueEnd);
  if (!attr) {
    return null;
  }

  const base = normalizeAttrName(attr.name);
  if (base !== 'class' && base !== 'id') {
    return null;
  }

  const dynamic = isDynamicAttr(attr);
  const token = dynamic
    ? pickTokenFromExpression(source, attr, offset)
    : pickTokenFromList(source, attr.valueStart, attr.valueEnd, offset);
  if (!token) {
    return null;
  }
  return { kind: base, name: token.text, start: token.start, end: token.end };
}

/** 去掉 `:` / `v-bind:` 前缀并小写，把 className 归一到 class。 */
export function normalizeAttrName(name: string): string {
  let n = name.toLowerCase();
  if (n.startsWith('v-bind:')) {
    n = n.slice(7);
  } else if (n.startsWith(':')) {
    n = n.slice(1);
  }
  if (n === 'classname') {
    return 'class';
  }
  return n;
}

function isDynamicAttr(attr: AttrInfo): boolean {
  if (attr.wrapper === 'brace' || attr.wrapper === 'backtick') {
    return true;
  }
  const n = attr.name.toLowerCase();
  return n.startsWith(':') || n.startsWith('v-bind:');
}

/** 从静态属性值（空白分隔）中取出光标所在的那一个 token。 */
function pickTokenFromList(
  source: string,
  start: number,
  end: number,
  offset: number
): { text: string; start: number; end: number } | null {
  if (offset < start || offset > end) {
    return null;
  }
  let s = offset;
  while (s > start && !/\s/.test(source[s - 1])) {
    s--;
  }
  let e = offset;
  while (e < end && !/\s/.test(source[e])) {
    e++;
  }
  const text = source.slice(s, e);
  if (!text || !/^[A-Za-z0-9_$\u00A0-\uFFFF-]+$/.test(text)) {
    return null;
  }
  return { text, start: s, end: e };
}

/**
 * 从动态表达式（`:class="..."`、`className={...}`）中取出光标所指的类名。
 *
 * 支持两种位置：字符串字面量内部（`'a b'`、模板字符串），
 * 以及对象字面量的键（`{ active: isOn }` 里的 `active`）。
 */
function pickTokenFromExpression(
  source: string,
  attr: AttrInfo,
  offset: number
): { text: string; start: number; end: number } | null {
  const str = findEnclosingStringLiteral(source, attr.valueStart, attr.valueEnd, offset);
  if (str) {
    return pickTokenFromList(source, str.start, str.end, offset);
  }
  // 对象字面量的裸键：仅当其后紧跟冒号时才认为是类名，避免把变量名也当作类名
  let s = offset;
  while (s > attr.valueStart && CLASS_CHAR_RE.test(source[s - 1])) {
    s--;
  }
  let e = offset;
  while (e < attr.valueEnd && CLASS_CHAR_RE.test(source[e])) {
    e++;
  }
  if (e <= s) {
    return null;
  }
  let after = e;
  while (after < attr.valueEnd && /\s/.test(source[after])) {
    after++;
  }
  if (source[after] !== ':') {
    return null;
  }
  return { text: source.slice(s, e), start: s, end: e };
}

/** 在给定范围内找到包含 offset 的字符串字面量内容范围（不含引号）。 */
function findEnclosingStringLiteral(
  source: string,
  start: number,
  end: number,
  offset: number
): { start: number; end: number } | null {
  let i = start;
  while (i < end) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const contentStart = i + 1;
      let j = contentStart;
      while (j < end) {
        if (source[j] === '\\') {
          j += 2;
          continue;
        }
        if (source[j] === ch) {
          break;
        }
        j++;
      }
      if (offset > i && offset <= j) {
        return { start: contentStart, end: Math.min(j, end) };
      }
      i = j + 1;
      continue;
    }
    i++;
  }
  return null;
}

/**
 * 从 offset 向前找到最近的开始标签，并确认 offset 确实落在该标签内部。
 * 若最近的标签已经在 offset 之前闭合，说明光标在文本内容里，返回 null。
 */
export function findEnclosingTag(source: string, offset: number): TagInfo | null {
  const limit = Math.max(0, offset - TAG_LOOKBEHIND);
  for (let i = Math.min(offset, source.length - 1); i >= limit; i--) {
    if (source[i] !== '<') {
      continue;
    }
    const next = source[i + 1];
    if (!next || !/[A-Za-z_$/]/.test(next)) {
      continue;
    }
    const tag = scanTag(source, i);
    if (!tag) {
      return null;
    }
    return offset <= tag.tagEnd ? tag : null;
  }
  return null;
}

/** 从 `<` 开始扫描一个开始/结束标签，解析出标签名与属性表。 */
export function scanTag(source: string, ltIndex: number): TagInfo | null {
  let i = ltIndex + 1;
  const closing = source[i] === '/';
  if (closing) {
    i++;
  }
  const nameStart = i;
  while (i < source.length && /[A-Za-z0-9_$.:-]/.test(source[i])) {
    i++;
  }
  const nameEnd = i;
  if (nameEnd === nameStart) {
    return null;
  }

  const attrs: AttrInfo[] = [];
  while (i < source.length) {
    while (i < source.length && /\s/.test(source[i])) {
      i++;
    }
    const ch = source[i];
    if (ch === undefined) {
      return null;
    }
    if (ch === '>') {
      return {
        name: source.slice(nameStart, nameEnd),
        nameStart,
        nameEnd,
        tagEnd: i,
        attrs,
        closing
      };
    }
    if (ch === '/' && source[i + 1] === '>') {
      return {
        name: source.slice(nameStart, nameEnd),
        nameStart,
        nameEnd,
        tagEnd: i + 1,
        attrs,
        closing
      };
    }

    const attrNameStart = i;
    while (i < source.length && !/[\s=/>]/.test(source[i])) {
      i++;
    }
    if (i === attrNameStart) {
      // 遇到无法解析的字符，跳过一位继续，保证不会死循环
      i++;
      continue;
    }
    const attrName = source.slice(attrNameStart, i);
    while (i < source.length && /\s/.test(source[i])) {
      i++;
    }
    if (source[i] !== '=') {
      attrs.push({
        name: attrName,
        nameStart: attrNameStart,
        valueStart: i,
        valueEnd: i,
        wrapper: 'none'
      });
      continue;
    }
    i++;
    while (i < source.length && /\s/.test(source[i])) {
      i++;
    }
    const value = scanAttrValue(source, i);
    if (!value) {
      return null;
    }
    attrs.push({
      name: attrName,
      nameStart: attrNameStart,
      valueStart: value.start,
      valueEnd: value.end,
      wrapper: value.wrapper
    });
    i = value.next;
  }
  return null;
}

function scanAttrValue(
  source: string,
  i: number
): { start: number; end: number; next: number; wrapper: AttrInfo['wrapper'] } | null {
  const ch = source[i];
  if (ch === '"' || ch === "'" || ch === '`') {
    const end = source.indexOf(ch, i + 1);
    if (end === -1) {
      return null;
    }
    const wrapper = ch === '"' ? 'double' : ch === "'" ? 'single' : 'backtick';
    return { start: i + 1, end, next: end + 1, wrapper };
  }
  if (ch === '{') {
    const end = findMatchingBrace(source, i);
    if (end === -1) {
      return null;
    }
    return { start: i + 1, end, next: end + 1, wrapper: 'brace' };
  }
  let j = i;
  while (j < source.length && !/[\s>]/.test(source[j])) {
    j++;
  }
  return { start: i, end: j, next: j, wrapper: 'none' };
}

/** 找到与 `{` 配对的 `}`，跳过字符串与嵌套花括号。 */
export function findMatchingBrace(source: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < source.length; i++) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const end = source.indexOf(ch, i + 1);
      if (end === -1) {
        return -1;
      }
      i = end;
      continue;
    }
    if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

/**
 * 识别 `styles.foo` / `styles['foo']` / `$style.foo` 形式的成员访问。
 * 对象是否真的指向样式文件由调用方结合 import 语句判断。
 */
export function matchMemberAccess(source: string, offset: number): MarkupCursor | null {
  // 形式一：obj.name
  const word = wordAt(source, offset, IDENT_RE);
  if (word) {
    let i = word.start - 1;
    while (i >= 0 && /\s/.test(source[i])) {
      i--;
    }
    if (source[i] === '.') {
      i--;
      while (i >= 0 && /\s/.test(source[i])) {
        i--;
      }
      const obj = wordAt(source, i, IDENT_RE);
      if (obj && obj.end === i + 1) {
        return {
          kind: 'member',
          name: word.text,
          object: obj.text,
          start: word.start,
          end: word.end
        };
      }
    }
  }

  // 形式二：obj['name']
  const quote = findQuotedAround(source, offset);
  if (quote) {
    let i = quote.quoteStart - 1;
    while (i >= 0 && /\s/.test(source[i])) {
      i--;
    }
    if (source[i] === '[') {
      i--;
      while (i >= 0 && /\s/.test(source[i])) {
        i--;
      }
      const obj = wordAt(source, i, IDENT_RE);
      if (obj && obj.end === i + 1) {
        return {
          kind: 'member',
          name: source.slice(quote.start, quote.end),
          object: obj.text,
          start: quote.start,
          end: quote.end
        };
      }
    }
  }

  return null;
}

/** 取出 offset 处由 charRe 定义的单词。 */
export function wordAt(
  source: string,
  offset: number,
  charRe: RegExp
): { text: string; start: number; end: number } | null {
  if (offset < 0 || offset > source.length) {
    return null;
  }
  let s = offset;
  while (s > 0 && charRe.test(source[s - 1])) {
    s--;
  }
  let e = offset;
  while (e < source.length && charRe.test(source[e])) {
    e++;
  }
  if (e <= s) {
    return null;
  }
  return { text: source.slice(s, e), start: s, end: e };
}

/** 找到包含 offset 的引号字符串（在同一行内查找，避免误判）。 */
function findQuotedAround(
  source: string,
  offset: number
): { start: number; end: number; quoteStart: number } | null {
  const lineStart = source.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
  let lineEnd = source.indexOf('\n', offset);
  if (lineEnd === -1) {
    lineEnd = source.length;
  }
  let i = lineStart;
  while (i < lineEnd) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < lineEnd && source[j] !== ch) {
        if (source[j] === '\\') {
          j++;
        }
        j++;
      }
      if (offset > i && offset <= j) {
        return { start: i + 1, end: Math.min(j, lineEnd), quoteStart: i };
      }
      i = j + 1;
      continue;
    }
    i++;
  }
  return null;
}
