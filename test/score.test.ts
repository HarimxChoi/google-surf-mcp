import { describe, it, expect } from 'vitest';
import { scoreResult, filterOrganic, aggregateScores, getAdMarker } from '../src/score.js';
import type { SearchResult, GeometricVerification } from '../src/types.js';

const baseResult: SearchResult = {
  title: 'Example Article',
  url: 'https://example.com/article',
  description: 'This is a meaningful description with enough length',
};

const goodGeometry: GeometricVerification = {
  index: 0,
  rect: { x: 100, y: 200, w: 600, h: 80 },
  signals: {
    inOrganicRegion: true,
    overlapsAdRegion: false,
    overlapsRightSidebar: false,
    matchesElementFromPoint: true,
    hasH3: true,
    hasExternalLink: true,
  },
  confidence: 0.9,
};

describe('scoreResult', () => {
  it('classifies clean organic result with high confidence', () => {
    const score = scoreResult(baseResult, goodGeometry, { locale: 'en-US' });
    expect(score.classification).toBe('organic');
    expect(score.confidence).toBe('high');
    expect(score.overall).toBeGreaterThan(0.7);
    expect(score.ad_likelihood).toBeLessThan(0.2);
  });

  it('classifies geometric ad-region overlap as sponsored', () => {
    const adGeom = { ...goodGeometry, signals: { ...goodGeometry.signals, overlapsAdRegion: true } };
    const score = scoreResult(baseResult, adGeom, { locale: 'en-US' });
    expect(score.classification).toBe('sponsored');
    expect(score.overall).toBeLessThan(0.3);
  });

  it('classifies right sidebar as knowledge_panel', () => {
    const kpGeom = {
      ...goodGeometry,
      signals: { ...goodGeometry.signals, overlapsRightSidebar: true, inOrganicRegion: false },
    };
    const score = scoreResult(baseResult, kpGeom, { locale: 'en-US' });
    expect(score.classification).toBe('knowledge_panel');
  });

  it('multi-locale ad detection: Korean', () => {
    const r = { ...baseResult, title: '광고 - Sample Brand' };
    const score = scoreResult(r, goodGeometry, { locale: 'ko-KR' });
    expect(score.classification).toBe('sponsored');
  });

  it('multi-locale ad detection: Japanese', () => {
    const r = { ...baseResult, description: '広告: Sample product' };
    const score = scoreResult(r, goodGeometry, { locale: 'ja-JP' });
    expect(score.classification).toBe('sponsored');
  });

  it('multi-locale ad detection: French sponsorisé', () => {
    const r = { ...baseResult, title: 'sponsorisé Example' };
    const score = scoreResult(r, goodGeometry, { locale: 'fr-FR' });
    expect(score.classification).toBe('sponsored');
  });

  it('multi-locale ad detection: German Anzeige', () => {
    const r = { ...baseResult, title: 'Anzeige · Example' };
    const score = scoreResult(r, goodGeometry, { locale: 'de-DE' });
    expect(score.classification).toBe('sponsored');
  });

  it('multi-locale ad detection: Spanish Anuncio', () => {
    const r = { ...baseResult, description: 'Anuncio: Sample' };
    const score = scoreResult(r, goodGeometry, { locale: 'es-ES' });
    expect(score.classification).toBe('sponsored');
  });

  it('multi-locale ad detection: Chinese 广告', () => {
    const r = { ...baseResult, title: '广告 - 样品' };
    const score = scoreResult(r, goodGeometry, { locale: 'zh-CN' });
    expect(score.classification).toBe('sponsored');
  });

  it('falls back to en marker for unknown locale', () => {
    const r = { ...baseResult, title: 'Sponsored - Example' };
    const score = scoreResult(r, goodGeometry, { locale: 'xx-YY' });
    expect(score.classification).toBe('sponsored');
  });

  it('handles missing geometric (textual-only) conservatively', () => {
    const score = scoreResult(baseResult, undefined, { locale: 'en-US' });
    expect(score.classification).toBe('organic');
    expect(score.confidence).toBe('medium');
  });

  it('structural score reflects field completeness', () => {
    const incomplete = { title: '', url: 'https://x.com', description: '' };
    const score = scoreResult(incomplete, goodGeometry, { locale: 'en-US' });
    expect(score.structural).toBeLessThan(0.5);
  });
});

describe('filterOrganic', () => {
  it('keeps only organic + above threshold', () => {
    const results = [
      { id: 'a', score: { overall: 0.9, classification: 'organic' as const } as any },
      { id: 'b', score: { overall: 0.3, classification: 'organic' as const } as any },
      { id: 'c', score: { overall: 0.95, classification: 'sponsored' as const } as any },
      { id: 'd', score: { overall: 0.85, classification: 'organic' as const } as any },
    ];
    const filtered = filterOrganic(results, 0.5);
    expect(filtered.map(r => r.id)).toEqual(['a', 'd']);
  });
});

describe('aggregateScores', () => {
  it('returns 0 for empty input', () => {
    const agg = aggregateScores([]);
    expect(agg.meanOverall).toBe(0);
    expect(agg.organicRatio).toBe(0);
  });

  it('computes mean + organic ratio', () => {
    const scores = [
      { overall: 0.9, geometric: 0.8, classification: 'organic' as const, structural: 1, ad_likelihood: 0, confidence: 'high' as const },
      { overall: 0.5, geometric: 0.5, classification: 'organic' as const, structural: 1, ad_likelihood: 0, confidence: 'medium' as const },
      { overall: 0.2, geometric: 0.1, classification: 'sponsored' as const, structural: 1, ad_likelihood: 0.9, confidence: 'low' as const },
    ];
    const agg = aggregateScores(scores);
    expect(agg.meanOverall).toBeCloseTo(0.533, 2);
    expect(agg.organicRatio).toBeCloseTo(0.667, 2);
  });
});

describe('getAdMarker', () => {
  it('returns appropriate regex for each locale', () => {
    expect(getAdMarker('ko-KR').test('광고')).toBe(true);
    expect(getAdMarker('ja-JP').test('広告')).toBe(true);
    expect(getAdMarker('en-US').test('Sponsored')).toBe(true);
    expect(getAdMarker('en-US').test('normal text')).toBe(false);
  });

  it('falls back to en for unknown locale', () => {
    expect(getAdMarker('xx-YY').source).toBe(getAdMarker('en-US').source);
  });
});
