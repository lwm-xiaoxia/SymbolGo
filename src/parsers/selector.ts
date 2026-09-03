/**
 * 选择器处理：逗号拆分、`&` 父引用展开、class / id 名提取。
 *
 * 这里最关键的需求是 SCSS / Less 嵌套：
 *   .user-card { &__title { ... } }
 * 必须解析出完整名 `user-card__title`，同时不能把父级的 `user-card`
 * 重复登记到子块的位置上。做法是在展开 `&` 时保留一张
 * “结果字符 -> 原始 part 字符” 的映射表，只有命中原始 part 字符的
 * 名字才算这一层自己的定义。
 */

/** 选择器中提取到的名字。start/end 是相对于原始 part 文本的偏移。 */
export interface SelectorName {
  kind: 'class' | 'id';
  name: string;
  start: number;
  end: number;
}

/** 逗号拆分出的单个选择器片段。 */
export interface SelectorPart {
  text: string;
  /** 相对于传入字符串的起始偏移 */
  offset: number;
}

const NAME_RE =
  /([.#])((?:\\.|[-_a-zA-Z\u00A0-\uFFFF])(?:\\.|[-_a-zA-Z0-9\u00A0-\uFFFF])*)/g;

/**
 * 把字符串字面量内容替换成等长空格，避免 `[data-x=".foo"]` 之类被误认成选择器。
 * 长度保持不变，因此偏移量仍然可用。
 */
export function maskStrings(text: string): string {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') {
        out += '  ';
        i++;
        continue;
      }
      if (ch === quote) {
        quote = null;
        out += ch;
      } else {
        out += ' ';
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      continue;
    }
    out += ch;
  }
  return out;
}

/** 按顶层逗号拆分选择器列表，忽略括号、方括号与字符串内部的逗号。 */
export function splitSelectorList(text: string): SelectorPart[] {
  const parts: SelectorPart[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') {
        i++;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '(' || ch === '[') {
      depth++;
    } else if (ch === ')' || ch === ']') {
      depth = Math.max(0, depth - 1);
    } else if (ch === ',' && depth === 0) {
      parts.push(makePart(text, start, i));
      start = i + 1;
    }
  }
  parts.push(makePart(text, start, text.length));
  return parts.filter((p) => p.text.length > 0);
}

function makePart(text: string, start: number, end: number): SelectorPart {
  const raw = text.slice(start, end);
  const leading = raw.length - raw.trimStart().length;
  return { text: raw.trim(), offset: start + leading };
}

interface Substitution {
  text: string;
  /** text[i] 对应的原始 part 偏移；-1 表示来自父选择器 */
  map: number[];
}

/** 把 part 中的 `&` 替换为 parent，并记录每个字符的来源。 */
export function substituteAmpersand(part: string, parent: string): Substitution {
  let text = '';
  const map: number[] = [];
  let quote: string | null = null;
  for (let i = 0; i < part.length; i++) {
    const ch = part[i];
    if (!quote && ch === '&') {
      for (let k = 0; k < parent.length; k++) {
        text += parent[k];
        map.push(-1);
      }
      continue;
    }
    if (quote) {
      if (ch === '\\') {
        text += ch;
        map.push(i);
        i++;
        if (i < part.length) {
          text += part[i];
          map.push(i);
        }
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    }
    text += ch;
    map.push(i);
  }
  return { text, map };
}

/** 计算某个 part 在给定父选择器下展开后的完整选择器文本。 */
export function resolveSelector(part: string, parent: string): string {
  if (!parent) {
    return part.includes('&') ? part.replace(/&/g, '').trim() : part;
  }
  if (part.includes('&')) {
    return substituteAmpersand(part, parent).text;
  }
  return `${parent} ${part}`;
}

/** 计算一层选择器在所有父选择器下展开后的完整选择器列表。 */
export function resolveSelectors(parts: SelectorPart[], parents: string[]): string[] {
  const bases = parents.length > 0 ? parents : [''];
  const result: string[] = [];
  for (const part of parts) {
    for (const parent of bases) {
      const resolved = resolveSelector(part.text, parent).trim();
      if (resolved) {
        result.push(resolved);
      }
    }
  }
  return result;
}

/**
 * 提取“属于当前这一层”的 class / id 名。
 *
 * - 无 `&`：直接从 part 提取，父选择器里的名字不会被重复登记。
 * - 有 `&`：先展开再提取，只保留至少包含一个原始 part 字符的名字，
 *   于是 `&__title` 在父级 `.user-card` 下得到 `user-card__title`，
 *   而 `& .child` 只得到 `child`。
 */
export function extractOwnNames(part: string, parents: string[]): SelectorName[] {
  if (!part.includes('&')) {
    return extractNames(part);
  }
  const bases = parents.length > 0 ? parents : [''];
  const seen = new Set<string>();
  const result: SelectorName[] = [];
  for (const parent of bases) {
    const { text, map } = substituteAmpersand(part, parent);
    for (const raw of extractNames(text)) {
      let min = Number.POSITIVE_INFINITY;
      let max = -1;
      for (let i = raw.start; i < raw.end; i++) {
        const src = map[i];
        if (src !== undefined && src >= 0) {
          min = Math.min(min, src);
          max = Math.max(max, src);
        }
      }
      // 整段都来自父选择器，说明不是这一层的定义
      if (max < 0) {
        continue;
      }
      const key = `${raw.kind}:${raw.name}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      result.push({ kind: raw.kind, name: raw.name, start: min, end: max + 1 });
    }
  }
  return result;
}

/** 从一段选择器文本中提取所有 class / id 名（含偏移）。 */
export function extractNames(text: string): SelectorName[] {
  const masked = maskStrings(text);
  const result: SelectorName[] = [];
  NAME_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = NAME_RE.exec(masked)) !== null) {
    const [full, prefix, rawName] = match;
    const start = match.index;
    result.push({
      kind: prefix === '.' ? 'class' : 'id',
      name: unescapeName(rawName),
      start: start + 1,
      end: start + full.length
    });
  }
  return result;
}

/** 还原 CSS 转义，例如 `w-1\/2` -> `w-1/2`。 */
export function unescapeName(name: string): string {
  return name.replace(/\\(.)/g, '$1');
}
