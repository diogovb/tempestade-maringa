import { INMET_URL, parseInmet } from '../assets/shared.js';
import { getJson, serve } from './_lib.js';

async function build() {
  const inmet = await getJson(INMET_URL, { timeout: 25_000 });
  let cemaden = null;
  try {
    const c = await getJson('https://painelalertas.cemaden.gov.br/wsAlertas2', { timeout: 8_000, tries: 1 });
    cemaden = {
      updated: c.atualizado ?? null,
      total: c.alertas?.length ?? 0,
      pr: (c.alertas || []).filter((a) => a.uf === 'PR').map((a) => ({ city: a.municipio, event: a.evento, level: a.nivel, at: a.datahoracriacao, ibge: String(a.codibge) })),
    };
  } catch (e) {
    console.error('cemaden', e.message);
  }
  return { fetchedAt: Date.now(), alerts: parseInmet(inmet), cemaden };
}

export default function handler(req, res) {
  return serve(res, 'alerts', build, { fresh: 60, stale: 300 });
}
