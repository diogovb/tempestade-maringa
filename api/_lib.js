// Utilidades das funções da Vercel. O robô sempre se identifica pelo nome.
export const UA = 'tempestade-maringa (monitor comunitario; github.com/diogovb/tempestade-maringa)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function request(url, { tries = 2, timeout = 20_000 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: '*/*', 'Accept-Language': 'pt-BR,pt;q=0.9' },
        signal: AbortSignal.timeout(timeout),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (e) {
      last = e;
      if (i + 1 < tries) await sleep(800 * (i + 1));
    }
  }
  throw last;
}
export const getJson = async (url, opts) => (await request(url, opts)).json();
export const getText = async (url, opts) => (await request(url, opts)).text();

// A CDN da Vercel guarda a resposta e serve a mesma cópia para todo mundo.
// Assim as fontes oficiais recebem poucas chamadas, mesmo com muita gente na página.
export function sendJson(res, body, { fresh, stale }) {
  res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
  res.setHeader('Vercel-CDN-Cache-Control', `max-age=${fresh}, stale-while-revalidate=${stale}`);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json(body);
}
export function sendError(res, e) {
  console.error(e);
  res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
  res.setHeader('Vercel-CDN-Cache-Control', 'max-age=20');
  res.status(502).json({ ok: false, error: String(e?.message ?? e).slice(0, 160) });
}
