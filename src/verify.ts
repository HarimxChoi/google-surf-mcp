import type { GeometricVerification, BBox } from './types.js';

export interface VerifyArgs {
  blockSelector: string;
  organicLeftRatio?: number;
  headerYMin?: number;
  adSelectors?: string;
  sidebarSelectors?: string;
}

export function verifyResultsGeometricInBrowser(args: VerifyArgs): GeometricVerification[] {
  const {
    blockSelector,
    organicLeftRatio = 0.65,
    headerYMin = 100,
    adSelectors = '#tads, #tadsb, #bottomads',
    sidebarSelectors = '#rhs, .kp-wholepage',
  } = args;

  const vw = (typeof window !== 'undefined' && window.innerWidth) || 1366;

  const adRegion = document.querySelector(adSelectors);
  const adRect = adRegion?.getBoundingClientRect();
  const rightSidebar = document.querySelector(sidebarSelectors);
  const sidebarRect = rightSidebar?.getBoundingClientRect();

  const blocks = document.querySelectorAll(blockSelector);
  const verifications: GeometricVerification[] = [];

  blocks.forEach((block, i) => {
    const rect = block.getBoundingClientRect();
    const bbox: BBox = { x: rect.x, y: rect.y, w: rect.width, h: rect.height };

    const inOrganicRegion =
      rect.left < vw * organicLeftRatio &&
      rect.left > 30 &&
      rect.top > headerYMin;

    const overlapsAdRegion = adRect ? !(
      rect.bottom < adRect.top || rect.top > adRect.bottom ||
      rect.right < adRect.left || rect.left > adRect.right
    ) : false;

    const overlapsRightSidebar = sidebarRect ? !(
      rect.right < sidebarRect.left
    ) : (rect.left > vw * organicLeftRatio);

    const hasH3 = !!block.querySelector('h3');
    const hasExternalLink = !!Array.from(block.querySelectorAll('a[href^="http"]')).find((a) => {
      try {
        const host = new URL((a as HTMLAnchorElement).href).hostname;
        return !host.includes('google.com');
      } catch { return false; }
    });

    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let matchesElementFromPoint = false;
    if (typeof document.elementFromPoint === 'function') {
      const el = document.elementFromPoint(cx, cy);
      matchesElementFromPoint = !!(el && (block.contains(el) || el.contains(block)));
    } else {
      // jsdom does not implement elementFromPoint
      matchesElementFromPoint = hasH3 && hasExternalLink;
    }

    const positives =
      (inOrganicRegion ? 0.3 : 0) +
      (hasH3 ? 0.2 : 0) +
      (hasExternalLink ? 0.2 : 0) +
      (matchesElementFromPoint ? 0.1 : 0) +
      0.2;
    const penalties =
      (overlapsAdRegion ? 0.6 : 0) +
      (overlapsRightSidebar ? 0.4 : 0);

    const confidence = Math.max(0, Math.min(1, positives - penalties));

    verifications.push({
      index: i,
      rect: bbox,
      signals: { inOrganicRegion, overlapsAdRegion, overlapsRightSidebar, matchesElementFromPoint, hasH3, hasExternalLink },
      confidence: Number(confidence.toFixed(3)),
    });
  });

  return verifications;
}

export function aggregateConfidence(verifications: GeometricVerification[]): number {
  if (verifications.length === 0) return 0;
  const sum = verifications.reduce((s, v) => s + v.confidence, 0);
  return Number((sum / verifications.length).toFixed(3));
}

export function isStale(verifications: GeometricVerification[], threshold = 0.5): boolean {
  if (verifications.length === 0) return true;
  return aggregateConfidence(verifications) < threshold;
}

export function regionStats(verifications: GeometricVerification[]): {
  organicRatio: number;
  adOverlapRatio: number;
  sidebarOverlapRatio: number;
} {
  if (verifications.length === 0) {
    return { organicRatio: 0, adOverlapRatio: 0, sidebarOverlapRatio: 0 };
  }
  const n = verifications.length;
  return {
    organicRatio: verifications.filter((v) => v.signals.inOrganicRegion).length / n,
    adOverlapRatio: verifications.filter((v) => v.signals.overlapsAdRegion).length / n,
    sidebarOverlapRatio: verifications.filter((v) => v.signals.overlapsRightSidebar).length / n,
  };
}
