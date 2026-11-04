import { fetchEnsemble } from '../assets/shared.js';
import { getJson, serve } from './_lib.js';

export default function handler(req, res) {
  return serve(res, 'ensemble', () => fetchEnsemble((u) => getJson(u, { timeout: 20_000 })), { fresh: 3600, stale: 14400 });
}
