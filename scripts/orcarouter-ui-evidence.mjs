// Automated UI evidence for the OrcaRouter provider.
//
// Opt-in: this script talks to the live OrcaRouter catalog, so it is not part
// of `npm test` and is not wired into CI. Run it by hand before opening a
// change that touches the provider UI:
//
//   ORCAROUTER_API_KEY=sk-orca-… node scripts/orcarouter-ui-evidence.mjs
//
// It drives the real configuration UI served by startUiServer() and asserts the
// properties the change requires: both authentication entry points visible with
// a masked key field, a real model listbox for text, and a capability-filtered
// listbox once an image attachment is added. Writes PNGs plus a manifest whose
// SHA-256 digests can be cited as evidence.
//
// The page never receives the API key: discovery runs on the server side.

import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startUiServer } from '../build/orcarouter/ui.js';

const OUT_DIR = resolve(process.env.ORCA_EVIDENCE_DIR ?? 'artifacts/orcarouter-ui');
/** Falls back to Playwright's bundled browser when the system one is absent. */
const CHROMIUM = process.env.CHROMIUM_PATH
  ?? (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
const CATALOG_URL = 'https://api.orcarouter.ai/v1/models?capability=chat';

if (!process.env.ORCAROUTER_API_KEY && !process.env.ORCA_KEY) {
  console.error('Set ORCAROUTER_API_KEY (or ORCA_KEY) to run the live catalog evidence.');
  process.exit(1);
}

const results = {};

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

function check(condition, message) {
  if (!condition) fail(message);
  console.error(`  ok: ${message}`);
}

/** Right edge alignment: the panel must line up with its trigger within 2px. */
async function panelGeometry(page, triggerSel, panelSel) {
  return page.evaluate(([t, p]) => {
    const trigger = document.querySelector(t);
    const panel = document.querySelector(p);
    const tb = trigger.getBoundingClientRect();
    const pb = panel.getBoundingClientRect();
    const style = getComputedStyle(panel);
    const alpha = (color) => {
      const m = color.match(/rgba?\(([^)]+)\)/);
      if (!m) return 1;
      const parts = m[1].split(',').map((s) => s.trim());
      return parts.length === 4 ? Number(parts[3]) : 1;
    };
    return {
      open: trigger.getAttribute('aria-expanded') === 'true' && !panel.hidden,
      role: panel.getAttribute('role'),
      itemCount: panel.querySelectorAll('[role="option"]').length,
      panelWidth: Math.round(pb.width),
      triggerPanelRightDelta: Math.abs(Math.round(tb.right) - Math.round(pb.right)),
      backgroundAlpha: alpha(style.backgroundColor),
      background: style.backgroundColor,
      borderWidth: parseFloat(style.borderTopWidth),
      borderStyle: style.borderTopStyle,
      visible: pb.width > 0 && pb.height > 0,
    };
  }, [triggerSel, panelSel]);
}

function assertPanel(geo, label) {
  check(geo.open, `${label}: aria-expanded=true and panel not hidden`);
  check(geo.role === 'listbox', `${label}: panel has role=listbox`);
  check(geo.itemCount > 0, `${label}: panel has ${geo.itemCount} options`);
  check(geo.triggerPanelRightDelta <= 2,
    `${label}: panel right edge within 2px of trigger (delta=${geo.triggerPanelRightDelta}px)`);
  check(geo.backgroundAlpha === 1,
    `${label}: panel background is opaque (${geo.background})`);
  check(geo.borderWidth >= 1 && geo.borderStyle !== 'none',
    `${label}: panel has a visible border (${geo.borderWidth}px ${geo.borderStyle})`);
  check(geo.visible, `${label}: panel is visible`);
}

async function shoot(page, name, minWidth = 800, minHeight = 450) {
  const path = `${OUT_DIR}/${name}.png`;
  await page.setViewportSize({ width: 1280, height: 800 });
  const buffer = await page.screenshot({ path });
  const sharp = (await import('sharp')).default;
  const meta = await sharp(path).metadata();
  check(meta.width >= minWidth && meta.height >= minHeight,
    `${name}.png is ${meta.width}x${meta.height} (>= ${minWidth}x${minHeight})`);
  results[name] = {
    path,
    width: meta.width,
    height: meta.height,
    sha256: createHash('sha256').update(buffer).digest('hex'),
  };
  return results[name];
}

