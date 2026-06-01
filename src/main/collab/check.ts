import { spawn } from 'child_process';
import type { CollabConfig } from './types';

export interface CollabCliCheckItem {
  command: string;
  ok: boolean;
  version?: string;
  error?: string;
}

export interface CollabCliCheckResult {
  ok: boolean;
  codex: CollabCliCheckItem;
  claude: CollabCliCheckItem;
}

function checkCommand(command: string): Promise<CollabCliCheckItem> {
  return new Promise((resolve) => {
    const child = spawn(command, ['--version'], {
      shell: process.platform === 'win32',
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      resolve({ command, ok: false, error: 'Timed out while checking command.' });
    }, 10_000);

    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ command, ok: false, error: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const output = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n').trim();
      resolve({
        command,
        ok: code === 0,
        version: output || undefined,
        error: code === 0 ? undefined : output || `Command exited with code ${code}.`,
      });
    });
  });
}

export async function checkCollabCli(config: CollabConfig): Promise<CollabCliCheckResult> {
  const [codex, claude] = await Promise.all([
    checkCommand(config.codexCommand || 'codex'),
    checkCommand(config.claudeCommand || 'claude'),
  ]);
  return {
    ok: codex.ok && claude.ok,
    codex,
    claude,
  };
}
