import { isIPv4 } from 'node:net';
import { Readable } from 'node:stream';
import { ProxyAgent, request } from 'undici';

export type TileFetch = (url: URL, options: { signal: AbortSignal; redirect: 'manual' }) => Promise<Response>;
type DnsAnswer = { type: number; data: string; TTL: number };

export function createTiandituTransport(host: string): TileFetch {
  const proxy = process.env.TIANDITU_PROXY_URL?.trim();
  if (!proxy) return fetch;

  const dispatcher = new ProxyAgent({ uri: proxy, requestTls: { servername: host } });
  const resolverUrl = process.env.TIANDITU_DOH_URL?.trim();
  // DNS uses its own TLS name. Never include the tile URL or key in this request.
  const dnsDispatcher = resolverUrl ? new ProxyAgent(proxy) : undefined;
  let cache: { addresses: string[]; expiresAt: number } | undefined;
  let pending: Promise<string[]> | undefined;

  function resolveAddresses(): Promise<string[]> {
    if (!resolverUrl) return Promise.resolve([host]);
    if (cache && Date.now() < cache.expiresAt) return Promise.resolve(cache.addresses);
    pending ??= (async () => {
      const url = new URL(resolverUrl);
      if (url.protocol !== 'https:') throw new Error('A secure Tianditu DNS resolver is required');
      url.searchParams.set('name', host);
      url.searchParams.set('type', 'A');
      const result = await request(url, {
        dispatcher: dnsDispatcher,
        headers: { accept: 'application/dns-json' },
        signal: AbortSignal.timeout(4000),
      });
      if (result.statusCode !== 200) {
        await result.body.dump();
        throw new Error('Tianditu DNS lookup failed');
      }
      const payload = await result.body.json() as { Answer?: DnsAnswer[] };
      const records = (payload.Answer ?? []).filter(record => record.type === 1 && isIPv4(record.data));
      if (!records.length) throw new Error('Tianditu DNS lookup returned no IPv4 address');
      const addresses = [...new Set(records.map(record => record.data))];
      const ttl = Math.max(5, Math.min(300, ...records.map(record => record.TTL || 5)));
      cache = { addresses, expiresAt: Date.now() + ttl * 1000 };
      return addresses;
    })().finally(() => { pending = undefined; });
    return pending;
  }

  return async (upstream, { signal }) => {
    const addresses = await resolveAddresses();
    for (const address of addresses) {
      signal.throwIfAborted();
      const target = new URL(upstream);
      target.hostname = address;
      try {
        // Use the DNS address only for CONNECT. The Host header and TLS identity remain Tianditu.
        const response = await request(target, {
          dispatcher, signal, headers: { Host: host, 'User-Agent': 'GeoCSV' },
        });
        const headers = new Headers();
        for (const name of ['content-type', 'content-length']) {
          const value = response.headers[name];
          if (typeof value === 'string') headers.set(name, value);
        }
        if (response.statusCode === 204 || response.statusCode === 304) {
          await response.body.dump();
          return new Response(null, { status: response.statusCode, headers });
        }
        const body = Readable.toWeb(response.body) as ReadableStream<Uint8Array>;
        return new Response(body, { status: response.statusCode, headers });
      } catch (error) {
        if (address === addresses[addresses.length - 1] || signal.aborted) throw error;
      }
    }
    throw new Error('Tianditu DNS lookup returned no address');
  };
}
