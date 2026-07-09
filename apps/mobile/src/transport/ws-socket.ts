import type { RawSocket } from "@bosun/transport/client-core";

/** Open a React Native WebSocket and adapt it to the transport RawSocket. */
export function openWsSocket(addr: {
  host: string;
  port: number;
}): Promise<RawSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${addr.host}:${addr.port}`);
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        ws.close();
        reject(new Error(`timeout connecting to ${addr.host}:${addr.port}`));
      }
    }, 4000);
    ws.onopen = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        send: (data) => ws.send(data),
        close: () => ws.close(),
        onMessage: (cb) => {
          ws.onmessage = (ev) => cb(String(ev.data));
        },
        onClose: (cb) => {
          ws.onclose = () => cb();
        },
      });
    };
    ws.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`could not reach ${addr.host}:${addr.port}`));
    };
  });
}

export async function firstReachableWs(
  addrs: { host: string; port: number }[],
): Promise<RawSocket> {
  let lastErr: Error = new Error("no addresses to try");
  for (const addr of addrs) {
    try {
      return await openWsSocket(addr);
    } catch (err) {
      lastErr = err as Error;
    }
  }
  throw lastErr;
}
