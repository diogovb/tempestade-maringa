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
      if (res.status === 429 && i + 1 < tries) {
        // Limite de chamadas da fonte: espera o que ela pedir, sem passar de 20 segundos
        const asked = Number(res.headers.get('retry-after')) * 1000;
        await sleep(Math.min(20_000, asked || 10_000 * (i + 1)));
        last = new Error('HTTP 429');
        continue;
      }
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
  res.setHeader('Vercel-CDN-Cache-Control', `max-age=${fresh}, stale-while-revalidate=${stale}, stale-if-error=86400`);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json(body);
}
export function sendError(res, e) {
  console.error(e);
  res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
  res.setHeader('Vercel-CDN-Cache-Control', 'max-age=15');
  res.status(502).json({ ok: false, error: String(e?.message ?? e).slice(0, 160) });
}

// Se a fonte falhar, entrega o último dado bom que esta instância tem na memória.
// O horário original vai junto, e a página mostra que o dado está antigo.
const lastGood = new Map();
export async function serve(res, key, build, cache) {
  try {
    const data = await build();
    lastGood.set(key, data);
    sendJson(res, data, cache);
  } catch (e) {
    const prev = lastGood.get(key);
    if (!prev) {
      sendError(res, e);
      return;
    }
    console.error(key, 'usando último dado bom:', e?.message);
    sendJson(res, prev, { fresh: 30, stale: 120 });
  }
}
