import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ lookup:vi.fn(), close:vi.fn(async()=>{}), agents:[] as Array<any> }));
vi.mock('node:dns/promises',()=>({ lookup:mocks.lookup }));
vi.mock('undici',()=>({ Agent:class { options:any; constructor(options:any){ this.options=options; mocks.agents.push(this); } close=mocks.close; } }));
import { checkUrl, fetchBrowserResource } from '../src/extract.js';
beforeEach(()=>{ mocks.lookup.mockReset(); mocks.close.mockClear(); mocks.agents.length=0; delete process.env.SURF_ALLOW_PRIVATE; });
afterEach(()=>vi.unstubAllGlobals());

describe('pinned anonymous browser resource fetch',()=>{
  it('pins the validated DNS address and never resolves again while connecting',async()=>{
    mocks.lookup.mockResolvedValueOnce([{ address:'93.184.216.34',family:4 }]).mockResolvedValueOnce([{ address:'127.0.0.1',family:4 }]);
    const fetch=vi.fn(async(_url,init)=>{
      const lookup=mocks.agents[0].options.connect.lookup;
      const address=await new Promise(resolve=>lookup('example.org',{},(_e:any,ip:any)=>resolve(ip)));
      expect(address).toBe('93.184.216.34');
      expect(init.redirect).toBe('manual'); expect(init.headers.cookie).toBeUndefined();
      return new Response('Readable fact',{ headers:{ 'content-type':'text/html','content-encoding':'gzip','set-cookie':'secret=x' } });
    });
    vi.stubGlobal('fetch',fetch);
    const response=await fetchBrowserResource('https://example.org',{ cookie:'private=x',authorization:'Bearer private',accept:'text/html' });
    expect(response.body.toString()).toBe('Readable fact'); expect(response.headers['content-encoding']).toBeUndefined();
    expect(response.headers['set-cookie']).toBeUndefined(); expect(mocks.lookup).toHaveBeenCalledTimes(1); expect(mocks.close).toHaveBeenCalledTimes(1);
  });
  it('does not follow a redirect to a private host and blocks a changed DNS answer',async()=>{
    mocks.lookup.mockResolvedValueOnce([{ address:'93.184.216.34',family:4 }]).mockResolvedValueOnce([{ address:'127.0.0.1',family:4 }]);
    const fetch=vi.fn(async()=>new Response(null,{ status:302,headers:{ location:'http://127.0.0.1/admin' } }));vi.stubGlobal('fetch',fetch);
    const response=await fetchBrowserResource('https://example.org',{});
    await expect(fetchBrowserResource(response.headers.location,{})).rejects.toThrow('private');
    await expect(fetchBrowserResource('https://example.org',{})).rejects.toThrow('private');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(['http://2130706433/','http://0x7f000001/','http://[::ffff:7f00:1]/','http://100.64.0.1/','http://[64:ff9b::7f00:1]/','http://user:password@example.org/'])('blocks alternative private encodings and credentials: %s',url=>{
    expect(checkUrl(url)).not.toBeNull();
  });
  it('rejects non-read requests before creating a connection',async()=>{
    await expect(fetchBrowserResource('https://example.org',{},'POST')).rejects.toThrow('GET and HEAD');
    expect(mocks.lookup).not.toHaveBeenCalled();
  });
});
