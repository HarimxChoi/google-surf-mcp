import { describe, expect, it } from 'vitest';
import { entityId, normalizeEntityName } from '../src/research/entities.js';

describe('entity name normalization', () => {
  it('keeps searchable text after Markdown heading markers', () => {
    expect(normalizeEntityName('# Fictional Cedar model')).toBe('fictional cedar model');
    expect(normalizeEntityName('## Table conditions')).toBe('table conditions');
  });

  it('does not treat punctuation in ordinary names as URL fragments', () => {
    expect(normalizeEntityName('Trial #2')).toBe('trial 2');
    expect(normalizeEntityName('Question? Follow-up')).toBe('question follow-up');
  });

  it('preserves existing URL and ordinary-name identities', () => {
    expect(normalizeEntityName('HTTPS://www.Example.com/Paper?q=1#part')).toBe('example.com/paper');
    expect(normalizeEntityName('Cedar model')).toBe('cedar model');
    expect(entityId('project', 'model', normalizeEntityName('Cedar model')))
      .toBe(entityId('project', 'model', 'cedar model'));
  });
});
