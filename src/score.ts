import type { SearchResult, ResultScore, ResultClassification, GeometricVerification } from './types.js';

// A marker must look like a SERP label, or it hits ordinary vocabulary:
// "Google Ads API docs" and ordinary CJK phrases. CJK has no \b, hence the
// explicit separator class.
const AD_MARKERS_BY_LOCALE: Record<string, RegExp> = {
  en: /\b(sponsored|advertisement)\b|(?:^|\s)ads?(?:\s*[\u00B7\u2022\u2027\u25BE\-\u2014]|\s*$)/i,
  ko: /(?:^|\s)(\uAD11\uACE0|\uC2A4\uD3F0\uC11C)(?:\s*[\u00B7\u2022\u2027\u25BE:\uFF1A\-\u2014]|\s*$)/,
  ja: /(?:^|\s)(\u5E83\u544A|\u30B9\u30DD\u30F3\u30B5\u30FC)(?:\s*[\u00B7\u2022\u2027\u25BE:\uFF1A\-\u2014]|\s*$)/,
  zh: /(?:^|\s)(\u5E7F\u544A|\u8D5E\u52A9|\u5EE3\u544A)(?:\s*[\u00B7\u2022\u2027\u25BE:\uFF1A\-\u2014]|\s*$)/,
  fr: /(\u0073\u0070\u006F\u006E\u0073\u006F\u0072\u0069\u0073\u00E9|\u0061\u006E\u006E\u006F\u006E\u0063\u0065)/i,
  de: /(\u0061\u006E\u007A\u0065\u0069\u0067\u0065|\u0067\u0065\u0073\u0070\u006F\u006E\u0073\u0065\u0072\u0074)/i,
  es: /(\u0061\u006E\u0075\u006E\u0063\u0069\u006F|\u0070\u0061\u0074\u0072\u006F\u0063\u0069\u006E\u0061\u0064\u006F)/i,
  pt: /(\u0070\u0061\u0074\u0072\u006F\u0063\u0069\u006E\u0061\u0064\u006F|\u0061\u006E\u00FA\u006E\u0063\u0069\u006F)/i,
};

// fr/de/es/pt markers are unanchored, so never adopt them from a page we did
// not configure ourselves.
const LABEL_ANCHORED = new Set(['en', 'ko', 'ja', 'zh']);

export interface ScoreContext {
  locale: string;
  layoutSig?: string;
}

export function getAdMarker(locale: string): RegExp {
  const lang = locale.split('-')[0].toLowerCase();
  return AD_MARKERS_BY_LOCALE[lang] || AD_MARKERS_BY_LOCALE.en;
}

export function markerLocaleFor(serpLang: string, configuredLocale: string): string {
  const lang = serpLang.split('-')[0].toLowerCase();
  return LABEL_ANCHORED.has(lang) ? serpLang : configuredLocale;
}

function classify(
  result: SearchResult,
  geometric: GeometricVerification | undefined,
  context: ScoreContext,
): { classification: ResultClassification; ad_likelihood: number } {
  const adRegex = getAdMarker(context.locale);
  const titleHasAdMarker = adRegex.test(result.title);
  const descHasAdMarker = adRegex.test(result.description);

  if (geometric?.signals.overlapsAdRegion) {
    return { classification: 'sponsored', ad_likelihood: 0.95 };
  }
  if (titleHasAdMarker || descHasAdMarker) {
    return { classification: 'sponsored', ad_likelihood: 0.8 };
  }

  if (geometric?.signals.overlapsRightSidebar) {
    return { classification: 'knowledge_panel', ad_likelihood: 0.05 };
  }

  if (geometric && !geometric.signals.hasH3 && result.description.length < 50) {
    return { classification: 'related', ad_likelihood: 0.1 };
  }

  if (
    geometric?.signals.inOrganicRegion &&
    geometric.signals.hasH3 &&
    geometric.signals.hasExternalLink
  ) {
    return { classification: 'organic', ad_likelihood: 0.05 };
  }

  if (!geometric) {
    return { classification: 'organic', ad_likelihood: 0.1 };
  }

  return { classification: 'unknown', ad_likelihood: 0.3 };
}

export function scoreResult(
  result: SearchResult,
  geometric: GeometricVerification | undefined,
  context: ScoreContext,
): ResultScore {
  const { classification, ad_likelihood } = classify(result, geometric, context);

  let structural = 0;
  if (result.title.length > 0) structural += 0.3;
  if (result.url.startsWith('http')) structural += 0.3;
  if (result.description.length > 20) structural += 0.4;

  const geometricScore = geometric?.confidence ?? 0.5;

  let overall = (geometricScore * 0.5) + (structural * 0.5);
  if (classification === 'sponsored') overall *= 0.2;
  if (classification === 'knowledge_panel') overall *= 0.6;
  if (classification === 'related') overall *= 0.5;
  // Only boost organic when geometric verification confirms it.
  if (classification === 'organic' && geometric !== undefined) {
    overall = Math.min(1, overall * 1.1);
  }

  let confidenceLabel: 'low' | 'medium' | 'high';
  if (overall >= 0.8) confidenceLabel = 'high';
  else if (overall >= 0.5) confidenceLabel = 'medium';
  else confidenceLabel = 'low';

  return {
    overall: Number(overall.toFixed(3)),
    geometric: Number(geometricScore.toFixed(3)),
    structural: Number(structural.toFixed(3)),
    ad_likelihood: Number(ad_likelihood.toFixed(3)),
    classification,
    confidence: confidenceLabel,
  };
}

export function filterOrganic<T extends { score: ResultScore }>(
  results: T[],
  minOverall = 0.5,
): T[] {
  return results.filter(
    (r) => r.score.classification === 'organic' && r.score.overall >= minOverall,
  );
}

export function aggregateScores(scores: ResultScore[]): {
  meanOverall: number;
  meanGeometric: number;
  organicRatio: number;
} {
  if (scores.length === 0) return { meanOverall: 0, meanGeometric: 0, organicRatio: 0 };
  const meanOverall = scores.reduce((s, x) => s + x.overall, 0) / scores.length;
  const meanGeometric = scores.reduce((s, x) => s + x.geometric, 0) / scores.length;
  const organicCount = scores.filter((x) => x.classification === 'organic').length;
  return {
    meanOverall: Number(meanOverall.toFixed(3)),
    meanGeometric: Number(meanGeometric.toFixed(3)),
    organicRatio: Number((organicCount / scores.length).toFixed(3)),
  };
}
