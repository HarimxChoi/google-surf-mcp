import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Telemetry, _resetTelemetry, getTelemetry } from '../src/telemetry.js';

describe('Telemetry', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'surf-telemetry-test-'));
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
        _resetTelemetry();
    });

    describe('opt-in (enabled flag)', () => {
        it('does not create the root directory when disabled', () => {
            const path = join(tmpDir, 'should-not-exist');
            new Telemetry(path, false);
            expect(existsSync(path)).toBe(false);
        });

        it('record is a no-op when disabled (no files written)', async () => {
            const path = join(tmpDir, 'tele');
            const tel = new Telemetry(path, false);
            await tel.record('search.outcome', { resultsLen: 5 });
            expect(existsSync(path)).toBe(false);
        });

        it('query returns empty array when disabled, even if files exist', async () => {
            writeFileSync(
                join(tmpDir, '2026-05-16.jsonl'),
                JSON.stringify({ ts: '2026-05-16T10:00:00Z', type: 'search.outcome', data: { resultsLen: 5 } }) + '\n',
            );
            const tel = new Telemetry(tmpDir, false);
            const events = await tel.query();
            expect(events).toEqual([]);
        });

        it('size returns zero counts when disabled', async () => {
            const tel = new Telemetry(tmpDir, false);
            expect(await tel.size()).toEqual({ files: 0, events: 0 });
        });
    });

    describe('record()', () => {
        it('appends one line per call to the UTC-dated file', async () => {
            const tel = new Telemetry(tmpDir, true, {
                now: () => new Date('2026-05-16T10:00:00Z'),
            });
            await tel.record('search.outcome', { resultsLen: 5 });
            await tel.record('search.outcome', { resultsLen: 7 });

            const file = join(tmpDir, '2026-05-16.jsonl');
            const lines = readFileSync(file, 'utf-8').trim().split('\n');
            expect(lines).toHaveLength(2);
            const first = JSON.parse(lines[0]);
            expect(first).toMatchObject({
                type: 'search.outcome',
                data: { resultsLen: 5 },
            });
            expect(first.ts).toBe('2026-05-16T10:00:00.000Z');
        });

        it('rotates files across UTC day boundaries', async () => {
            let now = new Date('2026-05-16T23:59:59Z');
            const tel = new Telemetry(tmpDir, true, { now: () => now });
            await tel.record('search.outcome', { resultsLen: 1 });

            now = new Date('2026-05-17T00:00:01Z');
            await tel.record('search.outcome', { resultsLen: 2 });

            const files = readdirSync(tmpDir).sort();
            expect(files).toEqual(['2026-05-16.jsonl', '2026-05-17.jsonl']);
        });

        it('never throws on circular data (silently drops)', async () => {
            const tel = new Telemetry(tmpDir, true);
            const circular: Record<string, unknown> = {};
            circular.self = circular;
            await expect(tel.record('tool.error', circular)).resolves.toBeUndefined();
        });

        it('never throws when the underlying directory is inaccessible', async () => {
            const tel = new Telemetry(join(tmpDir, 'nonexistent', 'deep'), true);
            // Constructor may have failed to mkdir; record() must still resolve.
            await expect(tel.record('cache.hit', { namespace: 'search' })).resolves.toBeUndefined();
        });

        it('truncates lines that exceed maxLineBytes and marks _truncated', async () => {
            const tel = new Telemetry(tmpDir, true, {
                now: () => new Date('2026-05-16T10:00:00Z'),
                maxLineBytes: 200,
            });
            const huge = { payload: 'x'.repeat(1000) };
            await tel.record('search.outcome', huge);

            const file = join(tmpDir, '2026-05-16.jsonl');
            const line = readFileSync(file, 'utf-8').trim();
            const parsed = JSON.parse(line);
            expect(parsed.data._truncated).toBe(true);
            expect(parsed.data._originalType).toBe('search.outcome');
            expect(parsed.type).toBe('search.outcome');
            expect(line.length).toBeLessThanOrEqual(200);
        });
    });

    describe('query()', () => {
        async function seed(tel: Telemetry) {
            // Two events on 05-15, two on 05-16. Two types.
            writeFileSync(
                join(tmpDir, '2026-05-15.jsonl'),
                [
                    JSON.stringify({ ts: '2026-05-15T08:00:00Z', type: 'search.outcome', data: { resultsLen: 10 } }),
                    JSON.stringify({ ts: '2026-05-15T20:00:00Z', type: 'cache.hit', data: { namespace: 'search' } }),
                ].join('\n') + '\n',
            );
            writeFileSync(
                join(tmpDir, '2026-05-16.jsonl'),
                [
                    JSON.stringify({ ts: '2026-05-16T03:00:00Z', type: 'search.outcome', data: { resultsLen: 8 } }),
                    JSON.stringify({ ts: '2026-05-16T10:00:00Z', type: 'cache.hit', data: { namespace: 'extract' } }),
                ].join('\n') + '\n',
            );
        }

        it('returns all events across all files with no filter', async () => {
            const tel = new Telemetry(tmpDir, true, { now: () => new Date('2026-05-16T12:00:00Z') });
            await seed(tel);
            const events = await tel.query();
            expect(events).toHaveLength(4);
        });

        it('filters by type', async () => {
            const tel = new Telemetry(tmpDir, true, { now: () => new Date('2026-05-16T12:00:00Z') });
            await seed(tel);
            const events = await tel.query({ type: 'cache.hit' });
            expect(events).toHaveLength(2);
            expect(events.every((e) => e.type === 'cache.hit')).toBe(true);
        });

        it('sinceDays applies a rolling window from now', async () => {
            // now=05-16 12:00. sinceDays=1 → cutoff=05-15 12:00.
            // Events before 05-15 12:00 are excluded; events after are kept.
            const tel = new Telemetry(tmpDir, true, { now: () => new Date('2026-05-16T12:00:00Z') });
            await seed(tel);
            const events = await tel.query({ sinceDays: 1 });
            const tsList = events.map((e) => e.ts).sort();
            expect(tsList).toEqual([
                '2026-05-15T20:00:00Z',
                '2026-05-16T03:00:00Z',
                '2026-05-16T10:00:00Z',
            ]);
        });

        it('skips corrupted lines but keeps the rest', async () => {
            const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            writeFileSync(
                join(tmpDir, '2026-05-16.jsonl'),
                [
                    JSON.stringify({ ts: '2026-05-16T01:00:00Z', type: 'search.outcome', data: { resultsLen: 1 } }),
                    '{ not valid json',
                    JSON.stringify({ ts: '2026-05-16T02:00:00Z', type: 'search.outcome', data: { resultsLen: 2 } }),
                ].join('\n') + '\n',
            );
            const tel = new Telemetry(tmpDir, true, { now: () => new Date('2026-05-16T12:00:00Z') });
            const events = await tel.query();
            expect(events).toHaveLength(2);
            expect(errSpy).toHaveBeenCalled();
            errSpy.mockRestore();
        });
    });

    describe('aggregates', () => {
        async function seedNumeric(tel: Telemetry) {
            writeFileSync(
                join(tmpDir, '2026-05-16.jsonl'),
                [
                    JSON.stringify({ ts: '2026-05-16T01:00:00Z', type: 'search.outcome', data: { resultsLen: 1 } }),
                    JSON.stringify({ ts: '2026-05-16T02:00:00Z', type: 'search.outcome', data: { resultsLen: 5 } }),
                    JSON.stringify({ ts: '2026-05-16T03:00:00Z', type: 'search.outcome', data: { resultsLen: 10 } }),
                    JSON.stringify({ ts: '2026-05-16T04:00:00Z', type: 'search.outcome', data: { resultsLen: 'bogus' } }),
                    JSON.stringify({ ts: '2026-05-16T05:00:00Z', type: 'search.outcome', data: { /* missing */ } }),
                ].join('\n') + '\n',
            );
        }

        it('percentile returns null when no data', async () => {
            const tel = new Telemetry(tmpDir, true);
            expect(await tel.percentile('search.outcome', 'resultsLen', 0.5)).toBeNull();
        });

        it('percentile ignores non-numeric and missing fields', async () => {
            const tel = new Telemetry(tmpDir, true, { now: () => new Date('2026-05-16T12:00:00Z') });
            await seedNumeric(tel);
            // 3 valid values: [1, 5, 10]. p=0.5 → index 1 → 5.
            expect(await tel.percentile('search.outcome', 'resultsLen', 0.5)).toBe(5);
            expect(await tel.percentile('search.outcome', 'resultsLen', 0.0)).toBe(1);
            expect(await tel.percentile('search.outcome', 'resultsLen', 0.99)).toBe(10);
        });

        it('movingAverage ignores invalid values', async () => {
            const tel = new Telemetry(tmpDir, true, { now: () => new Date('2026-05-16T12:00:00Z') });
            await seedNumeric(tel);
            // (1 + 5 + 10) / 3 = 5.333...
            const avg = await tel.movingAverage('search.outcome', 'resultsLen');
            expect(avg).toBeCloseTo(5.333, 2);
        });

        it('movingAverage returns null on empty', async () => {
            const tel = new Telemetry(tmpDir, true);
            expect(await tel.movingAverage('search.outcome', 'resultsLen')).toBeNull();
        });

        it('ewma processes events oldest → newest with configurable alpha', async () => {
            const tel = new Telemetry(tmpDir, true, { now: () => new Date('2026-05-16T12:00:00Z') });
            await seedNumeric(tel);
            // Values in time order: 1, 5, 10. alpha=0.5.
            // step1: 1
            // step2: 0.5*5 + 0.5*1 = 3
            // step3: 0.5*10 + 0.5*3 = 6.5
            const ewma = await tel.ewma('search.outcome', 'resultsLen', { alpha: 0.5 });
            expect(ewma).toBeCloseTo(6.5, 5);
        });

        it('ewma returns null when no numeric events', async () => {
            const tel = new Telemetry(tmpDir, true);
            expect(await tel.ewma('search.outcome', 'resultsLen')).toBeNull();
        });

        it('ewma default alpha is 0.3', async () => {
            const tel = new Telemetry(tmpDir, true, { now: () => new Date('2026-05-16T12:00:00Z') });
            await seedNumeric(tel);
            const ewma = await tel.ewma('search.outcome', 'resultsLen');
            expect(ewma).toBeCloseTo(4.54, 2);
        });
    });

    describe('size()', () => {
        it('counts files and total events across all jsonl files', async () => {
            writeFileSync(
                join(tmpDir, '2026-05-15.jsonl'),
                [
                    JSON.stringify({ ts: '2026-05-15T01:00:00Z', type: 'search.outcome', data: {} }),
                    JSON.stringify({ ts: '2026-05-15T02:00:00Z', type: 'cache.hit', data: {} }),
                ].join('\n') + '\n',
            );
            writeFileSync(
                join(tmpDir, '2026-05-16.jsonl'),
                JSON.stringify({ ts: '2026-05-16T01:00:00Z', type: 'tool.error', data: {} }) + '\n',
            );
            // Non-jsonl files must be ignored.
            writeFileSync(join(tmpDir, 'README.txt'), 'noise');

            const tel = new Telemetry(tmpDir, true);
            expect(await tel.size()).toEqual({ files: 2, events: 3 });
        });

        it('returns zero when root is empty', async () => {
            const tel = new Telemetry(tmpDir, true);
            expect(await tel.size()).toEqual({ files: 0, events: 0 });
        });
    });

    describe('getTelemetry singleton', () => {
        it('returns the same instance for repeated calls', () => {
            const a = getTelemetry(tmpDir, true);
            const b = getTelemetry(tmpDir, true);
            expect(a).toBe(b);
        });
    });
});