const server = await startUiServer();
console.error(`UI server: ${server.url}`);

// Read the live catalog through the same server-side path the page uses, so the
// manifest counts and the rendered options come from one source.
const chatPayload = await (await fetch(`${server.url}api/models?capability=chat`)).json();
const imagePayload = await (await fetch(`${server.url}api/models?capability=chat&input_modality=image`)).json();
check(chatPayload.source === 'live' && !chatPayload.degraded,
  `catalog is live from ${CATALOG_URL} (${chatPayload.count} text models, ${chatPayload.fetchedAt})`);
check(imagePayload.count > 0 && imagePayload.count <= chatPayload.count,
  `image-input chat models: ${imagePayload.count} of ${chatPayload.count}`);

mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch({
  executablePath: CHROMIUM,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

// Fail loudly on any console error or leaked key in the page.
const consoleErrors = [];
page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
page.on('pageerror', (error) => consoleErrors.push(String(error)));

await page.goto(server.url, { waitUntil: 'networkidle' });

// ---- 1. auth-methods: both entry points, masked key field -------------------
await page.waitForSelector('#api-key');
const auth = await page.evaluate(() => {
  const key = document.querySelector('#api-key');
  const connect = document.querySelector('#connect');
  const save = document.querySelector('#save-key');
  return {
    keyType: key.getAttribute('type'),
    keyVisible: key.getBoundingClientRect().width > 0,
    connectText: connect.textContent.trim(),
    connectEnabled: !connect.disabled,
    connectVisible: connect.getBoundingClientRect().width > 0,
    saveEnabled: !save.disabled,
    labelText: document.querySelector('label[for="api-key"]').textContent.trim(),
  };
});
check(auth.keyType === 'password', `API key control is masked (type=${auth.keyType})`);
check(auth.keyVisible, 'API key control is visible');
check(auth.connectEnabled && auth.connectVisible,
  `PKCE entry point is visible and actionable ("${auth.connectText}")`);
check(auth.saveEnabled, 'API key save control is enabled');
check(/api/i.test(auth.labelText), `API key control is labelled ("${auth.labelText}")`);

// The browser must not hold the key: no key value in the DOM, form field,
// cookie or web storage. (The placeholder text "sk-orca-..." is a label, not a
// credential, so the check looks for a usable key shape.)
const keyLeak = await page.evaluate(() => {
  const keyPattern = /sk-orca-[A-Za-z0-9_-]{8,}/;
  const fieldValue = document.querySelector('#api-key')?.value ?? '';
  const haystack = document.documentElement.outerHTML
    + document.cookie
    + JSON.stringify(Object.entries(localStorage))
    + JSON.stringify(Object.entries(sessionStorage));
  return {
    leaked: keyPattern.test(haystack) || keyPattern.test(fieldValue),
    fieldValue,
    placeholder: document.querySelector('#api-key')?.getAttribute('placeholder'),
  };
});
check(!keyLeak.leaked, 'no usable sk-orca- value is present in the DOM, form field, cookies or web storage');
check(keyLeak.fieldValue === '', 'the API key field is empty (the browser is never given the key)');
check(keyLeak.placeholder === 'sk-orca-...', `the field is labelled with a key hint ("${keyLeak.placeholder}")`);

await shoot(page, 'auth-methods');

// ---- 2. text-model-dropdown ------------------------------------------------
await page.click('#text-trigger');
await page.waitForSelector('#text-listbox [role="option"]');
const textGeo = await panelGeometry(page, '#text-trigger', '#text-listbox');
assertPanel(textGeo, 'text selector');
check(textGeo.itemCount === chatPayload.count,
  `text selector offers every discovered chat model (${textGeo.itemCount})`);
// The rendered options are the filtered catalog, not a hand-written sample.
const renderedText = await page.$$eval('#text-listbox [role="option"]',
  (nodes) => nodes.map((n) => n.dataset.modelId));
const expectedText = chatPayload.models.map((m) => m.id);
check(JSON.stringify(renderedText) === JSON.stringify(expectedText),
  'text selector options match the server-side filtered catalog exactly');
const nonChat = await page.$$eval('#text-listbox [role="option"]',
  (nodes, allowed) => nodes.map((n) => n.dataset.modelId).filter((id) => !allowed.includes(id)),
  expectedText);
check(nonChat.length === 0, 'no model outside the discovered chat catalog is offered');

await shoot(page, 'text-model-dropdown');
await page.click('#text-trigger'); // close

// ---- 3. multimodal-model-dropdown ------------------------------------------
await page.click('#add-image');
await page.waitForFunction(() => document.getElementById('attachment-pill').textContent.includes('image'));
// Wait for the recomputed selector: it must be re-derived after the attachment.
await page.waitForFunction((expected) => {
  const panel = document.getElementById('mm-listbox');
  return panel.querySelectorAll('[role="option"]').length === expected;
}, imagePayload.count);

await page.click('#mm-trigger');
await page.waitForSelector('#mm-listbox [role="option"]');
const mmGeo = await panelGeometry(page, '#mm-trigger', '#mm-listbox');
assertPanel(mmGeo, 'multimodal selector');
check(mmGeo.itemCount === imagePayload.count,
  `multimodal selector offers only image-input chat models (${mmGeo.itemCount})`);

const renderedMm = await page.$$eval('#mm-listbox [role="option"]',
  (nodes) => nodes.map((n) => n.dataset.modelId));
// Models the text catalog offers but the image catalog does not are text-only:
// none of them may survive into the multimodal selector.
const imageIds = imagePayload.models.map((m) => m.id);
const textOnlyIds = expectedText.filter((id) => !imageIds.includes(id));
const leaked = textOnlyIds.filter((id) => renderedMm.includes(id));
check(textOnlyIds.length > 0,
  `the text catalog has ${textOnlyIds.length} text-only models to exclude (e.g. ${textOnlyIds[0]})`);
check(leaked.length === 0,
  `no text-only model remains in the multimodal selector (${textOnlyIds.length} excluded, ${leaked.length} leaked)`);
// Every offered model is an image-input chat model, byte-for-byte the filtered catalog.
check(JSON.stringify(renderedMm) === JSON.stringify(imageIds),
  `multimodal options are exactly the ${imageIds.length} image-input chat models`);

await shoot(page, 'multimodal-model-dropdown');

check(consoleErrors.length === 0, `no page console errors (${consoleErrors.join(' | ') || 'none'})`);

await browser.close();
await server.close();

const manifest = {
  automation: {
    framework: 'playwright',
    test_command: 'ORCAROUTER_API_KEY=… node scripts/orcarouter-ui-evidence.mjs',
    passed: true,
    catalog_source: CATALOG_URL,
    catalog_model_count: chatPayload.count,
    image_model_count: imagePayload.count,
  },
  artifacts: [
    {
      kind: 'auth-methods',
      path: results['auth-methods'].path,
      sha256: results['auth-methods'].sha256,
      ui: {
        api_key_visible: true,
        pkce_visible: true,
        secret_masked: true,
        controls_enabled: true,
      },
    },
    {
      kind: 'text-model-dropdown',
      path: results['text-model-dropdown'].path,
      sha256: results['text-model-dropdown'].sha256,
      ui: {
        dropdown_open: textGeo.open,
        item_count: textGeo.itemCount,
        panel_width: textGeo.panelWidth,
        trigger_panel_right_delta: textGeo.triggerPanelRightDelta,
        opaque_background: textGeo.backgroundAlpha === 1,
        visible_border: textGeo.borderWidth >= 1 && textGeo.borderStyle !== 'none',
      },
    },
    {
      kind: 'multimodal-model-dropdown',
      path: results['multimodal-model-dropdown'].path,
      sha256: results['multimodal-model-dropdown'].sha256,
      ui: {
        dropdown_open: mmGeo.open,
        item_count: mmGeo.itemCount,
        panel_width: mmGeo.panelWidth,
        trigger_panel_right_delta: mmGeo.triggerPanelRightDelta,
        opaque_background: mmGeo.backgroundAlpha === 1,
        visible_border: mmGeo.borderWidth >= 1 && mmGeo.borderStyle !== 'none',
      },
    },
  ],
};

writeFileSync(`${OUT_DIR}/manifest.json`, JSON.stringify(manifest, null, 2));
console.error(`\nPASS — wrote ${OUT_DIR}/manifest.json`);
console.error(JSON.stringify(manifest, null, 2));
