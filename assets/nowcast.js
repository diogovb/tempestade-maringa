// Leitura do radar no navegador: acha células fortes perto de Maringá e estima para onde vão.
// Compara a imagem mais recente com a de cerca de 30 minutos antes.
import { MGA } from './shared.js';

// Paleta "Universal Blue" da RainViewer, de 5 a 75 dBZ
const PALETTE = ['928871', '9e9375', 'aa9e79', 'b6a97e', 'c2b482', 'cec087', 'd2c48b', 'd6c88f', 'dacc93', 'ded097', '88ddee', '6cd1eb', '51c5e8', '36bae5', '1baee2', '00a3e0', '009ad5', '0091ca', '0088bf', '007fb4', '0077aa', '0070a3', '00699c', '006295', '005b8e', '005588', '005180', '004e78', '004a70', '004768', 'ffee00', 'ffe000', 'ffd200', 'ffc500', 'ffb700', 'ffaa00', 'ff9f00', 'ff9500', 'ff8b00', 'ff8100', 'ff4400', 'f23600', 'e62800', 'd91b00', 'cd0d00', 'c10000', 'a80000', '8f0000', '760000', '5d0000', 'ffaaff', 'ff9fff', 'ff95ff', 'ff8bff', 'ff81ff', 'ff77ff', 'ff6cff', 'ff62ff', 'ff58ff', 'ff4eff', 'ffffff'];
const LOOKUP = new Map();
PALETTE.forEach((hex, i) => {
  const k = parseInt(hex, 16);
  if (!LOOKUP.has(k)) LOOKUP.set(k, 5 + i);
});
const COLORS = [...LOOKUP.entries()].map(([k, v]) => [k >> 16, (k >> 8) & 255, k & 255, v]);
function nearestDbz(r, g, b) {
  let best = 0, bd = 1e9;
  for (const [cr, cg, cb, v] of COLORS) {
    const d = (cr - r) ** 2 + (cg - g) ** 2 + (cb - b) ** 2;
    if (d < bd) { bd = d; best = v; }
  }
  return best;
}

const Z = 6;
const WORLD = 256 * 2 ** Z;
const TX0 = 22, TY0 = 35, NT = 2;
export const SIZE = 256 * NT;
const KM_PER_PX = (156.543034 / 2 ** Z) * Math.cos((23.4 * Math.PI) / 180);
export const STRONG_DBZ = 45;
const MAX_RANGE_KM = 350;

const lonToX = (lon) => ((lon + 180) / 360) * WORLD - TX0 * 256;
const latToY = (lat) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * WORLD - TY0 * 256;
};
const xToLon = (x) => ((x + TX0 * 256) / WORLD) * 360 - 180;
const yToLat = (y) => {
  const n = Math.PI * (1 - (2 * (y + TY0 * 256)) / WORLD);
  return (Math.atan(Math.sinh(n)) * 180) / Math.PI;
};

export function distanceKm(lat1, lon1, lat2, lon2) {
  const r = 6371, p = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * p) / 2) ** 2 + Math.cos(lat1 * p) * Math.cos(lat2 * p) * Math.sin(((lon2 - lon1) * p) / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}
export function bearing(lat1, lon1, lat2, lon2) {
  const p = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * p) * Math.cos(lat2 * p);
  const x = Math.cos(lat1 * p) * Math.sin(lat2 * p) - Math.sin(lat1 * p) * Math.cos(lat2 * p) * Math.cos((lon2 - lon1) * p);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error(`falha em ${url}`));
    im.src = url;
  });
}

async function loadField(host, path) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const jobs = [];
  for (let ty = 0; ty < NT; ty++) {
    for (let tx = 0; tx < NT; tx++) {
      const url = `${host}${path}/256/${Z}/${TX0 + tx}/${TY0 + ty}/2/0_0.png`;
      jobs.push(loadImage(url).then((im) => ctx.drawImage(im, tx * 256, ty * 256)));
    }
  }
  const results = await Promise.allSettled(jobs);
  const failed = results.filter((r) => r.status === 'rejected').length;
  if (failed === results.length) throw new Error('radar indisponível');
  const px = ctx.getImageData(0, 0, SIZE, SIZE).data;
  const field = new Uint8Array(SIZE * SIZE);
  const cache = new Map();
  for (let i = 0, p = 0; p < field.length; i += 4, p++) {
    if (px[i + 3] < 200) continue;
    const key = (px[i] << 16) | (px[i + 1] << 8) | px[i + 2];
    let v = LOOKUP.get(key);
    if (v === undefined) {
      v = cache.get(key);
      if (v === undefined) {
        v = nearestDbz(px[i], px[i + 1], px[i + 2]);
        cache.set(key, v);
      }
    }
    field[p] = v;
  }
  return { field, failed };
}

