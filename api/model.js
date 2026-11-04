import { fetchModelSeries } from '../assets/shared.js';
import { getJson, serve } from './_lib.js';

async function build() {
  const data = await fetchModelSeries((u) => getJson(u, { timeout: 15_000 }));
  // Com poucos modelos a comparação perde o sentido: melhor manter o último dado completo.
  if (data.models.length < 4) throw new Error(`só ${data.models.length} modelos responderam`);
  return data;
}

export default function handler(req, res) {
  return serve(res, 'model', build, { fresh: 900, stale: 7200 });
}
