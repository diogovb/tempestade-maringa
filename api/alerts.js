import { INMET_URL, parseInmet } from '../assets/shared.js';
import { getJson, sendJson, sendError } from './_lib.js';

export default async function handler(req, res) {
  try {
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
    sendJson(res, { fetchedAt: Date.now(), alerts: parseInmet(inmet), cemaden }, { fresh: 120, stale: 600 });
  } catch (e) {
    sendError(res, e);
  }
}
