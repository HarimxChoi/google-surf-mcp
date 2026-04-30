import { describe, it, expect } from 'vitest';
import { isBlocked } from '../src/browser.js';

describe('isBlocked', () => {
  it('flags /sorry/ URLs as blocked', () => {
    expect(isBlocked('https://www.google.com/sorry/index?continue=foo')).toBe(true);
    expect(isBlocked('https://www.google.com/sorry/?q=bar')).toBe(true);
  });

  it('does not flag normal search URLs', () => {
    expect(isBlocked('https://www.google.com/search?q=foo')).toBe(false);
    expect(isBlocked('https://www.google.com/')).toBe(false);
    expect(isBlocked('')).toBe(false);
  });
});
