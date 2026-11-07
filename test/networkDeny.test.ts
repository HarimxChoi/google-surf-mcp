import { createConnection } from 'node:net';
import { describe,expect,it } from 'vitest';
import { createNetworkDenyProxy } from '../src/networkDeny.js';

describe('browser unrouted network sink',()=>{
  it('closes proxy tunnels without forwarding traffic',async()=>{
    const proxy=await createNetworkDenyProxy();
    try{
      const port=Number(new URL(proxy.url).port);
      await new Promise<void>((resolve,reject)=>{
        const socket=createConnection({host:'127.0.0.1',port});
        socket.on('connect',()=>socket.write('CONNECT 127.0.0.1:80 HTTP/1.1\r\n\r\n'));
        socket.on('error',error=>{ if((error as NodeJS.ErrnoException).code!=='ECONNRESET')reject(error); });
        socket.on('close',()=>resolve());
      });
      expect(proxy.blocked()).toBe(1);
    }finally{await proxy.close();}
  });
});
