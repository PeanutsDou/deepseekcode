import { spawn } from 'child_process';
import { createWriteStream } from 'fs';
import type { CliRunResult } from './types';

export interface CliRunOptions {
  command: string;
  args: string[];
  cwd: string;
  logPath: string;
  input?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
  onLine?: (line: string, parsed?: Record<string, unknown>) => void;
}

function quoteWindowsShellArg(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
  let result = '"';
  let backslashes = 0;
  for (const char of value) {
    if (char === '\\') {
      backslashes += 1;
      continue;
    }
    if (char === '"') {
      result += '\\'.repeat(backslashes * 2 + 1);
      result += '"';
      backslashes = 0;
      continue;
    }
    result += '\\'.repeat(backslashes);
    backslashes = 0;
    result += char;
  }
  result += '\\'.repeat(backslashes * 2);
  result += '"';
  return result;
}

export function runCli(options: CliRunOptions): Promise<CliRunResult> {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(options.logPath, { flags: 'a', encoding: 'utf8' });
    const maxOutputBytes = Math.max(16 * 1024, options.maxOutputBytes || 2 * 1024 * 1024);
    const useWindowsShell = process.platform === 'win32';
    const child = useWindowsShell ? spawn(
      [options.command, ...options.args].map(quoteWindowsShellArg).join(' '),
      [],
      {
        cwd: options.cwd,
        env: process.env,
        shell: true,
        stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    ) : spawn(options.command, options.args, {
      cwd: options.cwd,
      env: process.env,
      shell: false,
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let stdoutLineBuffer = '';
    let stderrLineBuffer = '';
    let settled = false;
    let timedOut = false;
    let truncated = false;
    let outputBytes = 0;
    let timeout: NodeJS.Timeout | undefined;

    if (options.input !== undefined) {
      child.stdin?.end(options.input);
    }

    const finish = (result: CliRunResult) => {
      if (settled) return;
      settled = true;
      out.end();
      resolve(result);
    };

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      out.end();
      reject(error);
    };

    const appendLimited = (target: 'stdout' | 'stderr', text: string) => {
      const bytes = Buffer.byteLength(text);
      outputBytes += bytes;
      if (outputBytes > maxOutputBytes) {
        if (!truncated) {
          truncated = true;
          const marker = '\n...[CLI output truncated by Neck Code]...\n';
          out.write(marker);
          if (target === 'stdout') stdout += marker;
          else stderr += marker;
        }
        return;
      }
      if (target === 'stdout') stdout += text;
      else stderr += text;
    };

    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let parsed: Record<string, unknown> | undefined;
      try {
        const json = JSON.parse(trimmed);
        if (typeof json === 'object' && json !== null) parsed = json as Record<string, unknown>;
      } catch {
        parsed = undefined;
      }
      options.onLine?.(trimmed, parsed);
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      out.write(text);
      appendLimited('stdout', text);
      stdoutLineBuffer += text;
      const lines = stdoutLineBuffer.split(/\r?\n/);
      stdoutLineBuffer = lines.pop() || '';
      for (const line of lines) handleLine(line);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      out.write(text);
      appendLimited('stderr', text);
      stderrLineBuffer += text;
      const lines = stderrLineBuffer.split(/\r?\n/);
      stderrLineBuffer = lines.pop() || '';
      for (const line of lines) handleLine(line);
    });

    child.on('error', fail);
    child.on('close', (code, signal) => {
      if (timeout) clearTimeout(timeout);
      if (stdoutLineBuffer) handleLine(stdoutLineBuffer);
      if (stderrLineBuffer) handleLine(stderrLineBuffer);
      finish({ exitCode: code, output: stdout, errorOutput: stderr, signal, timedOut, truncated });
    });

    const abort = (reason?: 'timeout') => {
      if (reason === 'timeout') timedOut = true;
      try {
        if (process.platform === 'win32' && child.pid) {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        } else {
          child.kill('SIGTERM');
        }
      } catch {
        // Ignore kill failures; close/error will settle the promise.
      }
    };

    if (options.timeoutMs && options.timeoutMs > 0) {
      timeout = setTimeout(() => abort('timeout'), options.timeoutMs);
    }

    const abortBySignal = () => abort();
    if (options.signal?.aborted) {
      abort();
    } else {
      options.signal?.addEventListener('abort', abortBySignal, { once: true });
    }
  });
}
