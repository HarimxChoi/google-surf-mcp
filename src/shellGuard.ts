import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

type HookInput = {
  session_id?: string;
  turn_id?: string;
  tool_name?: string;
  tool_input?: { command?: string; cmd?: string };
};

type SearchGroup = {
  signature: number[];
  count: number;
  max_terms: number;
};

type GuardState = {
  commands: Record<string, number>;
  search_groups: SearchGroup[];
  updated_at: number;
};

export type ShellGuardOptions = {
  state_root?: string;
  max_duplicates?: number;
  similarity?: number;
  fingerprint_salt?: string;
};

const SEARCH_STOPWORDS = new Set([
  'cat', 'find', 'findstr', 'format-list', 'format-table', 'get-childitem', 'get-content',
  'git', 'grep', 'head', 'jq', 'literalpath', 'max-count', 'maxdepth', 'name', 'noheader',
  'nounits', 'path', 'recurse', 'rg', 'ripgrep', 'select-object', 'select-string', 'sort-object',
  'tail', 'type', 'where-object',
]);

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function ratio(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0.5 && parsed <= 1 ? parsed : fallback;
}

function commandText(input: HookInput): string {
  return String(input.tool_input?.command ?? input.tool_input?.cmd ?? '');
}

function stateKey(input: HookInput): string {
  const turn = input.turn_id || `fallback-${Math.floor(Date.now() / (15 * 60 * 1000))}`;
  return createHash('sha256').update(`${input.session_id || 'unknown'}\0${turn}`).digest('hex');
}

function commandKey(command: string, salt = ''): string {
  const normalized = command.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  return createHash('sha256').update(`${salt}\0${normalized}`).digest('hex');
}

export function isSearchCommand(command: string): boolean {
  return /(?:^|[;&|]\s*|\s)(?:rg|ripgrep|grep|findstr)(?:\.exe)?\b/i.test(command)
    || /\bSelect-String\b/i.test(command)
    || /\bgit\s+(?:grep|log|show|diff)\b/i.test(command)
    || (/\bGet-ChildItem\b/i.test(command) && /\b(?:Where-Object|Select-String|-Recurse)\b/i.test(command));
}

export function isForegroundPolling(command: string): boolean {
  const sleeps = [
    ...command.matchAll(/\bStart-Sleep\b(?:\s+-Seconds)?\s+(\d+)/gi),
    ...command.matchAll(/(?:^|[;&|]\s*|\s)\bsleep\s+(\d+)(?:s)?\b/gi),
  ];
  if (sleeps.some((match) => Number(match[1]) >= 30)) return true;
  if (/\b(?:while|for|foreach|do)\b[\s\S]{0,3000}\b(?:Start-Sleep|sleep)\b/i.test(command)) return true;
  return [
    /\btail\b[^\r\n]*(?:\s-f\b|--follow\b)/i,
    /\bGet-Content\b[^\r\n]*\s-Wait\b/i,
    /(?:^|[;&|]\s*|\s)\bwatch(?:\.exe)?\b/i,
    /\bWait-Process\b/i,
  ].some((pattern) => pattern.test(command));
}

export function searchTerms(command: string): string[] {
  const tokens = command.toLocaleLowerCase()
    .replace(/\\/g, '/')
    .match(/[\p{L}\p{N}_./:-]{2,}/gu) ?? [];
  return [...new Set(tokens
    .map((token) => token.replace(/^[-./:]+|[-./:]+$/g, ''))
    .filter((token) => token.length >= 2 && !/^\d+$/.test(token) && !SEARCH_STOPWORDS.has(token)))];
}

export function minHashSignature(tokens: string[], size = 16, salt = ''): number[] {
  if (!tokens.length) return [];
  return Array.from({ length: size }, (_, seed) => {
    let minimum = 0xffffffff;
    for (const token of tokens) {
      const digest = createHash('sha256').update(`${salt}\0${seed}\0${token}`).digest();
      minimum = Math.min(minimum, digest.readUInt32BE(0));
    }
    return minimum;
  });
}

export function signatureSimilarity(left: number[], right: number[]): number {
  if (!left.length || left.length !== right.length) return 0;
  let equal = 0;
  for (let index = 0; index < left.length; index++) {
    if (left[index] === right[index]) equal += 1;
  }
  return equal / left.length;
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
  throw new Error('shell guard state is busy');
}

async function atomicJson(path: string, value: GuardState): Promise<void> {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, path);
}

function defaultState(): GuardState {
  return { commands: {}, search_groups: [], updated_at: 0 };
}

export async function guardShellInput(
  input: HookInput,
  options: ShellGuardOptions = {},
): Promise<string | undefined> {
  if (input.tool_name !== 'Bash') return undefined;
  const command = commandText(input);
  if (!command.trim()) return undefined;
  if (isForegroundPolling(command)) {
    return 'Long-running foreground polling is blocked. Use a host-managed background job and inspect one bounded final result.';
  }

  const maxDuplicates = options.max_duplicates
    ?? positiveInteger(process.env.SURF_HOST_MAX_DUPLICATES, 2);
  const similarity = options.similarity
    ?? ratio(process.env.SURF_HOST_SEARCH_SIMILARITY, 0.85);
  const fingerprintSalt = options.fingerprint_salt
    ?? process.env.SURF_HOST_FINGERPRINT_SALT
    ?? '';
  const stateRoot = options.state_root
    ?? join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'hooks', 'state', 'google-surf-shell');
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const path = join(stateRoot, `${stateKey(input)}.json`);
  const lock = `${path}.lock`;
  await acquireLock(lock);
  try {
    let state = defaultState();
    try {
      state = { ...state, ...JSON.parse(await readFile(path, 'utf8')) as GuardState };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const searchCommand = isSearchCommand(command);
    const exactKey = commandKey(command, fingerprintSalt);
    const duplicateCount = Number(state.commands[exactKey] ?? 0);
    if (searchCommand && duplicateCount >= maxDuplicates) {
      return `The same shell command already ran ${maxDuplicates} times in this turn. Reuse its result or change the retrieval strategy.`;
    }

    const tokens = searchCommand ? searchTerms(command) : [];
    const signature = minHashSignature(tokens, 16, fingerprintSalt);
    let matchedGroup: SearchGroup | undefined;
    if (signature.length) {
      matchedGroup = state.search_groups.find((group) => (
        signatureSimilarity(signature, group.signature) >= similarity
      ));
      const materiallyRefined = matchedGroup && tokens.length >= matchedGroup.max_terms + 2;
      if (matchedGroup && !materiallyRefined && matchedGroup.count >= maxDuplicates) {
        return `A near-duplicate shell search already ran ${maxDuplicates} times in this turn. Reuse the previous result or narrow the query or path.`;
      }
      if (materiallyRefined) matchedGroup = undefined;
    }

    if (searchCommand) state.commands[exactKey] = duplicateCount + 1;
    if (signature.length) {
      if (matchedGroup) {
        matchedGroup.count += 1;
        matchedGroup.max_terms = Math.max(matchedGroup.max_terms, tokens.length);
      } else {
        state.search_groups.push({ signature, count: 1, max_terms: tokens.length });
      }
    }
    state.search_groups = state.search_groups.slice(-24);
    state.updated_at = Date.now();
    await atomicJson(path, state);
    return undefined;
  } finally {
    await unlink(lock).catch(() => {});
  }
}
