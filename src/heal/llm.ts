// Workflow-only. Default-off: requires SURF_LLM_HEAL=true + ANTHROPIC_API_KEY.

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

Call the submit_selector_repair tool with your decision.`;

const REPAIR_TOOL = {
  name: 'submit_selector_repair',
  description: 'Submit the chosen selector repair decision.',
  input_schema: {
    type: 'object',
    properties: {
      decision: { type: 'string', enum: ['approve_candidate', 'propose_new'] },
      selector: { type: 'string', description: 'CSS selector to use for SERP result blocks' },
      rationale: { type: 'string', description: '1-2 sentences explaining the choice' },
      confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
      expected_min_blocks: { type: 'number', description: 'Expected minimum block count' },
    },
    required: ['decision', 'selector', 'rationale', 'confidence', 'expected_min_blocks'],
  },
} as const;

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

function mockRepair(input: LLMRepairInput, reason: string): LLMRepairOutput {
  if (input.candidates.length > 0) {
    return {
      decision: 'approve_candidate',
      selector: input.candidates[0].blockSelector,
      rationale: `[mock] ${reason}, defaulting to first candidate`,
      confidence: 'low',
      expected_min_blocks: 5,
    };
  }
  return {
    decision: 'propose_new',
    selector: '[data-ved] h3',
    rationale: `[mock] ${reason}, fallback to data-ved anchor`,
    confidence: 'low',
    expected_min_blocks: 5,
  };
}

export async function repairWithLLM(input: LLMRepairInput): Promise<LLMRepairOutput> {
  const optedIn = process.env.SURF_LLM_HEAL === 'true';
  if (!optedIn) {
    return mockRepair(input, 'SURF_LLM_HEAL not enabled');
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return mockRepair(input, 'no API key');
  }

  let Anthropic: any;
  try {
    // dynamic specifier: optional peer dep, may not be installed
    const sdkName = '@anthropic-ai/sdk';
    const mod = await import(sdkName);
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
    tools: [REPAIR_TOOL],
    tool_choice: { type: 'tool', name: REPAIR_TOOL.name },
    messages: [{ role: 'user', content: userMsg }],
  });

  const toolUse = resp.content.find((b: { type: string }) => b.type === 'tool_use');
  if (!toolUse) throw new Error('expected tool_use response, got: ' + JSON.stringify(resp.content.map((b: { type: string }) => b.type)));
  return (toolUse as { input: LLMRepairOutput }).input;
}

export function compressSerpHtml(html: string, maxBytes = 100_000): string {
  if (html.length <= maxBytes) return html;
  return html.slice(0, maxBytes);
}
