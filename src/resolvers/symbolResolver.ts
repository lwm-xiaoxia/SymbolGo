import * as vscode from 'vscode';
import { styleBlockAt } from '../core/analyzer.js';
import type { SymbolGoConfig } from '../core/config.js';
import { DocumentCache, orderedStyleExts } from '../core/documentCache.js';
import {
  COMPONENT_EXTS,
  dirNameOf,
  docKindOfPath,
  isStyleSource,
  looksLikeComponent,
  normalizeComponentName,
  styleSyntaxOfPath
} from '../core/languages.js';
import type { Logger } from '../core/logger.js';
import type { PathResolver } from '../core/pathResolver.js';
import type { SymbolIndex } from '../core/symbolIndex.js';
import { SymbolKind } from '../core/types.js';
import type { PlainRange, StyleSyntax, SymbolEntry } from '../core/types.js';
import { resolveMarkupCursor, resolveTagCursor } from '../parsers/markupContext.js';
import { resolveStyleCursor } from '../parsers/styleContext.js';

export interface DefinitionTarget {
  uri: vscode.Uri;
  /** 精确指向名字的范围 */
  range: vscode.Range;
  /** 整条定义的范围，跳转后可高亮更完整的上下文 */
  fullRange: vscode.Range;
  detail?: string;
}

export interface ResolveResult {
  /** 光标处被识别为符号的范围 */
  origin: vscode.Range;
  targets: DefinitionTarget[];
  /** 用于 Hover 展示的符号描述，例如 `class .user-card` */
  label: string;
}

/**
 * 跳转解析核心：把“光标位置”翻译成“定义位置列表”。
 *
 * DefinitionProvider 与 HoverProvider 共用同一份逻辑，
 * 保证悬停看到的来源与实际跳转结果一致。
 */
export class SymbolResolver {
  constructor(
    private readonly index: SymbolIndex,
    private readonly docs: DocumentCache,
    private readonly paths: PathResolver,
    private readonly logger: Logger,
    private readonly getConfig: () => SymbolGoConfig
  ) {}

