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
    let lineBuffer = '';
    let settled = false;

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
      stdout += text;
      out.write(text);
      lineBuffer += text;
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() || '';
      for (const line of lines) handleLine(line);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      out.write(text);
    });

    child.on('error', fail);
    child.on('close', (code) => {
      if (lineBuffer) handleLine(lineBuffer);
      finish({ exitCode: code, output: stdout, errorOutput: stderr });
    });

    const abort = () => {
      try {
        child.kill('SIGTERM');
      } catch {
        // Ignore kill failures; close/error will settle the promise.
      }
    };

    if (options.signal?.aborted) {
      abort();
    } else {
      options.signal?.addEventListener('abort', abort, { once: true });
    }
  });
}
