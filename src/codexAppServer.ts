import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as readline from 'readline';
import * as vscode from 'vscode';
import { EXTENSION_ID, EXTENSION_NAME } from './constants';
import { AppServerRateLimitsResponse } from './types';

interface JsonRpcResponse {
  id?: string | number;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_STDERR_LINES = 20;

class CodexAppServerClient {
  private process?: ChildProcessWithoutNullStreams;
  private reader?: readline.Interface;
  private executable?: string;
  private initialization?: Promise<void>;
  private requestSequence = 0;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly stderrLines: string[] = [];

  public async getRateLimits(executablePath: string): Promise<AppServerRateLimitsResponse> {
    await this.ensureStarted(executablePath);
    await this.initialization;

    return this.request<AppServerRateLimitsResponse>('account/rateLimits/read');
  }

  public dispose(): void {
    this.stop(new Error('Codex app-server client disposed.'));
  }

  private async ensureStarted(executablePath: string): Promise<void> {
    const executable = executablePath.trim() || 'codex';

    if (this.process && this.executable === executable && !this.process.killed) {
      return;
    }

    this.stop(new Error('Restarting Codex app-server client.'));
    this.executable = executable;
    this.stderrLines.length = 0;

    const child = spawn(executable, ['app-server', '--listen', 'stdio://'], {
      env: {
        ...process.env,
        RUST_LOG: process.env.RUST_LOG ?? 'error'
      },
      shell: process.platform === 'win32',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this.process = child;
    this.reader = readline.createInterface({ input: child.stdout });
    this.reader.on('line', (line) => this.handleStdoutLine(line));
    child.stderr.on('data', (chunk: Buffer | string) => this.captureStderr(String(chunk)));
    child.once('error', (error) => this.handleProcessFailure(error));
    child.once('exit', (code, signal) => {
      if (this.process !== child) {
        return;
      }

      const details = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`;
      this.handleProcessFailure(new Error(`Codex app-server stopped with ${details}.`));
    });

    this.initialization = this.initialize().catch((error: unknown) => {
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.stop(normalized);
      throw normalized;
    });
  }

  private async initialize(): Promise<void> {
    const version = String(vscode.extensions.getExtension(EXTENSION_ID)?.packageJSON.version ?? '0.0.0');

    await this.requestRaw('initialize', {
      clientInfo: {
        name: 'codex_usage_remaining',
        title: EXTENSION_NAME,
        version
      }
    });

    this.notify('initialized');
  }

  private async request<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const result = await this.requestRaw(method, params);
    return result as T;
  }

  private requestRaw(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const child = this.process;
    if (!child || child.killed || child.stdin.destroyed) {
      return Promise.reject(new Error('Codex app-server is not running.'));
    }

    const id = String(++this.requestSequence);

    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Codex app-server request '${method}' timed out.`));
      }, REQUEST_TIMEOUT_MS);

      this.pendingRequests.set(id, { resolve, reject, timeout });

      try {
        this.writeMessage({ id, method, ...(params ? { params } : {}) });
      } catch (error) {
        clearTimeout(timeout);
        this.pendingRequests.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private notify(method: string, params?: Record<string, unknown>): void {
    this.writeMessage({ method, ...(params ? { params } : {}) });
  }

  private writeMessage(message: Record<string, unknown>): void {
    const child = this.process;
    if (!child || child.killed || child.stdin.destroyed) {
      throw new Error('Codex app-server is not available.');
    }

    child.stdin.write(`${JSON.stringify(message)}\n`, 'utf8');
  }

  private handleStdoutLine(line: string): void {
    if (!line.trim()) {
      return;
    }

    let message: JsonRpcResponse;
    try {
      message = JSON.parse(line) as JsonRpcResponse;
    } catch {
      return;
    }

    if (message.id === undefined || message.id === null) {
      return;
    }

    const id = String(message.id);
    const pending = this.pendingRequests.get(id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingRequests.delete(id);

    if (message.error) {
      const code = message.error.code === undefined ? '' : ` (${message.error.code})`;
      pending.reject(new Error(`Codex app-server error${code}: ${message.error.message ?? 'Unknown error'}`));
      return;
    }

    pending.resolve(message.result);
  }

  private captureStderr(value: string): void {
    for (const line of value.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      this.stderrLines.push(trimmed);
      if (this.stderrLines.length > MAX_STDERR_LINES) {
        this.stderrLines.shift();
      }
    }
  }

  private handleProcessFailure(error: Error): void {
    const stderr = this.stderrLines.length > 0 ? ` Last stderr: ${this.stderrLines.at(-1)}` : '';
    this.stop(new Error(`${error.message}${stderr}`));
  }

  private stop(reason: Error): void {
    const child = this.process;
    this.process = undefined;
    this.initialization = undefined;
    this.executable = undefined;

    this.reader?.close();
    this.reader = undefined;

    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(reason);
    }
    this.pendingRequests.clear();

    if (child && !child.killed) {
      child.kill();
    }
  }
}

const client = new CodexAppServerClient();

export function fetchLiveRateLimits(executablePath: string): Promise<AppServerRateLimitsResponse> {
  return client.getRateLimits(executablePath);
}

export function disposeCodexAppServerClient(): void {
  client.dispose();
}
