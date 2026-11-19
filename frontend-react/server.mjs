// Servidor estático endurecido y sin dependencias. Compatible con non-root, read_only y tmpfs.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = resolve(fileURLToPath(new URL('./dist', import.meta.url)));
const PUERTO = Number.parseInt(process.env.PORT ?? '5173', 10);
const API = (process.env.VITE_API_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');

let origenApi;
try {
  origenApi = new URL(API).origin;
} catch {
  console.error('VITE_API_BASE_URL no es una URL válida');
  process.exit(1);
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  `connect-src 'self' ${origenApi}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const CABECERAS_SEGURIDAD = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const CONFIG_JS = `window.__CONFIG__=${JSON.stringify({ apiBaseUrl: API })};`;

function responder(res, estado, tipo, cuerpo, extra = {}, soloCabeceras = false) {
  res.writeHead(estado, { ...CABECERAS_SEGURIDAD, 'Content-Type': tipo, ...extra });
  res.end(soloCabeceras ? undefined : cuerpo);
}

async function archivoSeguro(ruta) {
  const destino = normalize(join(RAIZ, ruta));
  if (destino !== RAIZ && !destino.startsWith(RAIZ + sep)) return null;
  try {
    const info = await stat(destino);
    return info.isFile() ? destino : null;
  } catch {
    return null;
  }
}

const servidor = createServer(async (req, res) => {
  const soloCabeceras = req.method === 'HEAD';
  if (req.method !== 'GET' && !soloCabeceras) {
    responder(res, 405, 'text/plain; charset=utf-8', 'Método no permitido', { Allow: 'GET, HEAD' });
    return;
  }

  let ruta;
  try {
    ruta = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
  } catch {
    responder(res, 400, 'text/plain; charset=utf-8', 'Solicitud inválida', {}, soloCabeceras);
    return;
  }

  if (ruta === '/healthz') {
    responder(res, 200, 'text/plain; charset=utf-8', 'ok', { 'Cache-Control': 'no-store' }, soloCabeceras);
    return;
  }
  if (ruta === '/config.js') {
    responder(res, 200, MIME['.js'], CONFIG_JS, { 'Cache-Control': 'no-store' }, soloCabeceras);
    return;
  }

  try {
    let archivo = await archivoSeguro(ruta === '/' ? '/index.html' : ruta);
    if (archivo === null) {
      if (extname(ruta) !== '') {
        responder(res, 404, 'text/plain; charset=utf-8', 'No encontrado', {}, soloCabeceras);
        return;
      }
      archivo = await archivoSeguro('/index.html'); // fallback de SPA
      if (archivo === null) {
        responder(res, 503, 'text/plain; charset=utf-8', 'Aplicación no compilada', {}, soloCabeceras);
        return;
      }
    }
    const contenido = await readFile(archivo);
    const tipo = MIME[extname(archivo).toLowerCase()] ?? 'application/octet-stream';
    const cache = archivo.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache';
    responder(res, 200, tipo, contenido, { 'Cache-Control': cache }, soloCabeceras);
  } catch {
    responder(res, 500, 'text/plain; charset=utf-8', 'Error interno', {}, soloCabeceras);
  }
});

servidor.listen(PUERTO, '0.0.0.0', () => {
  console.log(`frontend-react escuchando en :${PUERTO} (API: ${API})`);
});

for (const senal of ['SIGTERM', 'SIGINT']) {
  process.once(senal, () => servidor.close(() => process.exit(0)));
}
