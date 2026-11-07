import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { SourceReader } from '../build/sourceReader.js';
import { loadConfig } from '../build/config.js';

const previous = process.env.SURF_ALLOW_PRIVATE;
let articleRequests = 0;
let connections = 0;
const leaked = [];
process.env.SURF_ALLOW_PRIVATE = 'true';
const server = createServer((request, response) => {
  if (request.url !== '/article') { leaked.push(request.url); response.end('private tripwire'); return; }
  articleRequests++;
  response.setHeader('Content-Type', 'text/html');
  response.end(`<html><title>Source network fixture</title><main><article><h1>Source network fixture</h1>
    <p id="probe">ExecutedProbe: pending</p>${'<p>Public source reading preserves factual evidence and document provenance.</p>'.repeat(40)}
    </article></main><script>
    document.getElementById('probe').textContent='ExecutedProbe: true';
    fetch('/private-fetch').catch(()=>{});
    fetch('/private-post',{method:'POST',body:'fixture'}).catch(()=>{});
    navigator.sendBeacon('/private-beacon','fixture');
    const frame=document.createElement('iframe');frame.src='/private-frame';document.body.append(frame);
    try{new WebSocket('ws://'+location.host+'/private-socket');}catch{}
    const preconnect=document.createElement('link');preconnect.rel='preconnect';preconnect.href=location.origin;document.head.append(preconnect);
    </script></html>`);
  if (articleRequests >= 2) process.env.SURF_ALLOW_PRIVATE = 'false';
});
server.on('connection', () => { connections++; });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const reader = new SourceReader(loadConfig({ ...process.env, SURF_CLOUD_MODE: 'true', SURF_IDLE_CLOSE_MS: '500' }));
try {
  const result = await reader.read(`http://127.0.0.1:${server.address().port}/article`, 5000, 'full');
  assert.equal(result.error, undefined, result.error);
  assert.match(result.content, /ExecutedProbe: true/);
  assert.ok(articleRequests >= 2, 'Both discovery and browser navigation must execute');
  assert.equal(reader.stats().network_policy, 'pinned_get_head_with_unrouted_deny_proxy');
  assert.deepEqual(leaked, [], 'Browser subresources must not reach a private-address tripwire');
  assert.ok(connections <= articleRequests, 'Unrouted browser preconnect must not open an extra private TCP connection');
  console.log(JSON.stringify({ result: 'PASS', browser_javascript_executed: true, private_requests_received: leaked.length,
    private_extra_tcp_connections: Math.max(0, connections - articleRequests),
    probes: ['fetch', 'POST', 'beacon', 'iframe', 'WebSocket', 'preconnect'], dns_rebinding: 'separate pinned-lookup unit tests' }));
} finally {
  await reader.dispose();
  await new Promise(resolve => server.close(resolve));
  if (previous === undefined) delete process.env.SURF_ALLOW_PRIVATE;
  else process.env.SURF_ALLOW_PRIVATE = previous;
}
