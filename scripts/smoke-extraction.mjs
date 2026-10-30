#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { chromium } from 'playwright';
import { extract } from '../build/extract.js';
import { parseResultsInBrowser, STRATEGIES } from '../build/parse.js';

const pdf = await PDFDocument.create();
pdf.setTitle('Extraction smoke paper');
pdf.setAuthor('Fixture Author');
const font = await pdf.embedFont(StandardFonts.Helvetica);
pdf.addPage().drawText('First page abstract evidence.', { x: 40, y: 700, font, size: 12 });
pdf.addPage().drawText('Second page full text evidence.', { x: 40, y: 700, font, size: 12 });
const pdfBytes = Buffer.from(await pdf.save());
const paragraph = 'A repeatable extraction test preserves source metadata and readable evidence without accessing a real account. ';
const server = createServer((request, response) => {
  if (request.url === '/paper.pdf') {
    response.writeHead(200, { 'content-type': 'application/pdf' });
    response.end(pdfBytes);
    return;
  }
  const paper = request.url === '/paper';
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(`<!doctype html><html><head><title>Extraction smoke article</title>
    <meta name="description" content="Concise fixture abstract evidence with sufficient metadata detail to exercise the abstract extraction path without reading the article body.">
    <meta name="citation_title" content="${paper ? 'Landing page paper' : 'Extraction smoke article'}">
    <meta name="citation_author" content="Fixture Author">
    ${paper ? '<meta name="citation_pdf_url" content="/paper.pdf"><meta name="citation_doi" content="10.0000/smoke-fixture">' : ''}
    </head><body><article><h1>Readable fixture</h1><p>${paragraph.repeat(30)}</p></article></body></html>`);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const previousPrivate = process.env.SURF_ALLOW_PRIVATE;
let browser;
try {
  delete process.env.SURF_ALLOW_PRIVATE;
  const blocked = await extract({}, `${base}/paper.pdf`);
  assert.match(blocked.error ?? '', /private|loopback|blocked/i);
  process.env.SURF_ALLOW_PRIVATE = 'true';
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.route('**/*', (route) => new URL(route.request().url()).hostname === '127.0.0.1'
    ? route.continue() : route.abort());

  const html = await extract(context, `${base}/article`, { mode: 'full', maxChars: 10_000 });
  assert.equal(html.error, undefined);
  assert.match(html.content, /repeatable extraction test/);
  assert.equal(html.title, 'Extraction smoke article');
  const summary = await extract(context, `${base}/article`, { mode: 'abstract', maxChars: 1_500 });
  assert.match(summary.content, /Concise fixture abstract/);

  const full = await extract(context, `${base}/paper.pdf`, { mode: 'full' });
  assert.equal(full.error, undefined);
  assert.match(full.content, /Second page full text evidence/);
  assert.equal(full.title, 'Extraction smoke paper');
  assert.equal(full.authors, 'Fixture Author');
  assert.equal(full.page_count, 2);
  const abstract = await extract(context, `${base}/paper.pdf`, { mode: 'abstract' });
  assert.match(abstract.content, /First page abstract evidence/);
  assert.doesNotMatch(abstract.content, /Second page full text evidence/);
  const landing = await extract(context, `${base}/paper`, { mode: 'full' });
  assert.equal(landing.error, undefined);
  assert.equal(landing.title, 'Landing page paper');
  assert.equal(landing.doi, '10.0000/smoke-fixture');
  assert.match(landing.content, /Second page full text evidence/);
  assert.equal(context.pages().length, 0);

  const page = await context.newPage();
  const parsed = [];
  for (const [fixture, strategy] of [
    ['serp-basic.html', STRATEGIES[0]],
    ['serp-live-goto.html', STRATEGIES.find((row) => row.id === 'data-snc-goto-v1')],
  ]) {
    const source = await readFile(new URL(`../test/fixtures/${fixture}`, import.meta.url), 'utf8');
    await page.setContent(`<base href="https://www.google.com/">${source}`);
    const result = await page.evaluate(parseResultsInBrowser, { strategy, max: 10 });
    assert.ok(result.results.length > 0, `${fixture} produced no results`);
    parsed.push({ fixture, results: result.results.length });
  }
  await context.close();
  console.log(JSON.stringify({ html: true, pdf: true, landing_pdf: true, ssrf: true, parsed }));
} finally {
  if (previousPrivate === undefined) delete process.env.SURF_ALLOW_PRIVATE;
  else process.env.SURF_ALLOW_PRIVATE = previousPrivate;
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
