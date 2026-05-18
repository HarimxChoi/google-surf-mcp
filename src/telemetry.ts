import { existsSync, mkdirSync } from 'node:fs';
import { appendFile, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export type TelemetryEventType =
  | 'search.outcome'
  | 'parse.stale'
  | 'cache.hit'
  | 'cache.miss'
  | 'tool.error';

export interface TelemetryEvent {
  ts: string;
  type: TelemetryEventType;
  data: Record<string, unknown>;
}

export interface TelemetryOptions {
  // Injected for deterministic tests (date rotation, rolling windows).
  now?: () => Date;
  // Hard cap on a single jsonl line to stay within POSIX atomic-append guarantees.
  maxLineBytes?: number;
}

export interface QueryFilter {
  type?: TelemetryEventType;
  // Rolling window: events whose ts is within (now - sinceDays*86400_000, now].
  sinceDays?: number;
}

const DEFAULT_MAX_LINE_BYTES = 4096;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export class Telemetry {
  private readonly now: () => Date;
  private readonly maxLineBytes: number;

  constructor(
    private readonly root: string,
    private readonly enabled: boolean,
    options: TelemetryOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    if (this.enabled && !existsSync(this.root)) {
      try {
        mkdirSync(this.root, { recursive: true });
      } catch {
        // Directory creation failure must not break the caller; record() will
        // silently no-op on subsequent writes.
      }
    }
  }

  // Append a single event. Never throws — telemetry is best-effort.
  async record(type: TelemetryEventType, data: Record<string, unknown>): Promise<void> {
    if (!this.enabled) return;

    const event: TelemetryEvent = {
      ts: this.now().toISOString(),
      type,
      data,
    };

    let line: string;
    try {
      line = JSON.stringify(event);
    } catch {
      // Circular references or non-serializable values land here.
      return;
    }

    // Stay within POSIX atomic-write bounds so concurrent writers don't
    // interleave a partial line.
    if (Buffer.byteLength(line, 'utf8') > this.maxLineBytes) {
      const truncated: TelemetryEvent = {
        ts: event.ts,
        type: event.type,
        data: { _truncated: true, _originalType: type },
      };
      try {
        line = JSON.stringify(truncated);
      } catch {
        return;
      }
    }

    try {
      await appendFile(this.filePath(event.ts), line + '\n', 'utf-8');
    } catch {
      // Disk full, permissions, etc. Telemetry is not on the critical path.
    }
  }

  async query(filter: QueryFilter = {}): Promise<TelemetryEvent[]> {
    if (!this.enabled) return [];

    const files = await this.candidateFiles(filter.sinceDays);
    const cutoff = filter.sinceDays !== undefined
      ? this.now().getTime() - filter.sinceDays * MS_PER_DAY
      : null;

    const out: TelemetryEvent[] = [];
    for (const file of files) {
      const events = await this.readFile(file);
      for (const ev of events) {
        if (filter.type !== undefined && ev.type !== filter.type) continue;
        if (cutoff !== null) {
          const t = Date.parse(ev.ts);
          if (!Number.isFinite(t) || t <= cutoff) continue;
        }
        out.push(ev);
      }
    }
    return out;
  }

  async percentile(
    type: TelemetryEventType,
    field: string,
    p: number,
    options: { sinceDays?: number } = {},
  ): Promise<number | null> {
    const values = await this.numericValues(type, field, options.sinceDays);
    if (values.length === 0) return null;
    values.sort((a, b) => a - b);
    const idx = Math.min(values.length - 1, Math.max(0, Math.floor(p * values.length)));
    return values[idx];
  }

  async movingAverage(
    type: TelemetryEventType,
    field: string,
    options: { sinceDays?: number } = {},
  ): Promise<number | null> {
    const values = await this.numericValues(type, field, options.sinceDays);
    if (values.length === 0) return null;
    const sum = values.reduce((a, b) => a + b, 0);
    return sum / values.length;
  }

  async ewma(
    type: TelemetryEventType,
    field: string,
    options: { alpha?: number; sinceDays?: number } = {},
  ): Promise<number | null> {
    const alpha = options.alpha ?? 0.3;
    const events = await this.query({ type, sinceDays: options.sinceDays });
    // EWMA is order-dependent; process oldest → newest.
    events.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    let current: number | null = null;
    for (const ev of events) {
      const v = ev.data[field];
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      current = current === null ? v : alpha * v + (1 - alpha) * current;
    }
    return current;
  }

  async size(): Promise<{ files: number; events: number }> {
    if (!this.enabled) return { files: 0, events: 0 };
    let files: string[];
    try {
      files = (await readdir(this.root)).filter((f) => f.endsWith('.jsonl'));
    } catch {
      return { files: 0, events: 0 };
    }
    let events = 0;
    for (const f of files) {
      const list = await this.readFile(join(this.root, f));
      events += list.length;
    }
    return { files: files.length, events };
  }

  private filePath(iso: string): string {
    // UTC day boundary, derived from the timestamp on the event itself.
    return join(this.root, `${iso.slice(0, 10)}.jsonl`);
  }

  private async candidateFiles(sinceDays?: number): Promise<string[]> {
    let files: string[];
    try {
      files = (await readdir(this.root)).filter((f) => f.endsWith('.jsonl'));
    } catch {
      return [];
    }
    if (sinceDays === undefined) {
      return files.map((f) => join(this.root, f));
    }
    // Pre-filter by filename. A rolling 24h window crosses 2 UTC days at most;
    // include sinceDays + 1 most-recent files so the time-cutoff catches edges.
    files.sort();
    const keep = files.slice(-(Math.ceil(sinceDays) + 1));
    return keep.map((f) => join(this.root, f));
  }

  private async readFile(path: string): Promise<TelemetryEvent[]> {
    let raw: string;
    try {
      raw = await readFile(path, 'utf-8');
    } catch {
      return [];
    }
    const out: TelemetryEvent[] = [];
    const lines = raw.split('\n');
    for (const line of lines) {
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        if (
          obj && typeof obj === 'object' &&
          typeof obj.ts === 'string' &&
          typeof obj.type === 'string' &&
          obj.data && typeof obj.data === 'object'
        ) {
          out.push(obj as TelemetryEvent);
        }
      } catch {
        // Skip corrupted line; do not let one bad record poison the query.
        console.error(`[telemetry] skipping corrupted line in ${path}`);
      }
    }
    return out;
  }

  private async numericValues(
    type: TelemetryEventType,
    field: string,
    sinceDays?: number,
  ): Promise<number[]> {
    const events = await this.query({ type, sinceDays });
    const out: number[] = [];
    for (const ev of events) {
      const v = ev.data[field];
      if (typeof v === 'number' && Number.isFinite(v)) out.push(v);
    }
    return out;
  }
}

let _instance: Telemetry | null = null;

export function getTelemetry(
  root: string,
  enabled: boolean,
  options?: TelemetryOptions,
): Telemetry {
  if (!_instance) {
    _instance = new Telemetry(resolve(root), enabled, options);
  }
  return _instance;
}

export function _resetTelemetry(): void {
  _instance = null;
}