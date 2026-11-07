import { createServer, type AddressInfo } from 'node:net';

export async function createNetworkDenyProxy() {
  let blocked = 0;
  const server = createServer(socket => { blocked++; socket.destroy(); });
  await new Promise<void>((resolve,reject) => { server.once('error',reject); server.listen(0,'127.0.0.1',() => { server.off('error',reject); resolve(); }); });
  server.unref();
  return { url:`http://127.0.0.1:${(server.address() as AddressInfo).port}`, blocked:()=>blocked,
    close:()=>new Promise<void>((resolve,reject) => server.close(error=>error?reject(error):resolve())) };
}
