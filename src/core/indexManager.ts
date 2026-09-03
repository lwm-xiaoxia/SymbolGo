import * as vscode from 'vscode';
import { analyzeSource } from './analyzer.js';
import { toGlob } from './config.js';
import type { SymbolGoConfig } from './config.js';
import {
  COMPONENT_EXTS,
  docKindOfPath,
  extensionOf,
  stemOf,
  dirNameOf,
  baseNameOf
} from './languages.js';
import type { Logger } from './logger.js';
import { SymbolIndex } from './symbolIndex.js';

/** 每处理这么多文件就让出一次事件循环，避免长时间占用 Extension Host。 */
const SCAN_CHUNK_SIZE = 40;
/** 文档编辑后的重新索引延迟（毫秒） */
const DOCUMENT_DEBOUNCE = 350;
/** 文件系统事件的重新索引延迟（毫秒） */
const FILE_DEBOUNCE = 200;

/**
 * 索引调度中心。
 *
 * 首次激活时做一次全量扫描（分片执行，不阻塞 Extension Host），
 * 之后靠文件监听与文档编辑事件做增量更新，跳转时永远只查内存索引。
 */
export class IndexManager implements vscode.Disposable {
  readonly index = new SymbolIndex();

  private readonly disposables: vscode.Disposable[] = [];
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
  private watcher: vscode.FileSystemWatcher | undefined;
  private statusItem: vscode.StatusBarItem | undefined;
  private scanToken = 0;
  private readyResolve: (() => void) | undefined;
  private readyPromise: Promise<void>;

  constructor(
    private config: SymbolGoConfig,
    private readonly logger: Logger,
    private readonly onInvalidate: () => void
  ) {
    this.readyPromise = new Promise<void>((resolve) => {
      this.readyResolve = resolve;
    });
  }

  /** 首次全量索引是否已完成。跳转前可以 await，但不应无限等待。 */
  get ready(): Promise<void> {
    return this.readyPromise;
  }

  updateConfig(config: SymbolGoConfig): void {
    this.config = config;
  }