const signal = (v) => (v < 25 ? 0 : Math.min(v, 55) - 24);

// Procura o deslocamento (em pixels) que melhor encaixa a imagem antiga na atual.
function matchMotion(cur, old, cx, cy, radius, maxShift) {
  const x0 = Math.max(maxShift + 1, Math.round(cx - radius));
  const x1 = Math.min(SIZE - maxShift - 2, Math.round(cx + radius));
  const y0 = Math.max(maxShift + 1, Math.round(cy - radius));
  const y1 = Math.min(SIZE - maxShift - 2, Math.round(cy + radius));
  const xs = [], ys = [], vs = [];
  for (let y = y0; y <= y1; y += 2) {
    for (let x = x0; x <= x1; x += 2) {
      const s = signal(cur[y * SIZE + x]);
      if (s) { xs.push(x); ys.push(y); vs.push(s); }
    }
  }
  if (xs.length < 25) return null;
  const cost = (dx, dy) => {
    let sum = 0;
    for (let i = 0; i < xs.length; i++) sum += Math.abs(vs[i] - signal(old[(ys[i] - dy) * SIZE + (xs[i] - dx)]));
    return sum / xs.length;
  };
  let bx = 0, by = 0, best = cost(0, 0);
  const still = best;
  for (let dy = -maxShift; dy <= maxShift; dy += 2) {
    for (let dx = -maxShift; dx <= maxShift; dx += 2) {
      const c = cost(dx, dy);
      if (c < best) { best = c; bx = dx; by = dy; }
    }
  }
  const cx2 = bx, cy2 = by;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const c = cost(cx2 + dx, cy2 + dy);
      if (c < best) { best = c; bx = cx2 + dx; by = cy2 + dy; }
    }
  }
  return { dx: bx, dy: by, quality: still > 0 ? 1 - best / still : 0, samples: xs.length };
}

function toVelocity(m, dtMin) {
  if (!m) return null;
  const east = (m.dx * KM_PER_PX * 60) / dtMin;
  const north = (-m.dy * KM_PER_PX * 60) / dtMin;
  return { east, north, speed: Math.hypot(east, north), toBearing: ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360, quality: m.quality };
}

function findCells(field) {
  const seen = new Uint8Array(field.length);
  const stack = [];
  const mx = lonToX(MGA.lon), my = latToY(MGA.lat);
  const maxPx = MAX_RANGE_KM / KM_PER_PX;
  const cells = [];
  for (let start = 0; start < field.length; start++) {
    if (field[start] < STRONG_DBZ || seen[start]) continue;
    stack.length = 0;
    stack.push(start);
    seen[start] = 1;
    let n = 0, sx = 0, sy = 0, sw = 0, max = 0, near = 1e9, nx = 0, ny = 0;
    while (stack.length) {
      const p = stack.pop();
      const x = p % SIZE, y = (p / SIZE) | 0, v = field[p];
      n++;
      sx += x * v; sy += y * v; sw += v;
      if (v > max) max = v;
      const d = Math.hypot(x - mx, y - my);
      if (d < near) { near = d; nx = x; ny = y; }
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= SIZE || yy >= SIZE) continue;
          const q = yy * SIZE + xx;
          if (!seen[q] && field[q] >= STRONG_DBZ) {
            seen[q] = 1;
            stack.push(q);
          }
        }
      }
    }
    if (n < 3 || near > maxPx) continue;
    const c = { px: sx / sw, py: sy / sw, area: n * KM_PER_PX ** 2, max, nx, ny };
    c.lat = yToLat(c.py);
    c.lon = xToLon(c.px);
    c.nearLat = yToLat(ny);
    c.nearLon = xToLon(nx);
    c.distKm = distanceKm(MGA.lat, MGA.lon, c.nearLat, c.nearLon);
    c.fromBearing = bearing(MGA.lat, MGA.lon, c.nearLat, c.nearLon);
    cells.push(c);
  }
  return cells.sort((a, b) => a.distKm - b.distKm);
}

