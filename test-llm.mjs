
import { repairWithLLM } from './build/heal/llm.js';

const out = await repairWithLLM({

  compressedHtml: '<html><body><div data-ved="x"><h3>r</h3><a href="https://example.com">link</a></div></body></html>',

  brokenSelectors: { block: 'div.MjjYud', snippet: '.VwiC3b' },

  candidates: [{ blockSelector: '[data-ved]', source: 'data-ved', rationale: 'stable attr' }]

});

console.log(JSON.stringify(out, null, 2));

