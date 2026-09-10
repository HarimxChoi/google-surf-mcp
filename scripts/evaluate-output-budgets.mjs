import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, mkdir, stat, writeFile, copyFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const implementationRoot = resolve(scriptRoot, existsSync(join(scriptRoot, 'implementation')) ? 'implementation' : '../build');
const { rerankOutput, sanitizeOutputText, formatRerankedOutput } = await import(pathToFileURL(join(implementationRoot, 'outputRerank.js')).href);
const { processOutputHook } = await import(pathToFileURL(join(implementationRoot, 'rerankOutput.js')).href);

const compact = (value) => value.replace(/\s+/g, '').replaceAll('"', '');
const digest = (value) => createHash('sha256').update(value).digest('hex');
const at = (value, pointer) => pointer.split('.').reduce((item, key) => item?.[key], value);
const manifestPath = resolve(process.argv[2]);
const output = resolve(process.argv[3]);
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const profiles = [
  ...[1_000, 1_500, 2_000, 3_000, 6_000].map((chars) => ({ id: `fixed-${chars}`, trigger: chars, budget: () => chars })),
  { id: 'adaptive-1000-3000', trigger: 1_000, budget: (current) => Math.min(3_000, Math.ceil(1_000 + (current - 2_000) / 2)) },
  { id: 'adaptive-1000-2000', trigger: 1_000, budget: (current) => Math.min(2_000, Math.ceil(1_000 + (current - 2_000) / 2)) },
  { id: 'records-adaptive-1000-2000', trigger: 1_000, recordSignal: true, budget: (current) => Math.min(2_000, Math.ceil(1_000 + (current - 1_500) * 2 / 3)) },
  { id: 'adaptive-1500-3000', trigger: 1_500, budget: (current) => Math.min(3_000, Math.ceil(1_500 + (current - 2_000) * 0.75)) },
  { id: 'current-2000-6000', trigger: 2_000, budget: (current) => current },
  { id: 'implementation-adaptive', trigger: 1_500, native: true, budget: (current) => current },
  ...[3_000, 6_000].map((chars) => ({ id: `diagnostic-${chars}-no-block-limit`, trigger: chars, budget: () => chars, maxBlocks: Number.MAX_SAFE_INTEGER })),
];

