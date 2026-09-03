import * as vscode from 'vscode';

/** 统一的日志输出。trace 级别默认关闭，避免正常使用时刷屏。 */
export class Logger implements vscode.Disposable {
  private readonly channel: vscode.OutputChannel;
  private traceEnabled = false;

  constructor(name = 'SymbolGo') {
    this.channel = vscode.window.createOutputChannel(name);
  }

  setTrace(enabled: boolean): void {
    this.traceEnabled = enabled;
  }

  info(message: string): void {
    this.write('INFO', message);
  }

  warn(message: string): void {
    this.write('WARN', message);
  }

  error(message: string, error?: unknown): void {
    const detail = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : error ? String(error) : '';
    this.write('ERROR', detail ? `${message} :: ${detail}` : message);
  }

  trace(message: string): void {
    if (this.traceEnabled) {
      this.write('TRACE', message);
    }
  }

  show(): void {
    this.channel.show(true);
  }

  private write(level: string, message: string): void {
    const time = new Date().toISOString().slice(11, 23);
    this.channel.appendLine(`[${time}] [${level}] ${message}`);
  }

  dispose(): void {
    this.channel.dispose();
  }
}
