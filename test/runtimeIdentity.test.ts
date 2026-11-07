import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ body: 'initial runtime', vendor: 'initial vendor' }));
vi.mock('node:fs', () => ({
  existsSync: () => true,
  readdirSync: () => [{ name: 'fixture.js', isDirectory: () => false }],
  readFileSync: (path: string) => path.endsWith('.mjs') ? fixture.vendor : fixture.body,
}));

describe('runtime identity', () => {
  it('captures the build before the first health call, not after files change', async () => {
    const { runtimeIdentity } = await import('../src/runtimeIdentity.js');
    fixture.body = 'a newer build on disk';
    fixture.vendor = 'a newer vendor on disk';
    const expected = createHash('sha256').update('fixture.js').update('\0').update('initial runtime')
      .update('vendor/transformers.node.min.mjs').update('\0').update('initial vendor').digest('hex');
    expect(runtimeIdentity().build_id).toBe(expected);
    expect(runtimeIdentity().build_id).toBe(expected);
  });
});
