export interface SynthesizedCandidate {
  blockSelector: string;
  blockXPath: string;
  source: 'data-ved' | 'jscontroller' | 'data-hveid' | 'class-fallback';
  rationale: string;
}

const STABLE_ATTR_PRIORITY: Array<{
  attr: string;
  selector: (val: string) => string;
  xpath: (val: string) => string;
  source: SynthesizedCandidate['source'];
}> = [
  {
    attr: 'data-ved',
    selector: () => '[data-ved]',
    xpath: () => '//*[@data-ved]',
    source: 'data-ved',
  },
  {
    attr: 'jscontroller',
    selector: () => 'div[jscontroller]',
    xpath: () => '//div[@jscontroller]',
    source: 'jscontroller',
  },
  {
    attr: 'data-hveid',
    selector: () => 'div[data-hveid]',
    xpath: () => '//div[@data-hveid]',
    source: 'data-hveid',
  },
];

export interface CandidateElement {
  tag: string;
  attributes: Record<string, string>;
  ancestorAttributes: Array<Record<string, string>>;
  textPreview: string;
  hasH3: boolean;
  hasExternalLink: boolean;
}

export function synthesizeFromCandidate(candidate: CandidateElement): SynthesizedCandidate[] {
  const out: SynthesizedCandidate[] = [];
  const allAttrs = [candidate.attributes, ...candidate.ancestorAttributes];

  for (const priority of STABLE_ATTR_PRIORITY) {
    const found = allAttrs.find((a) => a.hasOwnProperty(priority.attr));
    if (found) {
      out.push({
        blockSelector: priority.selector(found[priority.attr]),
        blockXPath: priority.xpath(found[priority.attr]),
        source: priority.source,
        rationale: `Found stable ${priority.attr} on element or ancestor (h3=${candidate.hasH3}, externalLink=${candidate.hasExternalLink})`,
      });
    }
  }

  const cls = candidate.attributes.class;
  if (cls && !out.length) {
    const tokens = cls.split(/\s+/).filter((t) => t.length >= 4 && /^[a-zA-Z]/.test(t));
    if (tokens.length > 0) {
      const t = tokens.sort((a, b) => b.length - a.length)[0];
      out.push({
        blockSelector: `${candidate.tag}.${t}`,
        blockXPath: `//${candidate.tag}[contains(@class, "${t}")]`,
        source: 'class-fallback',
        rationale: `No stable attr found, using longest class token (less stable)`,
      });
    }
  }

  return out;
}

// Runs inside page.evaluate.
export function extractCandidatesInBrowser(args: { topN: number }): CandidateElement[] {
  const candidates: CandidateElement[] = [];
  const blocks = document.querySelectorAll('h3');
  let added = 0;
  blocks.forEach((h3) => {
    if (added >= args.topN) return;
    let block: Element | null = h3.parentElement;
    let depth = 0;
    while (block && depth < 5) {
      const a = block.querySelector('a[href^="http"]');
      if (a) {
        try {
          const url = new URL((a as HTMLAnchorElement).href);
          if (!url.hostname.includes('google.com')) break;
        } catch { /* */ }
      }
      block = block.parentElement;
      depth++;
    }
    if (!block) return;

    const attrs: Record<string, string> = {};
    Array.from(block.attributes).forEach((a) => { attrs[a.name] = a.value; });

    const ancestorAttrs: Array<Record<string, string>> = [];
    let parent = block.parentElement;
    for (let i = 0; i < 3 && parent; i++) {
      const aa: Record<string, string> = {};
      Array.from(parent.attributes).forEach((a) => { aa[a.name] = a.value; });
      ancestorAttrs.push(aa);
      parent = parent.parentElement;
    }

    const externalLink = !!Array.from(block.querySelectorAll('a[href^="http"]')).find((a) => {
      try { return !new URL((a as HTMLAnchorElement).href).hostname.includes('google.com'); }
      catch { return false; }
    });

    candidates.push({
      tag: block.tagName.toLowerCase(),
      attributes: attrs,
      ancestorAttributes: ancestorAttrs,
      textPreview: (block.textContent || '').slice(0, 200),
      hasH3: true,
      hasExternalLink: externalLink,
    });
    added++;
  });
  return candidates;
}
