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
const GRACEFUL_SHUTDOWN_MS = 300;
const FORCED_SHUTDOWN_MS = 1_000;
const MAX_STDERR_LINES = 20;

class CodexAppServerClient {
  private process?: ChildProcessWithoutNullStreams;
  private reader?: readline.Interface;
  private requestSequence = 0;
  private stopping = false;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly stderrLines: string[] = [];

  public async getRateLimits(
    executablePath: string,
    signal?: AbortSignal
  ): Promise<AppServerRateLimitsResponse> {
    const abortReason = createAbortError();
    const onAbort = (): void => {
      void this.stop(abortReason);
    };

    if (signal?.aborted) {
      throw abortReason;
    }

    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      await this.start(executablePath);
      throwIfAborted(signal);
      await this.initialize();
      throwIfAborted(signal);
      return await this.request<AppServerRateLimitsResponse>('account/rateLimits/read');
    } finally {
      signal?.removeEventListener('abort', onAbort);
      await this.stop(new Error('Codex usage query completed.'));
    }
  }

  private async start(executablePath: string): Promise<void> {
    const executable = executablePath.trim() || 'codex';
    this.stderrLines.length = 0;
    this.stopping = false;

    const child = spawn(executable, ['app-server', '--listen', 'stdio://'], {
      env: {
        ...process.env,
        RUST_LOG: process.env.RUST_LOG ?? 'error'
      },
      // Windows npm/CLI shims can require a shell. The entire process tree is
      // explicitly terminated after every query so no Codex child is left alive.
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
      if (this.process !== child || this.stopping) {
        return;
      }

      const details = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`;
      this.handleProcessFailure(new Error(`Codex app-server stopped with ${details}.`));
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
    if (!child || child.stdin.destroyed) {
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
    if (!child || child.stdin.destroyed) {
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
    if (this.stopping) {
      return;
    }

    const stderr = this.stderrLines.length > 0 ? ` Last stderr: ${this.stderrLines.at(-1)}` : '';
    this.rejectPending(new Error(`${error.message}${stderr}`));
  }

  private async stop(reason: Error): Promise<void> {
    if (this.stopping) {
      return;
    }

    this.stopping = true;
    const child = this.process;
    this.process = undefined;

    this.reader?.close();
    this.reader = undefined;
    this.rejectPending(reason);

    if (!child || hasExited(child)) {
      return;
    }

    // Closing stdin first gives app-server a chance to stop cleanly and release
    // any Codex state before a forced process-tree termination is attempted.
    if (!child.stdin.destroyed) {
      child.stdin.end();
    }

    if (await waitForExit(child, GRACEFUL_SHUTDOWN_MS)) {
      return;
    }

    await terminateProcessTree(child);
    await waitForExit(child, FORCED_SHUTDOWN_MS);
  }

  private rejectPending(reason: Error): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(reason);
    }
    this.pendingRequests.clear();
  }
}

export async function fetchLiveRateLimits(
  executablePath: string,
  signal?: AbortSignal
): Promise<AppServerRateLimitsResponse> {
  // A fresh app-server is intentionally used for every sample. This ensures a
  // ChatGPT/Codex account switch is picked up without restarting the editor and
  // avoids keeping a background Codex process alive between refreshes.
  const client = new CodexAppServerClient();
  return client.getRateLimits(executablePath, signal);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

function createAbortError(): Error {
  const error = new Error('Codex usage query cancelled.');
  error.name = 'AbortError';
  return error;
}

function hasExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (hasExited(child)) {
    return Promise.resolve(true);
  }

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (exited: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      child.removeListener('exit', onExit);
      resolve(exited);
    };
    const onExit = (): void => finish(true);
    const timeout = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', onExit);
  });
}

async function terminateProcessTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (hasExited(child)) {
    return;
  }

  if (process.platform !== 'win32' || child.pid === undefined) {
    child.kill('SIGTERM');
    return;
  }

  // shell:true can introduce a cmd.exe parent on Windows. taskkill /T ensures
  // both that shell and the actual Codex descendant are released.
  await new Promise<void>((resolve) => {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      shell: false,
      stdio: 'ignore'
    });

    killer.once('error', () => {
      if (!hasExited(child)) {
        child.kill();
      }
      resolve();
    });
    killer.once('exit', () => resolve());
  });
}
