#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatRerankedOutput, rerankOutput, responseText, sanitizeOutputText } from './outputRerank.js';

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
    ?? positiveInteger(process.env.SURF_RERANK_TRIGGER_CHARS, 1_500);
  const configuredMax = options.max_chars ?? positiveInteger(process.env.SURF_RERANK_MAX_CHARS, 0);
  const maxChars = Number.isFinite(configuredMax) && configuredMax > 0 ? Math.floor(configuredMax) : undefined;
  if (safe === raw && raw.length < triggerChars) return undefined;

  const result = input.tool_response && typeof input.tool_response === 'object'
    ? input.tool_response as Record<string, unknown> : {};
  const exitCode = typeof result.exit_code === 'number' && Number.isFinite(result.exit_code)
    ? ` Exit code: ${result.exit_code}.` : '';
  const prefix = `[Google Surf output guard]${exitCode}\n`;
  const ranked = rerankOutput(commandFrom(input), safe, { max_chars: maxChars, output_prefix: prefix });
  const replacement = safe !== raw && safe.length <= triggerChars
    ? `[Google Surf output guard]${exitCode} Sensitive values and control sequences were removed. Source output was not stored.\n${safe}`
    : ranked.rendered ?? `${prefix}${formatRerankedOutput(ranked)}`;
  return { continue: false, stopReason: replacement.slice(0, maxChars ?? ranked.meta.response_budget_chars) };
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
