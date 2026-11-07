import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [mode, root, runtimePath] = process.argv.slice(2);
const model = 'revision-fixture/tiny-bert';
const revision = '761b726dd34fb83930e26aab4e9ac3899aa1fa78';
const cacheDir = join(root, 'selected-cache');
const defaultCache = join(root, 'unused-default-cache');
const pinned = join(cacheDir, model, revision);
const options = { revision, cache_dir: cacheDir, local_files_only: true, dtype: 'q8' };
const report = { fetches: [], model_loads: 0, model_calls: 0, disposals: 0, fixture_bytes: 0 };
const originalFetch = globalThis.fetch;
const denyFetch = async (input) => {
  const url = input instanceof Request ? input.url : String(input);
  report.fetches.push(url);
  throw new Error(`revision fixture forbids network: ${url}`);
};
globalThis.fetch = denyFetch;

const tokenizer = {
  version: '1.0', truncation: null, padding: null,
  added_tokens: ['[PAD]', '[UNK]', '[CLS]', '[SEP]'].map((content, id) => ({
    id, content, single_word: false, lstrip: false, rstrip: false, normalized: false, special: true,
  })),
  normalizer: { type: 'BertNormalizer', clean_text: true, handle_chinese_chars: true, strip_accents: null, lowercase: true },
  pre_tokenizer: { type: 'BertPreTokenizer' },
  post_processor: { type: 'BertProcessing', sep: ['[SEP]', 3], cls: ['[CLS]', 2] },
  decoder: { type: 'WordPiece', prefix: '##', cleanup: true },
  model: { type: 'WordPiece', unk_token: '[UNK]', continuing_subword_prefix: '##', max_input_chars_per_word: 100,
    vocab: { '[PAD]': 0, '[UNK]': 1, '[CLS]': 2, '[SEP]': 3, hello: 4, world: 5 } },
};
const files = {
  'config.json': { model_type: 'bert', architectures: ['BertModel'] },
  'tokenizer_config.json': { tokenizer_class: 'BertTokenizer', model_max_length: 64,
    unk_token: '[UNK]', pad_token: '[PAD]', cls_token: '[CLS]', sep_token: '[SEP]' },
  'tokenizer.json': tokenizer,
};

let runtime;
let originalLoader;
let extractor;
try {
  assert.ok(['pinned-cache', 'local-only-miss'].includes(mode));
  if (mode === 'pinned-cache') {
    mkdirSync(pinned, { recursive: true });
    for (const [name, value] of Object.entries(files)) {
      const text = JSON.stringify(value);
      report.fixture_bytes += Buffer.byteLength(text);
      writeFileSync(join(pinned, name), text);
    }
  }
  const runtimeUrl = runtimePath ? pathToFileURL(runtimePath) : new URL('../../vendor/transformers.node.min.mjs', import.meta.url);
  runtime = await import(runtimeUrl.href);
  runtime.env.allowRemoteModels = true;
  runtime.env.allowLocalModels = true;
  runtime.env.localModelPath = join(root, 'unused-models');
  runtime.env.cacheDir = defaultCache;
  runtime.env.useFSCache = true;
  runtime.env.useBrowserCache = false;
  runtime.env.useCustomCache = false;
  runtime.env.fetch = denyFetch;

  originalLoader = runtime.AutoModel.from_pretrained;
  runtime.AutoModel.from_pretrained = async (id, received) => {
    report.model_loads++;
    assert.equal(id, model);
    for (const [key, value] of Object.entries(options)) assert.equal(received[key], value, key);
    return Object.assign(async ({ input_ids }) => {
      report.model_calls++;
      const [batch, length] = input_ids.dims;
      return { last_hidden_state: new runtime.Tensor('float32',
        Float32Array.from({ length: batch * length * 2 }, (_, index) => index % 2 ? 4 : 3), [batch, length, 2]) };
    }, { dispose: async () => { report.disposals++; } });
  };

  if (mode === 'pinned-cache') {
    assert.equal(existsSync(join(cacheDir, model, 'config.json')), false);
    assert.equal(existsSync(join(cacheDir, model, 'tokenizer_config.json')), false);
    extractor = await runtime.pipeline('feature-extraction', model, options);
    report.tokenizer_type = typeof extractor.tokenizer;
    assert.equal(report.tokenizer_type, 'function');
    const texts = ['hello world', 'hello'];
    const encoded = extractor.tokenizer(texts, { padding: true, truncation: true });
    report.input_ids = encoded.input_ids.tolist().map((row) => row.map(Number));
    assert.deepEqual(report.input_ids, [[2, 4, 5, 3], [2, 4, 3, 0]]);
    const output = await extractor(texts, { pooling: 'mean', normalize: true });
    report.output_shape = output.dims;
    for (const row of output.tolist()) {
      assert.ok(Math.abs(row[0] - 0.6) < 1e-6 && Math.abs(row[1] - 0.8) < 1e-6);
    }
    await extractor.dispose();
    extractor = undefined;
  } else {
    await assert.rejects(runtime.pipeline('feature-extraction', model, options), (error) => {
      report.missing_error = error.message;
      assert.match(error.message, /local_files_only=true/);
      return true;
    });
  }
  assert.deepEqual(report.fetches, []);
  report.default_cache_created = existsSync(defaultCache);
  report.onnx_files = existsSync(cacheDir)
    ? readdirSync(cacheDir, { recursive: true }).filter((path) => path.endsWith('.onnx')).length : 0;
  assert.equal(report.onnx_files, 0);
  assert.ok(report.fixture_bytes < 2_048);
  if (mode === 'pinned-cache') assert.ok(statSync(join(pinned, 'tokenizer.json')).size < 2_048);
  console.log(JSON.stringify(report));
} finally {
  await extractor?.dispose();
  if (originalLoader) runtime.AutoModel.from_pretrained = originalLoader;
  globalThis.fetch = originalFetch;
}
