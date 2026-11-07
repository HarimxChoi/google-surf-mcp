export const EXTRACTION_QUALITIES = ['full_text', 'abstract', 'meta_abstract', 'metadata_only', 'thin_text', 'navigation_only', 'blocked', 'consent_required'] as const;
export type ExtractionQuality = typeof EXTRACTION_QUALITIES[number];
export function usableEvidence(quality: unknown): boolean {
  return !['metadata_only', 'navigation_only', 'blocked', 'consent_required'].includes(String(quality));
}

export function classifyExtractedText(title: string, text: string, linkRatio = 0): {
  extraction_quality: ExtractionQuality;
  quality_reason?: string;
} {
  const challengeTitle = /^(?:just a moment|access denied|attention required|verify (?:you are|that you)|security check|robot check)/i.test(title.trim());
  if (challengeTitle && /cloudflare|captcha|verify|blocked|access denied|human|checking your browser/i.test(text)) {
    return { extraction_quality: 'blocked', quality_reason: 'challenge_page' };
  }
  if (/before you continue|consent required|privacy choices/i.test(title) && /accept all|reject all|agree|consent/i.test(text)) {
    return { extraction_quality: 'consent_required', quality_reason: 'consent_page' };
  }
  if (text.trim().length < 80) return { extraction_quality: 'thin_text', quality_reason: 'short_body' };
  if (linkRatio > .8 && text.length < 3000) return { extraction_quality: 'navigation_only', quality_reason: 'link_dominated_body' };
  return { extraction_quality: 'full_text' };
}
