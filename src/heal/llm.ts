const SYSTEM_PROMPT = `You are a CSS-selector repair agent for a Google SERP parser.
Given (a) compressed HTML of a SERP page (b) the current broken selectors and
(c) candidate selectors from deterministic synthesis, your job is to either
APPROVE one of the candidates or PROPOSE a better one.

Rules:
- Selectors must be valid CSS (no :has-text, no XPath).
- Prefer stable attribute selectors ([data-ved], [jscontroller]) over class names
  which Google randomizes per quarter.
- Must skip ads inside #tads, #tadsb, #bottomads, [data-text-ad].
- Each result must have an h3 (title) and a[href^="http"] (link).

Output STRICT JSON, no prose:
{
  "decision": "approve_candidate" | "propose_new",
  "selector": "<CSS selector>",
  "rationale": "<1-2 sentences>",
  "confidence": "low" | "medium" | "high",
  "expected_min_blocks": <number>
}`;

export interface LLMRepairInput {
  compressedHtml: string;
  brokenSelectors: { block: string; snippet: string };
  candidates: Array<{ blockSelector: string; source: string; rationale: string }>;
}

export interface LLMRepairOutput {
  decision: 'approve_candidate' | 'propose_new';
  selector: string;
  rationale: string;
  confidence: 'low' | 'medium' | 'high';
  expected_min_blocks: number;
}

export async function repairWithLLM(input: LLMRepairInput): Promise<LLMRepairOutput> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // Mock path for tests and CI without an API key.
    if (input.candidates.length > 0) {
      return {
        decision: 'approve_candidate',
        selector: input.candidates[0].blockSelector,
        rationale: '[mock] no API key, defaulting to first candidate',
        confidence: 'low',
        expected_min_blocks: 5,
      };
    }
    return {
      decision: 'propose_new',
      selector: '[data-ved] h3',
      rationale: '[mock] fallback to data-ved anchor',
      confidence: 'low',
      expected_min_blocks: 5,
    };
  }

  // Optional peer dep: only required when ANTHROPIC_API_KEY is set.
  let Anthropic: any;
  try {
    // @ts-expect-error optional peer dep
    const mod = await import('@anthropic-ai/sdk');
    Anthropic = mod.default;
  } catch {
    throw new Error('ANTHROPIC_API_KEY set but @anthropic-ai/sdk not installed (run: npm install @anthropic-ai/sdk)');
  }

  const client = new Anthropic({ apiKey });
  const userMsg = JSON.stringify({
    broken: input.brokenSelectors,
    candidates: input.candidates,
    html: input.compressedHtml,
  });

  const resp = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        // Explicit ttl: default 5min would yield 0% cache hit on daily cron.
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
    ],
    messages: [{ role: 'user', content: userMsg }],
  });

  const block = resp.content[0];
  if (block.type !== 'text') throw new Error('unexpected response shape');
  return JSON.parse(block.text) as LLMRepairOutput;
}

export function compressSerpHtml(html: string, maxBytes = 100_000): string {
  if (html.length <= maxBytes) return html;
  return html.slice(0, maxBytes);
}
