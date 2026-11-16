import { describe, expect, it } from 'vitest';
import { DOCUMENT_SETTING_KEYS, documentOcrSettings } from '../src/documentSettings.js';

describe('shared document OCR settings', () => {
  it.each([
    [undefined, 'off'], ['false', 'off'], ['invalid', 'off'], ['true', 'enabled'], ['TRUE', 'enabled'], ['auto', 'auto'],
  ])('reads %s consistently for PDF, images and configuration', (value, policy) => {
    expect(documentOcrSettings({ SURF_EXTRACT_OCR: value })).toEqual({ policy, language: 'eng' });
  });

  it('uses the same language and setting allowlist across worker requests', () => {
    expect(documentOcrSettings({ SURF_EXTRACT_OCR: 'auto', SURF_EXTRACT_OCR_LANGUAGE: ' eng+kor ' }))
      .toEqual({ policy: 'auto', language: 'eng+kor' });
    expect(new Set(DOCUMENT_SETTING_KEYS).size).toBe(4);
    expect(DOCUMENT_SETTING_KEYS).toContain('SURF_EXTRACT_OFFICE_PARSER');
  });
});
