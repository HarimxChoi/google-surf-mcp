import { describe, expect, it } from 'vitest';
import {
  buildGoogleSearchUrl, buildNativeChromeArgs, buildScholarSearchUrl,
} from '../src/nativeBrowser.js';

describe('native Chrome search route', () => {
  it('builds direct Google and Scholar URLs without changing operators', () => {
    const google = new URL(buildGoogleSearchUrl('site:github.com filetype:md graph rag', 20, 'ko-KR'));
    const scholar = new URL(buildScholarSearchUrl('graph rag lineage', 10, 'en-US'));

    expect(google.hostname).toBe('www.google.com');
    expect(google.searchParams.get('q')).toBe('site:github.com filetype:md graph rag');
    expect(google.searchParams.get('num')).toBe('20');
    expect(google.searchParams.get('hl')).toBe('ko');
    expect(scholar.hostname).toBe('scholar.google.com');
    expect(scholar.searchParams.get('q')).toBe('graph rag lineage');
    expect(scholar.searchParams.get('hl')).toBe('en');
  });

  it('uses a dedicated profile and fixed local debugging port with minimal flags', () => {
    const args = buildNativeChromeArgs('C:\\surf\\native', 9223, 'https://www.google.com/search?q=test');
    const joined = args.join(' ');

    expect(args).toContain('--user-data-dir=C:\\surf\\native');
    expect(args).toContain('--remote-debugging-port=9223');
    expect(args).toContain('--remote-debugging-address=127.0.0.1');
    expect(args).toContain('--start-minimized');
    expect(args).not.toContain('--new-window');
    expect(joined).not.toMatch(/headless|no-sandbox|AutomationControlled|enable-automation/i);
  });

  it('rejects port zero', () => {
    expect(() => buildNativeChromeArgs('profile', 0, 'https://www.google.com/'))
      .toThrow('fixed non-zero port');
  });
});
