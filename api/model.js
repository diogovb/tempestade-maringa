import { fetchModelSeries } from '../assets/shared.js';
import { getJson, sendJson, sendError } from './_lib.js';

export default async function handler(req, res) {
  try {
    const data = await fetchModelSeries((u) => getJson(u, { timeout: 15_000 }));
    sendJson(res, data, { fresh: 1800, stale: 7200 });
  } catch (e) {
    sendError(res, e);
  }
}
