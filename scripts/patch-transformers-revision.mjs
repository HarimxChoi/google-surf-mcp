import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const path = new URL('../vendor/transformers.node.min.mjs', import.meta.url);
const digest = (text) => createHash('sha256').update(text).digest('hex');
const original = '1dc55b57189c1e800d6a83e001d1a7fd999145b117805a686e16f327eb0eb177';
const patched = 'be9d5de42e2084c843d589d76e83e77a7e603cbbbdb5308d3c7affffea168b17';
let source = readFileSync(path, 'utf8');
if (digest(source) !== patched) {
  assert.equal(digest(source), original, 'Review the revision patch after updating the vendored runtime.');
  const replacements = [
    ['async function _n(t){', 'async function _n(t,e={}){'],
    ['Ot(t,"tokenizer_config.json",{})', 'Ot(t,"tokenizer_config.json",e)'],
    ['async function Bd(t,e){let r=await _n(t);', 'async function Bd(t,e){let r=await _n(t,e);'],
    ['async function In(t,{config:e=null,dtype:r=null,device:s=null,model_file_name:n=null}={}){e=await Qo(t,{config:e});',
      'async function In(t,{config:e=null,dtype:r=null,device:s=null,model_file_name:n=null,...h}={}){e=await Qo(t,{config:e,...h});'],
    ['include_tokenizer:o=!0,include_processor:a=!0}={}){let i=await In(t,{config:e,dtype:r,device:s,model_file_name:n});if(o){let l=await _n(t);',
      'include_tokenizer:o=!0,include_processor:a=!0,...h}={}){let i=await In(t,{config:e,dtype:r,device:s,model_file_name:n,...h});if(o){let l=await _n(t,h);'],
    ['let w=await Ar(t,e,{device:i,dtype:l}),x={};',
      'let w=await Ar(t,e,{config:s,device:i,dtype:l,revision:a,cache_dir:n,local_files_only:o,model_file_name:f}),x={};'],
  ];
  for (const [before, after] of replacements) {
    assert.equal(source.split(before).length - 1, 1, 'Patch anchor must be unique.');
    source = source.replace(before, after);
  }
  assert.equal(digest(source), patched);
  writeFileSync(path, source);
}
console.log(JSON.stringify({ status: 'PASS', vendor_sha256: patched, replacements: 6 }));