const cases = [];
const rows = [];
for (const fixture of manifest.cases) {
  const bytes = await readFile(fixture.path);
  if (fixture.expected_digest && fixture.expected_digest !== digest(bytes)) throw new Error(`Changed frozen input: ${fixture.id}`);
  const raw = bytes.toString('utf8');
  if (sanitizeOutputText(raw) !== raw) throw new Error(`Fixture needs separate redaction accounting: ${fixture.id}`);
  const parsed = fixture.checks.some((check) => check.json) ? JSON.parse(raw) : undefined;
  const checks = fixture.checks.map((check) => {
    let witness = check.text;
    if (check.json) {
      const value = at(parsed, check.json);
      if (value === undefined) throw new Error(`Unknown pointer ${fixture.id}: ${check.json}`);
      witness = `${check.json.split('.').at(-1)}: ${JSON.stringify(value)}`;
    }
    if (!compact(raw).includes(compact(witness))) throw new Error(`Missing input witness ${fixture.id}: ${check.label}`);
    return { ...check, witness };
  });
  const sourceStat = await stat(fixture.path);
  const current = rerankOutput(fixture.query, raw);
  const referenceBudget = fixture.reference_budget_chars ?? current.meta.response_budget_chars;
  cases.push({ id: fixture.id, query: fixture.query, source_path: fixture.path, source_bytes: bytes.length,
    source_chars: raw.length, source_mtime: sourceStat.mtime.toISOString(), source_digest: digest(bytes),
    checks, current_budget: referenceBudget, source_scope: fixture.scope });
  for (const profile of profiles) {
    const budget = profile.native ? current.meta.response_budget_chars : profile.budget(profile.recordSignal ? current.meta.response_budget_chars : referenceBudget);
    const times = [];
    let response;
    for (let trial = 0; trial < 5; trial++) {
      const start = performance.now();
      if (profile.maxBlocks && raw.length >= profile.trigger) {
        const prefix = '[Google Surf output guard] Exit code: 0.\n';
        const ranked = rerankOutput(fixture.query, raw, { max_chars: budget, max_blocks: profile.maxBlocks, output_prefix: prefix });
        response = { decision: 'block', reason: (ranked.rendered ?? `${prefix}${formatRerankedOutput(ranked)}`).slice(0, budget) };
      } else {
        response = await processOutputHook({ tool_name: 'Bash', tool_input: { command: fixture.query },
          tool_response: { output: raw, exit_code: 0 } }, { trigger_chars: profile.trigger, ...(profile.native ? {} : { max_chars: budget }) });
      }
      times.push(performance.now() - start);
    }
    const displayed = response ? String(response.reason) : raw;
    const found = checks.filter((check) => compact(displayed).includes(compact(check.witness))).map((check) => check.label);
    const missing = checks.filter((check) => !found.includes(check.label)).map((check) => check.label);
    const ranked = response ? rerankOutput(fixture.query, raw, { max_chars: budget,
      max_blocks: profile.maxBlocks, output_prefix: '[Google Surf output guard] Exit code: 0.\n' }) : undefined;
    const structured = ranked?.meta.selection === 'evidence_records' && ranked.rendered === displayed;
    const pathChecks = checks.filter(check => check.json);
    const bound = structured ? pathChecks.filter(check => {
      const parent = 'input#' + check.json.split('.').slice(0, -1).map(key => '/' + key.replaceAll('~', '~0').replaceAll('/', '~1')).join('');
      return ranked.results.some(row => row.locator === parent && compact(row.text).includes(compact(check.witness)));
    }).map(check => check.label) : [];
    const dependenciesPresent = structured ? ranked.results.every(row => row.context_indices.every(id =>
      ranked.results.some(other => other.source_index === id))) : undefined;
    rows.push({ case_id: fixture.id, profile: profile.id, budget_chars: budget, trigger_chars: profile.trigger,
      intercepted: Boolean(response), output_chars: displayed.length, output_bytes: Buffer.byteLength(displayed),
      source_chars: raw.length, retained_witnesses: found, missing_witnesses: missing, all_witnesses_retained: missing.length === 0,
      retained: found.length, total: checks.length, median_ms: times.sort((a, b) => a - b)[2],
      source_bound_checks: pathChecks.length, source_bound_retained: bound,
      association_check_applicable: structured, emitted_dependencies_present: dependenciesPresent,
      displayed });
  }
  if (digest(await readFile(fixture.path)) !== digest(bytes)) throw new Error(`Source changed during test: ${fixture.id}`);
}
const aggregate = profiles.map((profile) => {
  const matches = rows.filter((row) => row.profile === profile.id);
  const retained = matches.reduce((sum, row) => sum + row.retained, 0);
  const total = matches.reduce((sum, row) => sum + row.total, 0);
  const category = Object.fromEntries([...new Set(cases.flatMap((item) => item.checks.map((check) => check.kind)))].map((kind) => {
    let count = 0;
    let kept = 0;
    for (const item of cases) {
      const row = matches.find((match) => match.case_id === item.id);
      for (const check of item.checks.filter((check) => check.kind === kind)) {
        count++;
        if (row.retained_witnesses.includes(check.label)) kept++;
      }
    }
    return [kind, { kept, total: count }];
  }));
  return { profile: profile.id, retained, total, coverage: retained / total,
    complete_cases: matches.filter((row) => row.all_witnesses_retained).length, cases: matches.length,
    total_output_chars: matches.reduce((sum, row) => sum + row.output_chars, 0), category };
});
const report = { schema: 'surf-output-budget-replay-v1', created_at: new Date().toISOString(),
  methodology: 'Paired replay of identical real WarpQuant source bodies. No model or GPU experiments. Same current reranker for all budgets. Checks are literal evidence witnesses, not semantic answer accuracy. Five local timing trials; source unchanged checks passed.',
  retrieval_scope: manifest.retrieval_scope, cases, aggregate, rows };
await mkdir(output, { recursive: false });
await writeFile(join(output, 'results.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
await writeFile(join(output, 'manifest.json'), JSON.stringify({ ...manifest,
  cases: manifest.cases.map((item) => ({ ...item, expected_digest: cases.find((row) => row.id === item.id).source_digest })) }, null, 2), { flag: 'wx' });
await mkdir(join(output, 'implementation'));
for (const name of ['outputRerank.js', 'rerankOutput.js', 'responseBudget.js', 'evidenceRecords.js'].filter(name => existsSync(join(implementationRoot, name)))) {
  await copyFile(join(implementationRoot, name), join(output, 'implementation', name));
}
await writeFile(join(output, 'implementation', 'package.json'), '{"type":"module"}\n', { flag: 'wx' });
await copyFile(fileURLToPath(import.meta.url), join(output, 'evaluate-output-budgets.mjs'));
console.log(JSON.stringify({ output, sources: cases.length, comparisons: rows.length,
  rows: aggregate.map(({ profile, retained, total, complete_cases, cases, total_output_chars }) => ({ profile, retained, total, complete_cases, cases, total_output_chars })) }));
