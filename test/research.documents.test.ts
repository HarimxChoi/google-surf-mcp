import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectSourceEntryRecord } from '../src/research/contracts.js';
import { inventoryProject, inventoryProjectIncremental } from '../src/research/projectInventory.js';

const fake = vi.hoisted(() => ({ read: vi.fn(), fingerprint: 'reader-v1', active: 0, peak: 0 }));
vi.mock('../src/documentReader.js', () => ({ documentParserFingerprint: () => fake.fingerprint,
  readBinaryDocument: fake.read }));
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'surf-document-inventory-'));
  fake.fingerprint = 'reader-v1'; fake.active = fake.peak = 0;
  fake.read.mockReset().mockImplementation(async () => {
    fake.peak = Math.max(fake.peak, ++fake.active);
    await new Promise(resolve => setTimeout(resolve, 2)); fake.active--;
    return { url: '', content: 'Native context is 8192.', extraction_quality: 'full_text' };
  });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function stored(record: Awaited<ReturnType<typeof inventoryProject>>['records'][number]): ProjectSourceEntryRecord {
  const { id, text: _text, ...rest } = record;
  return { ...rest, entry_id: id, project_id: 'documents', searchable: true };
}

describe('approved-root binary document inventory', () => {
  it('parses documents sequentially and separates original bytes from searchable text', async () => {
    for (const name of ['one.docx', 'two.pptx', 'three.hwpx']) writeFileSync(join(root, name), 'source bytes');
    const inventory = await inventoryProject({ roots: [{ label: 'docs', path: root }] });
    expect(fake.peak).toBe(1);
    expect(fake.read).toHaveBeenCalledTimes(3);
    const record = inventory.records[0];
    expect(record.kind).toBe('report');
    expect(record.source_hash).toBe(createHash('sha256').update('source bytes').digest('hex'));
    expect(record.content_hash).toBe(createHash('sha256').update(record.text!).digest('hex'));
    expect(record.source_hash).not.toBe(record.content_hash);
    expect(record.text_bytes).toBe(Buffer.byteLength(record.text!));
  });
  it('reuses stored bodies on a full rescan but reparses changed bytes or parser settings', async () => {
    writeFileSync(join(root, 'one.pdf'), 'same original');
    const roots = [{ label: 'docs', path: root }];
    const first = await inventoryProject({ roots });
    const current = first.records.map(stored);
    const second = await inventoryProject({ roots, current });
    expect(fake.read).toHaveBeenCalledTimes(1);
    expect(second.records[0].text).toBeUndefined();
    expect(second.records[0].searchable).toBe(true);
    expect(second.digest).toBe(first.digest);
    fake.fingerprint = 'reader-v2';
    await inventoryProject({ roots, current });
    expect(fake.read).toHaveBeenCalledTimes(2);
    fake.fingerprint = 'reader-v1';
    writeFileSync(join(root, 'one.pdf'), 'different bytes');
    const third = await inventoryProject({ roots, current });
    expect(fake.read).toHaveBeenCalledTimes(3);
    expect(third.digest).not.toBe(first.digest);
  });
  it('preserves the same reuse and provenance contract for explicit path deltas', async () => {
    writeFileSync(join(root, 'one.pdf'), 'same original');
    const roots = [{ label: 'docs', path: root }];
    const first = await inventoryProject({ roots });
    const delta = await inventoryProjectIncremental({ roots, current: first.records.map(stored),
      changed_paths: [{ root: 'docs', path: 'one.pdf' }], removed_paths: [] });
    expect(fake.read).toHaveBeenCalledTimes(1);
    expect(delta.records[0].source_hash).toBe(first.records[0].source_hash);
    expect(delta.digest).toBe(first.digest);
  });
  it('keeps extraction failures local and never stores recognized secret text', async () => {
    writeFileSync(join(root, 'bad.docx'), 'broken');
    writeFileSync(join(root, 'secret.pdf'), 'secret bytes');
    fake.read.mockImplementation(async (bytes: Uint8Array) => Buffer.from(bytes).toString() === 'broken'
      ? { error: 'invalid archive', extraction_quality: 'metadata_only' }
      : { content: `ghp_${'a'.repeat(36)}`, extraction_quality: 'full_text' });
    const inventory = await inventoryProject({ roots: [{ label: 'docs', path: root }] });
    const bad = inventory.records.find(r => r.path === 'bad.docx')!;
    const secret = inventory.records.find(r => r.path === 'secret.pdf')!;
    expect(bad).toMatchObject({ unreadable: true, extraction_error: 'invalid archive' });
    expect(secret.sensitive).toBe(true);
    expect(secret.text).toBeUndefined();
    expect(secret.content_hash).toBeUndefined();
    expect(secret.source_hash).toBeUndefined();
  });
});