function nearestAbove(field, threshold) {
  const mx = lonToX(MGA.lon), my = latToY(MGA.lat);
  let best = 1e9, bx = 0, by = 0;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (field[y * SIZE + x] >= threshold) {
        const d = (x - mx) ** 2 + (y - my) ** 2;
        if (d < best) { best = d; bx = x; by = y; }
      }
    }
  }
  if (best === 1e9) return null;
  const lat = yToLat(by), lon = xToLon(bx);
  return { km: distanceKm(MGA.lat, MGA.lon, lat, lon), bearing: bearing(MGA.lat, MGA.lon, lat, lon) };
}

function overCity(field, radiusKm) {
  const mx = lonToX(MGA.lon), my = latToY(MGA.lat);
  const r = radiusKm / KM_PER_PX;
  let max = 0;
  for (let y = Math.floor(my - r); y <= my + r; y++) {
    for (let x = Math.floor(mx - r); x <= mx + r; x++) {
      if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) continue;
      if (Math.hypot(x - mx, y - my) <= r) max = Math.max(max, field[y * SIZE + x]);
    }
  }
  return max;
}

// Velocidades plausíveis para uma tempestade na região
const plausible = (v) => v && v.speed <= 130;

export async function analyzeRadar(meta) {
  const frames = meta?.radar?.past || [];
  if (!frames.length) throw new Error('sem imagens de radar');
  const last = frames[frames.length - 1];
  let prev = null;
  for (const f of frames) {
    const age = last.time - f.time;
    if (age < 900) continue;
    if (!prev || Math.abs(age - 1800) < Math.abs(last.time - prev.time - 1800)) prev = f;
  }
  const { field: cur, failed } = await loadField(meta.host, last.path);
  const cells = findCells(cur);
  const result = {
    frameTime: last.time * 1000,
    cells,
    failedTiles: failed,
    overCity: overCity(cur, 12),
    nearestRain: nearestAbove(cur, 25),
    motion: null,
  };
  if (!prev) return result;
  const { field: old } = await loadField(meta.host, prev.path);
  const dtMin = (last.time - prev.time) / 60;
  const maxShift = Math.min(60, Math.ceil(((130 * dtMin) / 60) / KM_PER_PX));
  const mx = lonToX(MGA.lon), my = latToY(MGA.lat);
  const regional = toVelocity(matchMotion(cur, old, mx, my, 180, maxShift), dtMin);
  result.motion = plausible(regional) && regional.quality > 0.05 ? regional : null;

  for (const c of cells.slice(0, 18)) {
    await new Promise((r) => setTimeout(r));
    const local = toVelocity(matchMotion(cur, old, c.px, c.py, 32, maxShift), dtMin);
    const v = plausible(local) && local.quality >= 0.12 ? local : result.motion;
    if (!v) continue;
    c.speed = v.speed;
    c.toBearing = v.toBearing;
    c.motionSource = v === local ? 'célula' : 'região';
    // Caminho em km, com Maringá na origem
    const rx = ((c.nearLon - MGA.lon) * Math.PI * 6371 * Math.cos((MGA.lat * Math.PI) / 180)) / 180;
    const ry = ((c.nearLat - MGA.lat) * Math.PI * 6371) / 180;
    if (v.speed < 10) continue;
    const ux = v.east / v.speed, uy = v.north / v.speed;
    const along = -(rx * ux + ry * uy);
    const cross = Math.abs(rx * uy - ry * ux);
    c.cpaKm = cross;
    const REACH = 20;
    if (along > -REACH && cross <= REACH) {
      const entry = along - Math.sqrt(Math.max(0, REACH * REACH - cross * cross));
      const eta = (Math.max(0, entry) / v.speed) * 60;
      // Além de 2h30 a extrapolação não é confiável: nem chamamos de ameaça.
      if (eta <= 150) {
        c.etaMin = eta;
        c.threat = true;
      }
    }
  }
  result.threats = cells.filter((c) => c.threat).sort((a, b) => a.etaMin - b.etaMin);
  return result;
}
