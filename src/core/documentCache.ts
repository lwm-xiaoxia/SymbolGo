import * as vscode from 'vscode';
import { analyzeSource } from './analyzer.js';
import type { FileAnalysis } from './analyzer.js';
import { STYLE_EXTS, extensionOf } from './languages.js';
import type { PathResolver } from './pathResolver.js';

interface CacheEntry {
  version: number;
  analysis: FileAnalysis;
  /** 已解析的关联样式文件（uri 字符串）；未计算时为 undefined */
  links?: string[];
}

/** 缓存的文档数量上限，超出后按插入顺序淘汰最早的条目。 */
const MAX_ENTRIES = 32;

/**
 * 当前文档的解析结果缓存。
 *
 * 跳转与悬停都需要“当前文件解析出的 import 绑定 / SFC 块 / 关联样式”，
 * 按 `uri + version` 缓存可以避免同一次交互里重复解析同一份文本。
 */
export class DocumentCache {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly pathResolver: PathResolver) {}

  /** 取得文档的解析结果。 */
  analyze(document: vscode.TextDocument): FileAnalysis {
    const key = document.uri.toString();
    const hit = this.cache.get(key);
    if (hit && hit.version === document.version) {
      return hit.analysis;
    }
    const analysis = analyzeSource(document.uri.path, document.getText());
    this.set(key, { version: document.version, analysis });
    return analysis;
  }

  /**
   * 取得文档直接关联的样式文件。
   *
   * 包含：`<style src>`、`@import` / `@use` / `@forward`、脚本中 import 的样式模块、
   * HTML 的 `<link rel="stylesheet">`。
   */
  async styleLinks(document: vscode.TextDocument): Promise<string[]> {
    const key = document.uri.toString();
    const analysis = this.analyze(document);
    const entry = this.cache.get(key);
    if (entry?.links) {
      return entry.links;
    }

    const exts = orderedStyleExts(document.uri.path);
    const links: string[] = [];
    for (const source of dedupe(analysis.styleSources)) {
      const resolved = await this.pathResolver.resolve(source, document.uri, exts);
      if (resolved) {
        links.push(resolved.toString());
      }
    }
    if (entry) {
      entry.links = links;
    }
    return links;
  }

  invalidate(): void {
    this.cache.clear();
  }

  private set(key: string, entry: CacheEntry): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }
    this.cache.set(key, entry);
    while (this.cache.size > MAX_ENTRIES) {
      const oldest = this.cache.keys().next();
      if (oldest.done) {
        break;
      }
      this.cache.delete(oldest.value);
    }
  }
}

/** 让引用方自身的样式方言排在候选扩展名的最前面，减少无谓的 stat。 */
export function orderedStyleExts(fsPath: string): string[] {
  const own = extensionOf(fsPath);
  if (STYLE_EXTS.includes(own)) {
    return [own, ...STYLE_EXTS.filter((e) => e !== own)];
  }
  return [...STYLE_EXTS];
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
