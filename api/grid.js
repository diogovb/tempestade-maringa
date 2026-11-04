import { fetchGrid } from '../assets/shared.js';
import { getJson, serve } from './_lib.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Esta é a chamada mais pesada: distribui os pedidos no tempo para respeitar o limite da fonte.
export default function handler(req, res) {
  return serve(res, 'grid', () => fetchGrid((u) => getJson(u, { timeout: 15_000, tries: 3 }), () => sleep(1000)), { fresh: 7200, stale: 21600 });
}
