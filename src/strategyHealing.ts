import { existsSync, mkdirSync } from 'node:fs';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface StrategyStat {
  wins: number;
  zeros: number;
  losses: number;
  lastWinAt: string | null;
}

export interface PersistedState {
  schema: 1;
  stats: Record<string, StrategyStat>;
}

const WIN_MARGIN_FOR_REORDER = 3;
const FLUSH_DEBOUNCE_MS = 5_000;

function emptyStat(): StrategyStat {
  return { wins: 0, zeros: 0, losses: 0, lastWinAt: null };
}

function score(s: StrategyStat): number {
  return s.wins * 10 - s.zeros;
}

function pickLatestIso(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

export class StrategyHealing {
  private state: PersistedState = { schema: 1, stats: {} };
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private loaded = false;

  constructor(
    private readonly file: string,
    private readonly enabled: boolean,
    private readonly knownIds: readonly string[],
    private readonly flushDebounceMs: number = FLUSH_DEBOUNCE_MS,
  ) {
    if (this.enabled) {
      const dir = dirname(this.file);
      if (!existsSync(dir)) {
        try { mkdirSync(dir, { recursive: true }); } catch {}
      }
    }
  }

  async load(): Promise<void> {
    if (!this.enabled || this.loaded) {
      this.loaded = true;
      return;
    }
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedState>;
      if (parsed && parsed.schema === 1 && parsed.stats && typeof parsed.stats === 'object') {
        const accepted: Record<string, StrategyStat> = {};
        for (const id of this.knownIds) {
          const s = parsed.stats[id];
          if (s && typeof s.wins === 'number' && typeof s.zeros === 'number') {
            accepted[id] = {
              wins: Math.max(0, s.wins | 0),
              zeros: Math.max(0, s.zeros | 0),
              losses: Math.max(0, (s.losses ?? 0) | 0),
              lastWinAt: typeof s.lastWinAt === 'string' ? s.lastWinAt : null,
            };
          }
        }
        // sum (not overwrite): preserves outcomes recorded during async load
        const merged: Record<string, StrategyStat> = { ...accepted };
        for (const [id, live] of Object.entries(this.state.stats)) {
          const persisted = merged[id];
          if (!persisted) {
            merged[id] = live;
            continue;
          }
          merged[id] = {
            wins: persisted.wins + live.wins,
            zeros: persisted.zeros + live.zeros,
            losses: persisted.losses + live.losses,
            lastWinAt: pickLatestIso(persisted.lastWinAt, live.lastWinAt),
          };
        }
        this.state.stats = merged;
      }
    } catch {}
    this.loaded = true;
  }

  recordOutcome(id: string, kind: 'win' | 'loss' | 'zero'): void {
    if (!this.enabled) return;
    const s = this.state.stats[id] ?? (this.state.stats[id] = emptyStat());
    if (kind === 'win') {
      s.wins += 1;
      s.lastWinAt = new Date().toISOString();
    } else if (kind === 'zero') {
      s.zeros += 1;
    } else {
      s.losses += 1;
    }
    this.scheduleFlush();
  }

  getOrderedStrategyIds(defaultOrder: readonly string[]): string[] {
    if (!this.enabled) return [...defaultOrder];
    const withScore = defaultOrder.map((id, idx) => {
      const s = this.state.stats[id];
      return {
        id,
        score: s ? score(s) : 0,
        idx,
        lastWinAt: s?.lastWinAt ?? null,
      };
    });

    const sortedByScore = [...withScore].sort((a, b) => b.score - a.score);
    const top = sortedByScore[0];
    const second = sortedByScore[1];
    if (!top || !second) return [...defaultOrder];
    // wins (not score) so the margin holds independent of zero penalties
    const topWins = this.state.stats[top.id]?.wins ?? 0;
    const secondWins = this.state.stats[second.id]?.wins ?? 0;
    if (topWins - secondWins < WIN_MARGIN_FOR_REORDER) {
      return [...defaultOrder];
    }

    withScore.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const at = a.lastWinAt ? Date.parse(a.lastWinAt) : 0;
      const bt = b.lastWinAt ? Date.parse(b.lastWinAt) : 0;
      if (at !== bt) return bt - at;
      return a.idx - b.idx;
    });
    return withScore.map((w) => w.id);
  }

  getStats(): Record<string, StrategyStat> {
    const out: Record<string, StrategyStat> = {};
    for (const [k, v] of Object.entries(this.state.stats)) out[k] = { ...v };
    return out;
  }

  async flush(): Promise<void> {
    if (!this.enabled || !this.dirty) return;
    const tmp = `${this.file}.tmp`;
    const payload = JSON.stringify(this.state, null, 2);
    try {
      await writeFile(tmp, payload, 'utf8');
      await rename(tmp, this.file);
      this.dirty = false; // only clear on success → next flush retries on failure
    } catch {}
  }

  shutdown(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private scheduleFlush(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush().catch(() => {});
    }, this.flushDebounceMs);
    // unref: pending flush must not block SIGTERM
    const t = this.flushTimer as unknown as { unref?: () => void };
    t.unref?.();
  }
}

let _instance: StrategyHealing | null = null;
let _instanceFile: string | null = null;

export function getStrategyHealing(
  file: string,
  enabled: boolean,
  knownIds: readonly string[],
): StrategyHealing {
  if (!_instance) {
    _instance = new StrategyHealing(file, enabled, knownIds);
    _instanceFile = file;
  } else if (_instanceFile !== file) {
    console.error(
      `[strategyHealing] getStrategyHealing called with mismatched file (${_instanceFile} → ${file}); returning original instance`,
    );
  }
  return _instance;
}

export function _resetStrategyHealing(): void {
  _instance?.shutdown();
  _instance = null;
  _instanceFile = null;
}

export function defaultHealingPath(profileRoot: string): string {
  return join(profileRoot, '.heal', 'strategy-order.json');
}
