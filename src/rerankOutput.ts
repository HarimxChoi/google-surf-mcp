#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatRerankedOutput, rerankOutput, sanitizeOutputText } from './outputRerank.js';

type HookInput = Record<string, unknown>;

type OutputState = {
  visible_chars: number;
  updated_at: number;
};

export type OutputHookOptions = {
  state_root?: string;
  trigger_chars?: number;
  max_chars?: number;
  max_turn_chars?: number;
};

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function readStdin(): Promise<HookInput> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as HookInput;
}

function responseText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof (value as Record<string, unknown>).output === 'string') {
    return (value as Record<string, unknown>).output as string;
  }
  return JSON.stringify(value ?? null);
}

function stateKey(input: HookInput): string {
  const turn = input.turn_id || `fallback-${Math.floor(Date.now() / (15 * 60 * 1000))}`;
  return createHash('sha256').update(`${input.session_id || 'unknown'}\0${turn}`).digest('hex');
}

function commandFrom(input: HookInput): string {
  const toolInput = input.tool_input && typeof input.tool_input === 'object'
    ? input.tool_input as Record<string, unknown>
    : {};
  return String(toolInput.command ?? toolInput.cmd ?? 'shell output');
}

async function acquireLock(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const handle = await open(path, 'wx', 0o600);
      await handle.close();
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const info = await stat(path);
        if (Date.now() - info.mtimeMs > 5_000) await unlink(path);
      } catch {}
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    }
  }
  throw new Error('shell output state is busy');
}

async function writeState(path: string, state: OutputState): Promise<void> {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, path);
}

export async function processOutputHook(
  input: HookInput,
  options: OutputHookOptions = {},
): Promise<Record<string, unknown> | undefined> {
  if (input.tool_name !== 'Bash') return undefined;
  const raw = responseText(input.tool_response);
  if (!raw) return undefined;
  const safe = sanitizeOutputText(raw);
  const triggerChars = options.trigger_chars
    ?? positiveInteger(process.env.SURF_RERANK_TRIGGER_CHARS, 6_000);
  const maxChars = options.max_chars
    ?? positiveInteger(process.env.SURF_RERANK_MAX_CHARS, 6_000);
  const maxTurnChars = options.max_turn_chars
    ?? positiveInteger(process.env.SURF_RERANK_TURN_MAX_CHARS, 12_000);
  const stateRoot = options.state_root
    ?? join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'hooks', 'state', 'google-surf-output');
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const path = join(stateRoot, `${stateKey(input)}.json`);
  const lock = `${path}.lock`;
  await acquireLock(lock);
  try {
    let state: OutputState = { visible_chars: 0, updated_at: 0 };
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<OutputState>;
      state = {
        visible_chars: Number(parsed.visible_chars ?? 0),
        updated_at: Number(parsed.updated_at ?? 0),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const remaining = Math.max(0, maxTurnChars - state.visible_chars);
    if (safe === raw && raw.length <= triggerChars && raw.length <= remaining) {
      await writeState(path, { visible_chars: state.visible_chars + raw.length, updated_at: Date.now() });
      return undefined;
    }

    let replacement: string;
    if (remaining < 200) {
      replacement = '[Google Surf output guard] This turn reached its shell-output budget. Reuse prior results or continue in a later user turn.';
    } else if (safe !== raw && safe.length <= triggerChars && safe.length <= remaining) {
      replacement = `[Google Surf output guard] Sensitive values and control sequences were removed. Source output was not stored.\n${safe}`;
    } else {
      const result = rerankOutput(commandFrom(input), safe, {
        max_chars: Math.min(maxChars, remaining),
      });
      replacement = `[Google Surf output guard]\n${formatRerankedOutput(result)}`;
    }
    replacement = replacement.slice(0, Math.max(200, Math.min(maxChars, remaining || maxChars)));
    await writeState(path, {
      visible_chars: state.visible_chars + replacement.length,
      updated_at: Date.now(),
    });
    return { continue: false, stopReason: replacement };
  } finally {
    await unlink(lock).catch(() => {});
  }
}

async function main(): Promise<void> {
  const input = await readStdin();
  if (input.hook_event_name === 'PostToolUse') {
    const response = await processOutputHook(input);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
    return;
  }
  const result = rerankOutput(
    String(input.query ?? ''),
    input.response ?? input.output ?? '',
    {
      max_chars: typeof input.max_chars === 'number' ? input.max_chars : undefined,
      max_blocks: typeof input.max_blocks === 'number' ? input.max_blocks : undefined,
    },
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`output reranker failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  });
}
