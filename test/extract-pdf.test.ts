import { describe, it, expect } from 'vitest';
import { isPdfMagic, isPdfContentType } from '../src/extract-pdf.js';

describe('isPdfMagic', () => {
  it('detects the %PDF signature', () => {
    const buf = Buffer.from('%PDF-1.4\n...', 'binary');
    expect(isPdfMagic(buf)).toBe(true);
  });

  it('rejects HTML start', () => {
    expect(isPdfMagic(Buffer.from('<!DOCTYPE html>'))).toBe(false);
    expect(isPdfMagic(Buffer.from('<html>'))).toBe(false);
  });

  it('rejects buffers shorter than 4 bytes', () => {
    expect(isPdfMagic(Buffer.from(''))).toBe(false);
    expect(isPdfMagic(Buffer.from('%PD'))).toBe(false);
  });

  it('works with Uint8Array', () => {
    expect(isPdfMagic(new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBe(true);
    expect(isPdfMagic(new Uint8Array([0x00, 0x00, 0x00, 0x00]))).toBe(false);
  });
});

describe('isPdfContentType', () => {
  it('accepts application/pdf', () => {
    expect(isPdfContentType('application/pdf')).toBe(true);
  });

  it('accepts application/pdf with charset', () => {
    expect(isPdfContentType('application/pdf; charset=binary')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isPdfContentType('Application/PDF')).toBe(true);
  });

  it('rejects html', () => {
    expect(isPdfContentType('text/html')).toBe(false);
    expect(isPdfContentType('text/html; charset=utf-8')).toBe(false);
  });

  it('handles null/undefined/empty', () => {
    expect(isPdfContentType(null)).toBe(false);
    expect(isPdfContentType(undefined)).toBe(false);
    expect(isPdfContentType('')).toBe(false);
  });
});
