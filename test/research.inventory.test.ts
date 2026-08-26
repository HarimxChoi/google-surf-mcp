import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyProjectPath, collectionIgnoreGlobs, containsSensitiveContent, experimentKey,
  isCollectionBoundary, isSensitivePath, queryTermsFromPath, searchableByPolicy,
} from '../src/research/inventory.js';
import { inventoryProject } from '../src/research/projectInventory.js';

describe('deterministic project inventory', () => {
  it('classifies evidence and artifacts from paths', () => {
    expect(classifyProjectPath('evidence/2026-08-24-run-prereg.json')).toBe('prereg');
    expect(classifyProjectPath('evidence/2026-08-24-run-result.json')).toBe('result');
    expect(classifyProjectPath('results/RUN-REPORT.md')).toBe('report');
    expect(classifyProjectPath('packages/model.safetensors')).toBe('checkpoint');
    expect(classifyProjectPath('.venv/site-packages/x.py')).toBe('cache');
  });

  it('pairs dated preregistration and result names', () => {
    expect(experimentKey('evidence/2026-08-24-run-prereg.json'))
      .toBe('evidence/run');
    expect(experimentKey('evidence/2026-08-24-run-result.json'))
      .toBe('evidence/run');
  });

  it('keeps dependency and generated trees as deterministic collections', () => {
    expect(isCollectionBoundary('.venv/Lib')).toBe(true);
    expect(isCollectionBoundary('hf-cache')).toBe(true);
    expect(isCollectionBoundary('llama.cpp-b10507')).toBe(true);
    expect(isCollectionBoundary('evidence/results')).toBe(false);
    expect(collectionIgnoreGlobs()).toContain('**/hf-cache/**');
  });

  it('keeps policy selection independent from generated summaries', () => {
    expect(searchableByPolicy('terminal_on_demand', 'prereg', false)).toBe(false);
    expect(searchableByPolicy('terminal_on_demand', 'result', false)).toBe(true);
    expect(searchableByPolicy('structured', 'config', false)).toBe(true);
    expect(searchableByPolicy('index_all', 'log', true)).toBe(true);
  });

  it('builds stable query terms from experiment paths', () => {
    expect(queryTermsFromPath('2026-08-24-llama3-native-iq3-result.json'))
      .toEqual(['llama3', 'native', 'iq3']);
  });

  it('inventories ignored files inside an explicit root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'surf-inventory-ignore-'));
    try {
      writeFileSync(join(root, '.gitignore'), 'ignored-result.json\n');
      writeFileSync(join(root, 'ignored-result.json'), '{"decision":"keep"}');
      const inventory = await inventoryProject({ roots: [{ label: 'repo', path: root }] });
      expect(inventory.records.map((record) => record.path)).toContain('ignored-result.json');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps conventional credential paths metadata-only', async () => {
    const root = mkdtempSync(join(tmpdir(), 'surf-inventory-secret-'));
    try {
      writeFileSync(join(root, 'credentials.json'), '{"api_key":"secret"}');
      const inventory = await inventoryProject({ roots: [{ label: 'repo', path: root }] });
      const record = inventory.records.find((entry) => entry.path === 'credentials.json');
      expect(isSensitivePath('config/service_account-prod.json')).toBe(true);
      expect(record).toMatchObject({ sensitive: true, kind: 'config' });
      expect(record).not.toHaveProperty('text');
      expect(record).not.toHaveProperty('content_hash');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps files with high-confidence secret signatures metadata-only', async () => {
    const root = mkdtempSync(join(tmpdir(), 'surf-inventory-content-secret-'));
    try {
      const token = `ghp_${'a'.repeat(36)}`;
      writeFileSync(join(root, 'config.ts'), `export const token = '${token}';`);
      const inventory = await inventoryProject({ roots: [{ label: 'repo', path: root }] });
      const record = inventory.records.find((entry) => entry.path === 'config.ts');
      expect(containsSensitiveContent(token)).toBe(true);
      expect(record).toMatchObject({ sensitive: true, kind: 'source' });
      expect(record).not.toHaveProperty('text');
      expect(record).not.toHaveProperty('content_hash');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
