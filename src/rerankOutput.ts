#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatRerankedOutput, rerankOutput, sanitizeOutputText } from './outputRerank.js';

type HookInput = Record<string, unknown>;

export type OutputHookOptions = {
  trigger_chars?: number;
  max_chars?: number;
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

function commandFrom(input: HookInput): string {
  const toolInput = input.tool_input && typeof input.tool_input === 'object'
    ? input.tool_input as Record<string, unknown>
    : {};
  return String(toolInput.command ?? toolInput.cmd ?? 'shell output');
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
  if (safe === raw && raw.length <= triggerChars) return undefined;

  const replacement = safe !== raw && safe.length <= triggerChars
    ? `[Google Surf output guard] Sensitive values and control sequences were removed. Source output was not stored.\n${safe}`
    : `[Google Surf output guard]\n${formatRerankedOutput(rerankOutput(
      commandFrom(input),
      safe,
      { max_chars: maxChars },
    ))}`;
  return { decision: 'block', reason: replacement.slice(0, maxChars) };
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
