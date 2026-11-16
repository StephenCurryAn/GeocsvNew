import { Router, type Request, type Response, type NextFunction } from 'express';

const UPSTREAM_HOST = 't0.tianditu.gov.cn';
const ALLOWED_LAYERS = new Set(['vec', 'cva', 'img', 'cia']);
const MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type BasemapRouterOptions = {
  getKey?: () => string | undefined;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  maxInFlight?: number;
};

const jsonError = (res: Response, status: number, message: string) => {
  res.status(status).json({ code: status, message });
};

const isValidImage = (mime: string, bytes: Buffer): boolean => {
  if (mime === 'image/png') return bytes.length >= PNG_SIGNATURE.length && bytes.subarray(0, 8).equals(PNG_SIGNATURE);
  if (mime === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === 'image/webp') return bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  return false;
};

const isLoopbackAddress = (address: string | undefined): boolean => {
  if (!address) return false;
  const normalized = address.toLowerCase().replace(/^::ffff:/, '');
  return normalized === '127.0.0.1' || normalized === '::1';
};

const loopbackOnly = (req: Request, res: Response, next: NextFunction) => {
  if (!isLoopbackAddress(req.socket.remoteAddress)) {
    res.setHeader('Cache-Control', 'no-store');
    jsonError(res, 403, 'Basemap service is only available from this machine');
    return;
  }
  next();
};

export const createBasemapRouter = (options: BasemapRouterOptions = {}) => {
  const router = Router();
  const getKey = options.getKey || (() => process.env.TIANDITU_SERVER_KEY);
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = options.timeoutMs ?? 8000;
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  const maxInFlight = options.maxInFlight ?? 32;
  let inFlight = 0;

  // This service has no user authentication today. Protect only tile/config
  // routes, preserving unrelated API routes on this shared router. Never trust XFF.
  router.get('/basemaps', loopbackOnly, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ code: 200, data: { tianditu: { configured: Boolean(getKey()?.trim()) } } });
  });

  router.get('/basemap-tiles/tianditu/:layer/:z/:x/:y', loopbackOnly, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');

    // Provider host, WMTS layer, and query are server-owned. Never accept a URL,
    // query fragment, or caller-supplied token from the browser.
    if (Object.keys(req.query).length > 0) {
      jsonError(res, 400, 'Tile query parameters are not accepted');
      return;
    }
    const layer = typeof req.params.layer === 'string' ? req.params.layer : '';
    const zParam = typeof req.params.z === 'string' ? req.params.z : '';
    const xParam = typeof req.params.x === 'string' ? req.params.x : '';
    const yParam = typeof req.params.y === 'string' ? req.params.y : '';
    const z = /^\d{1,2}$/.test(zParam) ? Number(zParam) : -1;
    const x = /^\d{1,10}$/.test(xParam) ? Number(xParam) : -1;
    const y = /^\d{1,10}$/.test(yParam) ? Number(yParam) : -1;
    const side = z >= 0 && z <= 18 ? 2 ** z : 0;
    if (!ALLOWED_LAYERS.has(layer) || !side || x < 0 || y < 0 || x >= side || y >= side) {
      jsonError(res, 400, 'Invalid tile layer or coordinate');
      return;
    }

    const key = getKey()?.trim();
    if (!key) {
      jsonError(res, 503, 'Tianditu basemap is not configured on the server');
      return;
    }
    if (inFlight >= maxInFlight) {
      res.setHeader('Retry-After', '1');
      jsonError(res, 429, 'Too many basemap tile requests');
      return;
    }
    inFlight += 1;

    const controller = new AbortController();
    const abortForTimeout = setTimeout(() => controller.abort(new Error('upstream timeout')), timeoutMs);
    let disconnected = false;
    const cancelForDisconnect = () => {
      if (!res.writableEnded) {
        disconnected = true;
        controller.abort(new Error('downstream disconnected'));
      }
    };
    req.once('aborted', cancelForDisconnect);
    res.once('close', cancelForDisconnect);

    try {
      const upstream = new URL(`https://${UPSTREAM_HOST}/${layer}_w/wmts`);
      upstream.search = new URLSearchParams({
        SERVICE: 'WMTS', REQUEST: 'GetTile', VERSION: '1.0.0', LAYER: layer,
        STYLE: 'default', TILEMATRIXSET: 'w', FORMAT: 'tiles',
        TILEMATRIX: String(z), TILEROW: String(y), TILECOL: String(x), tk: key,
      }).toString();
      const response = await fetchImpl(upstream, { signal: controller.signal, redirect: 'manual' });
      if (!response.ok || response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined);
        jsonError(res, 502, 'Tianditu tile provider returned an unsuccessful response');
        return;
      }

      const mime = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() || '';
      if (!MIME_TYPES.has(mime)) {
        await response.body?.cancel().catch(() => undefined);
        jsonError(res, 502, 'Tianditu tile provider returned an unsupported image type');
        return;
      }
      const declaredLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        await response.body?.cancel().catch(() => undefined);
        jsonError(res, 502, 'Tianditu tile exceeds the response size limit');
        return;
      }
      if (!response.body) {
        jsonError(res, 502, 'Tianditu tile provider returned an empty response');
        return;
      }

      const reader = response.body.getReader();
      const chunks: Buffer[] = [];
      let total = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > maxBytes) {
            await reader.cancel().catch(() => undefined);
            jsonError(res, 502, 'Tianditu tile exceeds the response size limit');
            return;
          }
          chunks.push(Buffer.from(value));
        }
      } finally {
        reader.releaseLock();
      }

      const bytes = Buffer.concat(chunks, total);
      if (!isValidImage(mime, bytes)) {
        jsonError(res, 502, 'Tianditu tile content does not match its image type');
        return;
      }
      res.status(200).setHeader('Content-Type', mime).setHeader('Content-Length', String(bytes.length)).end(bytes);
    } catch {
      if (disconnected || res.destroyed) return;
      if (controller.signal.aborted) jsonError(res, 504, 'Tianditu tile request timed out');
      else jsonError(res, 502, 'Tianditu tile provider is unavailable');
    } finally {
      clearTimeout(abortForTimeout);
      req.off('aborted', cancelForDisconnect);
      res.off('close', cancelForDisconnect);
      inFlight -= 1;
    }
  });

  return router;
};
