import { fetchGrid } from '../assets/shared.js';
import { getJson, sendJson, sendError } from './_lib.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function handler(req, res) {
  try {
    const data = await fetchGrid((u) => getJson(u, { timeout: 20_000 }), () => sleep(300));
    sendJson(res, data, { fresh: 7200, stale: 21600 });
  } catch (e) {
    sendError(res, e);
  }
}
