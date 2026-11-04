import { fetchEnsemble } from '../assets/shared.js';
import { getJson, sendJson, sendError } from './_lib.js';

export default async function handler(req, res) {
  try {
    const data = await fetchEnsemble((u) => getJson(u, { timeout: 20_000 }));
    sendJson(res, data, { fresh: 3600, stale: 14400 });
  } catch (e) {
    sendError(res, e);
  }
}
