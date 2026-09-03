/**
 * 测试用的 `vscode` 模块桩。
 *
 * 通过劫持 CommonJS 的模块加载，把 `require('vscode')` 指向一个内存实现，
 * 这样索引、路径解析、跳转解析这些真实代码可以在普通 Node 环境下端到端跑起来，
 * 不需要启动 Extension Host。
 *
 * 只实现 SymbolGo 实际用到的 API 子集；用到未实现的成员会直接抛错，
 * 这正是我们想要的：避免测试悄悄绕过真实调用路径。
 */
import Module from 'node:module';

class Position {
  constructor(
    readonly line: number,
    readonly character: number
  ) {}
}

class Range {
  readonly start: Position;
  readonly end: Position;

  constructor(
    startLine: number | Position,
    startChar: number | Position,
    endLine?: number,
    endChar?: number
  ) {
    if (startLine instanceof Position && startChar instanceof Position) {
      this.start = startLine;
      this.end = startChar;
    } else {
      this.start = new Position(startLine as number, startChar as number);
      this.end = new Position(endLine ?? 0, endChar ?? 0);
    }
  }
}

class Uri {
  private constructor(
    readonly scheme: string,
    readonly authority: string,
    readonly path: string
  ) {}

  static file(fsPath: string): Uri {
    const normalized = fsPath.replace(/\\/g, '/');
    return new Uri('file', '', normalized.startsWith('/') ? normalized : `/${normalized}`);
  }

  static parse(value: string): Uri {
    const match = /^([a-zA-Z][\w+.-]*):\/\/([^/]*)(\/.*)?$/.exec(value);
    if (!match) {
      return Uri.file(value);
    }
    return new Uri(match[1], match[2] ?? '', match[3] ?? '/');
  }

  static joinPath(base: Uri, ...segments: string[]): Uri {
    const parts = base.path.split('/');
    for (const segment of segments) {
      for (const piece of segment.split('/')) {
        if (piece === '' || piece === '.') {
          continue;
        }
        if (piece === '..') {
          parts.pop();
          continue;
        }
        parts.push(piece);
      }
    }
    const path = parts.join('/') || '/';
    return new Uri(base.scheme, base.authority, path.startsWith('/') ? path : `/${path}`);
  }

  with(change: { path?: string }): Uri {
    return new Uri(this.scheme, this.authority, change.path ?? this.path);
  }

  get fsPath(): string {
    return this.path;
  }

  toString(): string {
    return `${this.scheme}://${this.authority}${this.path}`;
  }
}

/** 内存文件系统：uri 字符串 -> 文件内容。 */
export const files = new Map<string, string>();

const encoder = new TextEncoder();

const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };

let configValues: Record<string, unknown> = {};
let folders: Uri[] = [];

export function setConfig(values: Record<string, unknown>): void {
  configValues = values;
}

export function setWorkspaceFolders(uris: string[]): void {
  folders = uris.map((u) => Uri.parse(u));
}

export function writeFile(uri: string, content: string): void {
  files.set(uri, content);
}

export function resetWorkspace(): void {
  files.clear();
  configValues = {};
  folders = [];
}

/** 极简 TextDocument 实现，行为与 VS Code 的偏移 / 位置换算一致。 */
export class StubTextDocument {
  readonly version = 1;
  readonly uri: Uri;
  private readonly lineStarts: number[];

  constructor(
    uriString: string,
    private readonly text: string
  ) {
    this.uri = Uri.parse(uriString);
    const starts = [0];
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '\n') {
        starts.push(i + 1);
      }
    }
    this.lineStarts = starts;
  }

  getText(): string {
    return this.text;
  }

  offsetAt(position: Position): number {
    return Math.min(
      (this.lineStarts[position.line] ?? 0) + position.character,
      this.text.length
    );
  }

  positionAt(offset: number): Position {
    let line = 0;
    for (let i = 0; i < this.lineStarts.length; i++) {
      if (this.lineStarts[i] <= offset) {
        line = i;
      } else {
        break;
      }
    }
    return new Position(line, offset - this.lineStarts[line]);
  }

  /** 找到 needle 首次出现处再偏移 delta 的位置，方便测试定位光标。 */
  positionOf(needle: string, delta = 0): Position {
    const index = this.text.indexOf(needle);
    if (index === -1) {
      throw new Error(`测试文本中找不到：${needle}`);
    }
    return this.positionAt(index + delta);
  }
}

const vscodeStub = {
  Position,
  Range,
  Uri,
  FileType,
  Location: class {
    constructor(
      readonly uri: Uri,
      readonly range: Range
    ) {}
  },
  MarkdownString: class {
    value = '';
    isTrusted = false;
    supportThemeIcons = false;
    appendMarkdown(text: string): void {
      this.value += text;
    }
    appendCodeblock(text: string): void {
      this.value += text;
    }
  },
  Hover: class {
    constructor(
      readonly contents: unknown,
      readonly range?: Range
    ) {}
  },
  StatusBarAlignment: { Left: 1, Right: 2 },
  workspace: {
    get workspaceFolders(): { uri: Uri }[] {
      return folders.map((uri) => ({ uri }));
    },
    getWorkspaceFolder(uri: Uri): { uri: Uri } | undefined {
      const found = folders.find((folder) => uri.path.startsWith(`${folder.path}/`));
      return found ? { uri: found } : undefined;
    },
    getConfiguration() {
      return {
        get<T>(key: string, fallback: T): T {
          return (configValues[key] as T) ?? fallback;
        }
      };
    },
    asRelativePath(uri: Uri): string {
      return uri.path;
    },
    textDocuments: [] as unknown[],
    fs: {
      async stat(uri: Uri): Promise<{ type: number; size: number }> {
        const content = files.get(uri.toString());
        if (content === undefined) {
          throw new Error(`ENOENT: ${uri.toString()}`);
        }
        return { type: FileType.File, size: content.length };
      },
      async readFile(uri: Uri): Promise<Uint8Array> {
        const content = files.get(uri.toString());
        if (content === undefined) {
          throw new Error(`ENOENT: ${uri.toString()}`);
        }
        return encoder.encode(content);
      }
    }
  },
  window: {
    createOutputChannel() {
      return {
        appendLine(): void {},
        show(): void {},
        dispose(): void {}
      };
    }
  }
};

// 劫持 require('vscode')
const loader = Module as unknown as {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
};
const originalLoad = loader._load;
loader._load = function patched(request: string, parent: unknown, isMain: boolean): unknown {
  if (request === 'vscode') {
    return vscodeStub;
  }
  return originalLoad.call(this, request, parent, isMain);
};

export { Position, Range, Uri };