  /** 启动：注册监听并触发一次全量扫描。 */
  start(): void {
    this.registerWatcher();
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => this.handleDocumentChange(e.document)),
      vscode.workspace.onDidCloseTextDocument((doc) => {
        // 关闭未保存的新文件时，磁盘上并不存在，需要把它从索引里去掉
        if (doc.isUntitled) {
          this.remove(doc.uri);
        }
      }),
      vscode.workspace.onDidRenameFiles((e) => {
        for (const file of e.files) {
          this.remove(file.oldUri);
          this.scheduleFile(file.newUri, FILE_DEBOUNCE);
        }
      })
    );
    void this.rebuild();
  }

  /** 重新做一次全量扫描。 */
  async rebuild(): Promise<void> {
    const token = ++this.scanToken;
    this.index.clear();
    this.onInvalidate();

    const include = toGlob(this.config.include);
    if (!include) {
      this.finishReady();
      return;
    }
    const exclude = toGlob(this.config.exclude);

    const started = Date.now();
    this.showStatus('SymbolGo: 正在建立索引…');
    let files: vscode.Uri[];
    try {
      files = await vscode.workspace.findFiles(include, exclude, this.config.maxFiles);
    } catch (error) {
      this.logger.error('扫描工作区文件失败', error);
      this.hideStatus();
      this.finishReady();
      return;
    }

    let done = 0;
    for (const uri of files) {
      if (token !== this.scanToken) {
        // 已有新的扫描任务，放弃当前这轮
        return;
      }
      await this.indexUri(uri);
      done++;
      if (done % SCAN_CHUNK_SIZE === 0) {
        this.showStatus(`SymbolGo: 正在建立索引… ${done}/${files.length}`);
        await yieldToEventLoop();
      }
    }

    this.hideStatus();
    this.logger.info(
      `索引完成：${this.index.fileCount} 个文件、${this.index.symbolCount} 个符号，耗时 ${Date.now() - started}ms`
    );
    this.finishReady();
  }

  /** 解析并索引单个文件。text 为空时从磁盘或已打开文档读取。 */
  async indexUri(uri: vscode.Uri, text?: string): Promise<void> {
    const fsPath = uri.path;
    const kind = docKindOfPath(fsPath);
    if (!kind) {
      return;
    }

    this.registerComponent(uri);

    // 样式定义只可能来自样式文件、Vue SFC 与 HTML 内联样式
    if (kind === 'script') {
      return;
    }

    let content = text;
    if (content === undefined) {
      content = await this.readText(uri);
      if (content === undefined) {
        return;
      }
    }

    try {
      const analysis = analyzeSource(fsPath, content);
      this.index.setFile(uri.toString(), analysis.symbols);
    } catch (error) {
      this.logger.error(`解析文件失败：${uri.fsPath}`, error);
    }
  }

  remove(uri: vscode.Uri): void {
    const key = uri.toString();
    this.index.removeFile(key);
    this.index.removeComponent(key);
    this.onInvalidate();
  }

  /** 文档编辑后延迟重新索引，保证未保存的修改也能被跳转到。 */
  handleDocumentChange(document: vscode.TextDocument): void {
    if (document.uri.scheme !== 'file' && document.uri.scheme !== 'untitled') {
      return;
    }
    if (!docKindOfPath(document.uri.path)) {
      return;
    }
    this.schedule(document.uri.toString(), DOCUMENT_DEBOUNCE, () => {
      void this.indexUri(document.uri, document.getText());
      this.onInvalidate();
    });
  }

  dispose(): void {
    for (const timer of this.pending.values()) {
      clearTimeout(timer);
    }
    this.pending.clear();
    this.watcher?.dispose();
    this.statusItem?.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
  }

  private registerWatcher(): void {
    this.watcher?.dispose();
    const include = toGlob(this.config.include);
    if (!include) {
      return;
    }
    const watcher = vscode.workspace.createFileSystemWatcher(include);
    watcher.onDidCreate((uri) => this.scheduleFile(uri, FILE_DEBOUNCE));
    watcher.onDidChange((uri) => this.scheduleFile(uri, FILE_DEBOUNCE));
    watcher.onDidDelete((uri) => this.remove(uri));
    this.watcher = watcher;
    this.disposables.push(watcher);
  }

  private scheduleFile(uri: vscode.Uri, delay: number): void {
    this.schedule(uri.toString(), delay, () => {
      void this.indexUri(uri);
      this.onInvalidate();
    });
  }

  private schedule(key: string, delay: number, run: () => void): void {
    const existing = this.pending.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    this.pending.set(
      key,
      setTimeout(() => {
        this.pending.delete(key);
        run();
      }, delay)
    );
  }

  /** 依据文件路径登记组件名。`index.vue` 取所在目录名。 */
  private registerComponent(uri: vscode.Uri): void {
    const ext = extensionOf(uri.path);
    if (!COMPONENT_EXTS.includes(ext)) {
      return;
    }
    let stem = stemOf(uri.path);
    if (/^index$/i.test(stem)) {
      stem = baseNameOf(dirNameOf(uri.path));
    }
    if (!stem) {
      return;
    }
    // .vue / .jsx / .tsx 直接视为组件文件；.js / .ts 只在文件名像组件时登记，
    // 避免把 utils.ts、request.ts 这类模块塞进组件索引
    const isObviousComponent = ext === 'vue' || ext === 'jsx' || ext === 'tsx';
    if (!isObviousComponent && !/^[A-Z]/.test(stem)) {
      return;
    }
    this.index.setComponent(uri.toString(), stem);
  }

  private async readText(uri: vscode.Uri): Promise<string | undefined> {
    // 已打开的文档以编辑器内容为准（可能含未保存修改）
    const open = vscode.workspace.textDocuments.find(
      (doc) => doc.uri.toString() === uri.toString()
    );
    if (open) {
      return open.getText();
    }
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      if (bytes.byteLength > this.config.maxFileSizeBytes) {
        this.logger.trace(`跳过超大文件：${uri.fsPath}（${bytes.byteLength} 字节）`);
        return undefined;
      }
      return new TextDecoder().decode(bytes);
    } catch (error) {
      this.logger.trace(`读取文件失败：${uri.fsPath} ${String(error)}`);
      return undefined;
    }
  }

  private showStatus(text: string): void {
    if (!this.statusItem) {
      this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 0);
    }
    this.statusItem.text = `$(sync~spin) ${text}`;
    this.statusItem.show();
  }

  private hideStatus(): void {
    this.statusItem?.hide();
  }

  private finishReady(): void {
    this.readyResolve?.();
    this.readyResolve = undefined;
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