  async resolve(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<ResolveResult | undefined> {
    const config = this.getConfig();
    if (!config.enabled) {
      return undefined;
    }
    const kind = docKindOfPath(document.uri.path);
    if (!kind) {
      return undefined;
    }

    const text = document.getText();
    const offset = document.offsetAt(position);

    const styleRegion = this.styleRegionAt(document, offset, kind);
    if (styleRegion) {
      return this.resolveInStyle(document, text, offset, styleRegion.syntax, styleRegion.start);
    }
    return this.resolveInMarkup(document, text, offset, config);
  }

  /** 判断光标是否处于样式代码中（独立样式文件，或 SFC / HTML 的 style 块）。 */
  private styleRegionAt(
    document: vscode.TextDocument,
    offset: number,
    kind: ReturnType<typeof docKindOfPath>
  ): { syntax: StyleSyntax; start: number } | undefined {
    if (kind === 'style') {
      return { syntax: styleSyntaxOfPath(document.uri.path) ?? 'css', start: 0 };
    }
    if (kind === 'vue' || kind === 'html') {
      const found = styleBlockAt(this.docs.analyze(document).blocks, offset);
      return found ? { syntax: found.syntax, start: found.block.contentStart } : undefined;
    }
    return undefined;
  }

  private async resolveInStyle(
    document: vscode.TextDocument,
    text: string,
    offset: number,
    syntax: StyleSyntax,
    regionStart: number
  ): Promise<ResolveResult | undefined> {
    const cursor = resolveStyleCursor(text, offset, syntax, regionStart);
    if (!cursor) {
      return undefined;
    }
    const origin = toRange(document, cursor.start, cursor.end);

    // @import / @use / @forward 的路径跳转
    if (cursor.importPath !== undefined) {
      const target = await this.paths.resolve(
        cursor.importPath,
        document.uri,
        orderedStyleExts(document.uri.path)
      );
      if (!target) {
        return undefined;
      }
      const zero = new vscode.Range(0, 0, 0, 0);
      return {
        origin,
        label: `样式文件 ${cursor.importPath}`,
        targets: [{ uri: target, range: zero, fullRange: zero }]
      };
    }

    if (cursor.kinds.length === 0) {
      return undefined;
    }
    const entries = this.index.lookupAny(cursor.kinds, cursor.name);
    if (entries.length === 0) {
      return undefined;
    }
    const ranked = await this.rankEntries(document, entries);
    return {
      origin,
      label: describe(ranked[0]?.kind ?? cursor.kinds[0], cursor.name),
      targets: ranked.map((e) => toTarget(e))
    };
  }

  private async resolveInMarkup(
    document: vscode.TextDocument,
    text: string,
    offset: number,
    config: SymbolGoConfig
  ): Promise<ResolveResult | undefined> {
    const cursor = resolveMarkupCursor(text, offset);
    if (!cursor) {
      return undefined;
    }
    const origin = toRange(document, cursor.start, cursor.end);

    if (cursor.kind === 'component') {
      return this.resolveComponent(document, cursor.name, origin, config);
    }

    if (cursor.kind === 'member') {
      const member = config.styleEnabled
        ? await this.resolveCssModuleMember(document, cursor.object ?? '', cursor.name, origin)
        : undefined;
      if (member) {
        return member;
      }
      // `<Foo.Bar />` 这类命名空间标签同样是成员访问的形状，回落到标签解析
      const tagCursor = resolveTagCursor(text, offset);
      if (tagCursor?.kind === 'component') {
        return this.resolveComponent(
          document,
          tagCursor.name,
          toRange(document, tagCursor.start, tagCursor.end),
          config
        );
      }
      return undefined;
    }

    if (!config.styleEnabled) {
      return undefined;
    }
    const kinds = cursor.kind === 'class' ? [SymbolKind.CssClass] : [SymbolKind.CssId];
    const entries = this.index.lookupAny(kinds, cursor.name);
    if (entries.length === 0) {
      return undefined;
    }
    const ranked = await this.rankEntries(document, entries);
    if (ranked.length === 0) {
      return undefined;
    }
    return {
      origin,
      label: describe(kinds[0], cursor.name),
      targets: ranked.map((e) => toTarget(e))
    };
  }

  /** `styles.foo` / `$style.foo`：把查找范围限定在对应的样式模块内。 */
  private async resolveCssModuleMember(
    document: vscode.TextDocument,
    object: string,
    name: string,
    origin: vscode.Range
  ): Promise<ResolveResult | undefined> {
    if (!object) {
      return undefined;
    }
    const analysis = this.docs.analyze(document);
    let scope: string[] | undefined;

    if (object.startsWith('$') && analysis.kind === 'vue') {
      // Vue 的 `<style module>` 默认注入为 `$style`，定义就在当前 SFC 内
      scope = [document.uri.toString()];
    } else {
      const binding = analysis.bindings.find((b) => b.local === object);
      if (!binding || !isStyleSource(binding.source)) {
        return undefined;
      }
      const resolved = await this.paths.resolve(
        binding.source,
        document.uri,
        orderedStyleExts(binding.source)
      );
      if (!resolved) {
        return undefined;
      }
      scope = [resolved.toString()];
    }

    const entries = this.index
      .lookupAny([SymbolKind.CssClass, SymbolKind.CssId], name)
      .filter((e) => scope.includes(e.uri));
    if (entries.length === 0) {
      return undefined;
    }
    return {
      origin,
      label: describe(entries[0].kind, name),
      targets: entries.map((e) => toTarget(e))
    };
  }

  private async resolveComponent(
    document: vscode.TextDocument,
    tagName: string,
    origin: vscode.Range,
    config: SymbolGoConfig
  ): Promise<ResolveResult | undefined> {
    if (config.componentMode === 'off' || !looksLikeComponent(tagName)) {
      return undefined;
    }
    const local = tagName.split('.')[0];
    const analysis = this.docs.analyze(document);
    const normalized = normalizeComponentName(local);
    const binding = analysis.bindings.find(
      (b) => b.local === local || normalizeComponentName(b.local) === normalized
    );

    if (binding) {
      // auto 模式下，已 import 的组件由内置 JS/TS 跳转处理，不重复提供结果
      if (config.componentMode === 'auto') {
        return undefined;
      }
      const resolved = await this.paths.resolve(binding.source, document.uri, COMPONENT_EXTS);
      if (!resolved) {
        return undefined;
      }
      const zero = new vscode.Range(0, 0, 0, 0);
      return {
        origin,
        label: `组件 <${tagName}>`,
        targets: [{ uri: resolved, range: zero, fullRange: zero }]
      };
    }

    const candidates = this.index.findComponents(local);
    if (candidates.length === 0) {
      return undefined;
    }
    const zero = new vscode.Range(0, 0, 0, 0);
    return {
      origin,
      label: `组件 <${tagName}>`,
      targets: candidates.map((uri) => ({
        uri: vscode.Uri.parse(uri),
        range: zero,
        fullRange: zero
      }))
    };
  }

  /**
   * 结果排序与范围裁剪。
   *
   * 优先级：当前文件 > 当前文件直接关联的样式文件 > 同目录 > 其余。
   * `related` 范围下只保留前两类；`smart` 在前两类为空时回退到全部。
   */
  private async rankEntries(
    document: vscode.TextDocument,
    entries: SymbolEntry[]
  ): Promise<SymbolEntry[]> {
    const config = this.getConfig();
    const self = document.uri.toString();
    const links = new Set(await this.docs.styleLinks(document));
    const dir = dirNameOf(document.uri.path);

    const score = (entry: SymbolEntry): number => {
      if (entry.uri === self) {
        return 0;
      }
      if (links.has(entry.uri)) {
        return 1;
      }
      return dirNameOf(vscode.Uri.parse(entry.uri).path) === dir ? 2 : 3;
    };

    const scored = entries
      .map((entry) => ({ entry, score: score(entry) }))
      .sort((a, b) => a.score - b.score || a.entry.uri.localeCompare(b.entry.uri));

    if (config.styleScope === 'workspace') {
      return scored.map((s) => s.entry);
    }
    const related = scored.filter((s) => s.score <= 1).map((s) => s.entry);
    if (related.length > 0) {
      return related;
    }
    if (config.styleScope === 'related') {
      this.logger.trace('style.scope 为 related，且未在关联样式中找到定义');
      return [];
    }
    return scored.map((s) => s.entry);
  }
}

function toRange(document: vscode.TextDocument, start: number, end: number): vscode.Range {
  return new vscode.Range(document.positionAt(start), document.positionAt(end));
}

function toVsRange(range: PlainRange): vscode.Range {
  return new vscode.Range(
    range.start.line,
    range.start.character,
    range.end.line,
    range.end.character
  );
}

function toTarget(entry: SymbolEntry): DefinitionTarget {
  const range = toVsRange(entry.range);
  return {
    uri: vscode.Uri.parse(entry.uri),
    range,
    fullRange: entry.fullRange ? toVsRange(entry.fullRange) : range,
    detail: entry.detail
  };
}

const KIND_LABEL: Record<string, string> = {
  [SymbolKind.CssClass]: 'class',
  [SymbolKind.CssId]: 'id',
  [SymbolKind.CssVariable]: 'CSS 变量',
  [SymbolKind.Keyframes]: 'keyframes',
  [SymbolKind.CssFunction]: 'CSS function',
  [SymbolKind.ScssVariable]: 'SCSS 变量',
  [SymbolKind.ScssMixin]: 'mixin',
  [SymbolKind.ScssFunction]: 'function',
  [SymbolKind.ScssPlaceholder]: 'placeholder',
  [SymbolKind.LessVariable]: 'Less 变量',
  [SymbolKind.LessMixin]: 'Less mixin',
  [SymbolKind.Component]: '组件'
};

const KIND_PREFIX: Record<string, string> = {
  [SymbolKind.CssClass]: '.',
  [SymbolKind.CssId]: '#',
  [SymbolKind.ScssVariable]: '$',
  [SymbolKind.ScssPlaceholder]: '%',
  [SymbolKind.LessVariable]: '@'
};

/** 生成 Hover 中展示的符号描述。 */
export function describe(kind: SymbolKind, name: string): string {
  const label = KIND_LABEL[kind] ?? '符号';
  const prefix = KIND_PREFIX[kind] ?? '';
  return `${label} \`${prefix}${name}\``;
}
