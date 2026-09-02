// Workflow-only. Default-off: requires SURF_LLM_HEAL=true and a provider API key.

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

type LLMProvider = 'anthropic' | 'orcarouter';

function selectedProvider(): LLMProvider {
  const value = process.env.SURF_LLM_PROVIDER?.trim().toLowerCase() || 'anthropic';
  if (value === 'anthropic' || value === 'orcarouter') return value;
  throw new Error(`unsupported SURF_LLM_PROVIDER: ${value}`);
}

function parseRepairOutput(value: unknown): LLMRepairOutput {
  if (!value || typeof value !== 'object') throw new Error('invalid selector repair output');
  const output = value as Record<string, unknown>;
  if ((output.decision !== 'approve_candidate' && output.decision !== 'propose_new')
    || typeof output.selector !== 'string'
    || typeof output.rationale !== 'string'
    || !['low', 'medium', 'high'].includes(String(output.confidence))
    || typeof output.expected_min_blocks !== 'number'
    || !Number.isFinite(output.expected_min_blocks)) {
    throw new Error('invalid selector repair output');
  }
  return output as unknown as LLMRepairOutput;
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

async function repairWithAnthropic(
  input: LLMRepairInput,
  apiKey: string,
  model: string,
): Promise<LLMRepairOutput> {
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

  // No cache_control: the prompt is below the minimum cacheable prefix, and the
  // cron calls this once a day.
  const resp = await client.messages.create({
    model,
    max_tokens: 1024,
    system: [{ type: 'text', text: SYSTEM_PROMPT }],
    tools: [REPAIR_TOOL],
    tool_choice: { type: 'tool', name: REPAIR_TOOL.name },
    messages: [{ role: 'user', content: userMsg }],
  });

  const toolUse = resp.content.find((b: { type: string }) => b.type === 'tool_use');
  if (!toolUse) throw new Error('expected tool_use response, got: ' + JSON.stringify(resp.content.map((b: { type: string }) => b.type)));
  return parseRepairOutput((toolUse as { input: unknown }).input);
}

async function repairWithOrcaRouter(
  input: LLMRepairInput,
  apiKey: string,
  model: string,
): Promise<LLMRepairOutput> {
  const response = await fetch('https://api.orcarouter.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: JSON.stringify({
            broken: input.brokenSelectors,
            candidates: input.candidates,
            html: input.compressedHtml,
          }),
        },
      ],
      tools: [{
        type: 'function',
        function: {
          name: REPAIR_TOOL.name,
          description: REPAIR_TOOL.description,
          parameters: REPAIR_TOOL.input_schema,
        },
      }],
      tool_choice: { type: 'function', function: { name: REPAIR_TOOL.name } },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    const body = (await response.text()).replaceAll(apiKey, '[redacted]').slice(0, 2_000);
    throw new Error(`OrcaRouter request failed (${response.status}): ${body}`);
  }
  const payload = await response.json() as {
    choices?: Array<{
      message?: {
        tool_calls?: Array<{ function?: { name?: string; arguments?: string | Record<string, unknown> } }>;
      };
    }>;
  };
  const call = payload.choices?.[0]?.message?.tool_calls?.find(
    (candidate) => candidate.function?.name === REPAIR_TOOL.name,
  );
  const args = call?.function?.arguments;
  if (!args) throw new Error('expected OrcaRouter tool call response');
  return parseRepairOutput(typeof args === 'string' ? JSON.parse(args) : args);
}

export async function repairWithLLM(input: LLMRepairInput): Promise<LLMRepairOutput> {
  if (process.env.SURF_LLM_HEAL !== 'true') {
    return mockRepair(input, 'SURF_LLM_HEAL not enabled');
  }
  const provider = selectedProvider();
  if (provider === 'orcarouter') {
    const apiKey = process.env.ORCAROUTER_API_KEY?.trim() || process.env.ORCA_KEY?.trim();
    if (!apiKey) return mockRepair(input, 'no API key');
    return await repairWithOrcaRouter(
      input,
      apiKey,
      process.env.SURF_LLM_MODEL?.trim() || 'orcarouter/auto',
    );
  }
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return mockRepair(input, 'no API key');
  return await repairWithAnthropic(
    input,
    apiKey,
    process.env.SURF_LLM_MODEL?.trim() || 'claude-sonnet-4-6',
  );
}

export function compressSerpHtml(html: string, maxBytes = 100_000): string {
  if (html.length <= maxBytes) return html;
  return html.slice(0, maxBytes);
}
