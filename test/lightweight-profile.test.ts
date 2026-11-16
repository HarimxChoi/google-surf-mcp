import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const profile = Object.fromEntries(readFileSync(new URL('../examples/lightweight-documents.env', import.meta.url), 'utf8')
  .split(/\r?\n/).filter(line => line && !line.startsWith('#')).map(line => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));

describe('lightweight document profile', () => {
  it('selects CPU OCR and native Office without an external vision model', () => {
    expect(profile.SURF_EXTRACT_OCR).toBe('auto');
    expect(profile.SURF_EXTRACT_OCR_LANGUAGE).toBe('eng+kor');
    expect(profile.SURF_EXTRACT_OFFICE_PARSER).toBe('auto');
    expect(Object.keys(profile).some(key => key.includes('API_KEY'))).toBe(false);
  });

  it('uses the existing low-memory E5 and hybrid retrieval path', () => {
    const config = loadConfig(profile);
    expect(config.researchEnabled).toBe(true);
    expect(config.researchRetrievalMode).toBe('hybrid');
    expect(config.researchVectorModel).toBe('Xenova/multilingual-e5-small');
    expect(config.researchVectorLowMemory).toBe(true);
    expect(config.researchVectorThreads).toBe(2);
    expect(config.researchVectorBatchSize).toBe(2);
    expect(config.researchVectorBackend).toBe('hnsw');
  });
});
