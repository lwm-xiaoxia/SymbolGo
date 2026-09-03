import * as vscode from 'vscode';
import type { Logger } from './logger.js';
import type { SymbolGoConfig } from './config.js';
import { extensionOf } from './languages.js';

interface AliasEntry {
  /** 别名前缀，例如 `@/` */
  prefix: string;
  /** 目标目录的绝对路径前缀，可能有多个候选 */
  targets: string[];
}

/** 单次解析最多尝试的候选路径数，避免路径拼装爆炸。 */
const MAX_CANDIDATES = 48;

/**
 * 模块路径解析：把 import / @import 里的路径解析成真实文件。
 *
 * 支持相对路径、workspace 根路径、tsconfig/jsconfig 的 paths 别名、
 * 用户自定义别名、webpack 风格的 `~` 前缀，以及 Sass 的 `_partial` 与 `index` 约定。
 * 文件存在性用带缓存的 stat 判断，缓存在文件系统事件时失效。
 */
export class PathResolver {
  private readonly existsCache = new Map<string, boolean>();
  private aliases: AliasEntry[] = [];

  constructor(private readonly logger: Logger) {}

  /** 重新加载别名表。工作区变化或配置变化时调用。 */
  async reloadAliases(config: SymbolGoConfig): Promise<void> {
    const entries: AliasEntry[] = [];
    const folders = vscode.workspace.workspaceFolders ?? [];

    for (const folder of folders) {
      for (const fileName of ['tsconfig.json', 'jsconfig.json']) {
        const parsed = await this.readJsonc(vscode.Uri.joinPath(folder.uri, fileName));
        if (!parsed) {
          continue;
        }
        const options = (parsed.compilerOptions ?? {}) as Record<string, unknown>;
        const baseUrl = typeof options.baseUrl === 'string' ? options.baseUrl : '.';
        const baseUri = vscode.Uri.joinPath(folder.uri, baseUrl);
        const paths = (options.paths ?? {}) as Record<string, string[]>;
        for (const [pattern, targets] of Object.entries(paths)) {
          if (!Array.isArray(targets)) {
            continue;
          }
          entries.push({
            prefix: pattern.replace(/\*$/, ''),
            targets: targets.map((t) =>
              vscode.Uri.joinPath(baseUri, t.replace(/\*$/, '')).toString()
            )
          });
        }
      }

      // 用户自定义别名优先级最高
      for (const [prefix, target] of Object.entries(config.alias)) {
        entries.unshift({
          prefix: prefix.endsWith('/') ? prefix : `${prefix}/`,
          targets: [vscode.Uri.joinPath(folder.uri, target).toString()]
        });
      }

      // 未显式配置时，为常见的 `@/` 提供一个基于 src 目录的兜底
      if (!entries.some((e) => e.prefix === '@/')) {
        const src = vscode.Uri.joinPath(folder.uri, 'src');
        if (await this.exists(src)) {
          entries.push({ prefix: '@/', targets: [src.toString()] });
        }
      }
    }

    // 长前缀优先，避免 `@/` 抢走 `@components/` 的匹配
    entries.sort((a, b) => b.prefix.length - a.prefix.length);
    this.aliases = entries;
    this.logger.trace(`别名表已加载：${entries.map((e) => e.prefix).join(', ') || '(空)'}`);
  }

  /** 文件系统发生变化时清空存在性缓存。 */
  invalidate(): void {
    this.existsCache.clear();
  }

  /**
   * 解析一个模块路径。
   * @param spec 原始路径，例如 `./a.scss`、`@/styles/var`、`~element-plus/index.css`
   * @param from 发起引用的文件
   * @param exts 候选扩展名，按优先级排列
   */
  async resolve(spec: string, from: vscode.Uri, exts: string[]): Promise<vscode.Uri | undefined> {
    const bases = this.expandBases(spec, from);
    const candidates: vscode.Uri[] = [];
    for (const base of bases) {
      for (const candidate of buildFileCandidates(base, exts)) {
        candidates.push(candidate);
        if (candidates.length >= MAX_CANDIDATES) {
          break;
        }
      }
    }
    for (const candidate of candidates) {
      if (await this.exists(candidate)) {
        return candidate;
      }
    }
    return undefined;
  }

  /** 把 spec 展开成若干“无扩展名的基础路径”。 */
  private expandBases(spec: string, from: vscode.Uri): vscode.Uri[] {
    const clean = spec.split('?')[0].split('#')[0].trim();
    if (!clean) {
      return [];
    }
    const bases: vscode.Uri[] = [];
    const folder = vscode.workspace.getWorkspaceFolder(from);

    if (clean.startsWith('./') || clean.startsWith('../') || clean === '.' || clean === '..') {
      bases.push(vscode.Uri.joinPath(from, '..', clean));
      return bases;
    }

    if (clean.startsWith('/')) {
      if (folder) {
        bases.push(vscode.Uri.joinPath(folder.uri, clean.slice(1)));
      }
      return bases;
    }

    // webpack / vue-cli 风格：`~pkg` 表示从 node_modules 解析
    const tilde = clean.startsWith('~') ? clean.slice(1) : clean;

    for (const alias of this.aliases) {
      const source = clean.startsWith(alias.prefix)
        ? clean
        : tilde.startsWith(alias.prefix)
          ? tilde
          : undefined;
      if (!source) {
        continue;
      }
      const rest = source.slice(alias.prefix.length);
      for (const target of alias.targets) {
        bases.push(vscode.Uri.joinPath(vscode.Uri.parse(target), rest));
      }
    }

    // 裸模块：尝试从 node_modules 解析（工作区根与引用文件所在目录逐级向上）
    if (folder) {
      bases.push(vscode.Uri.joinPath(folder.uri, 'node_modules', tilde));
    }
    bases.push(vscode.Uri.joinPath(from, '..', 'node_modules', tilde));

    return bases;
  }

  private async exists(uri: vscode.Uri): Promise<boolean> {
    const key = uri.toString();
    const cached = this.existsCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    let ok = false;
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      ok = (stat.type & vscode.FileType.File) !== 0;
    } catch {
      ok = false;
    }
    this.existsCache.set(key, ok);
    return ok;
  }

  private async readJsonc(uri: vscode.Uri): Promise<Record<string, unknown> | undefined> {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = new TextDecoder().decode(bytes);
      return JSON.parse(stripJsonComments(text)) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
}

/** 为一个基础路径生成候选文件列表（含扩展名补全、Sass partial 与 index 约定）。 */
export function buildFileCandidates(base: vscode.Uri, exts: string[]): vscode.Uri[] {
  const result: vscode.Uri[] = [];
  const path = base.path;
  const slash = path.lastIndexOf('/');
  const dir = path.slice(0, slash);
  const name = path.slice(slash + 1);

  // 已经带了合法扩展名，直接尝试原路径
  if (exts.includes(extensionOf(name))) {
    result.push(base);
  }
  for (const ext of exts) {
    result.push(base.with({ path: `${dir}/${name}.${ext}` }));
  }
  // Sass / SCSS 的 partial 约定
  if (!name.startsWith('_')) {
    for (const ext of exts) {
      result.push(base.with({ path: `${dir}/_${name}.${ext}` }));
    }
  }
  for (const ext of exts) {
    result.push(base.with({ path: `${path}/index.${ext}` }));
    result.push(base.with({ path: `${path}/_index.${ext}` }));
  }
  return result;
}

/** 去掉 JSON 中的注释与尾逗号，用于读取 tsconfig / jsconfig。 */
export function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (ch === '\n') {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLine = true;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlock = true;
      i++;
      continue;
    }
    out += ch;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}
