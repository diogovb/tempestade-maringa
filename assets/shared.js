// Código usado tanto pelo robô de coleta (Node) quanto pela página (navegador).
// Nada aqui depende de ambiente: toda a rede passa pela função `get` recebida.

export const MGA = { lat: -23.4205, lon: -51.9333, ibge: '4115200', name: 'Maringá' };

export const MODELS = [
  { id: 'gfs_seamless', short: 'GFS', org: 'NOAA, EUA' },
  { id: 'ecmwf_ifs025', short: 'ECMWF', org: 'Centro Europeu' },
  { id: 'icon_seamless', short: 'ICON', org: 'DWD, Alemanha' },
  { id: 'gem_seamless', short: 'GEM', org: 'Canadá' },
  { id: 'ukmo_seamless', short: 'UKMO', org: 'Reino Unido' },
  { id: 'meteofrance_seamless', short: 'ARPEGE', org: 'França' },
  { id: 'cma_grapes_global', short: 'GRAPES', org: 'China' },
];

export const GRID = {
  latMin: -26.5, latMax: -20.5, lonMin: -55, lonMax: -49, step: 0.6,
  models: ['gfs_seamless', 'icon_seamless'],
};

const LEVELS = [925, 850, 700, 500];
// Altura padrão (m) dos níveis de pressão nos subtrópicos, usada quando o modelo não informa.
const STD_HEIGHT = { 925: 740, 850: 1480, 700: 3130, 500: 5860 };

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const round = (x, d = 0) => (x == null || Number.isNaN(x) ? null : Number(x.toFixed(d)));

export function windUV(speed, dir) {
  const r = (dir * Math.PI) / 180;
  return [-speed * Math.sin(r), -speed * Math.cos(r)];
}

// Índices de ambiente para tempestade severa em uma hora de um modelo.
// Ventos em m/s. Adaptado para o Hemisfério Sul: usa a célula que desvia para a esquerda
// e a helicidade negativa, que é a que favorece rotação ciclônica aqui.
export function severeIndices({ cape, cin, t2, td2, s10, d10, s, d, gh, elev }) {
  if (cape == null || s10 == null || d10 == null) return null;
  const pts = [];
  const [u0, v0] = windUV(s10, d10);
  pts.push({ z: 10, u: u0, v: v0 });
  for (const p of LEVELS) {
    if (s[p] == null || d[p] == null) continue;
    const z = (gh?.[p] ?? STD_HEIGHT[p]) - (elev ?? 0);
    if (z <= pts[pts.length - 1].z + 30) continue;
    const [u, v] = windUV(s[p], d[p]);
    pts.push({ z, u, v });
  }
  if (pts.length < 3) return null;
  const top = pts[pts.length - 1];
  const at = (h) => {
    for (let i = 1; i < pts.length; i++) {
      if (h <= pts[i].z) {
        const a = pts[i - 1], b = pts[i], f = (h - a.z) / (b.z - a.z);
        return { z: h, u: a.u + f * (b.u - a.u), v: a.v + f * (b.v - a.v) };
      }
    }
    return top;
  };

  const bwd = Math.hypot(top.u - u0, top.v - v0);

  // Vento médio da camada (média ponderada pela altura)
  let mu = 0, mv = 0;
  for (let i = 1; i < pts.length; i++) {
    const dz = pts[i].z - pts[i - 1].z;
    mu += ((pts[i].u + pts[i - 1].u) / 2) * dz;
    mv += ((pts[i].v + pts[i - 1].v) / 2) * dz;
  }
  mu /= top.z - pts[0].z;
  mv /= top.z - pts[0].z;

  // Movimento de supercélula pelo método de Bunkers, célula à esquerda do cisalhamento
  const low = at(500);
  const sx = top.u - (u0 + low.u) / 2;
  const sy = top.v - (v0 + low.v) / 2;
  const sm = Math.hypot(sx, sy) || 1;
  const cx = mu + (7.5 * -sy) / sm;
  const cy = mv + (7.5 * sx) / sm;

  const srh = (h) => {
    const nodes = pts.filter((p) => p.z < h);
    nodes.push(at(h));
    let total = 0;
    for (let i = 1; i < nodes.length; i++) {
      const a = nodes[i - 1], b = nodes[i];
      total += (b.u - cx) * (a.v - cy) - (a.u - cx) * (b.v - cy);
    }
    return Math.max(0, -total);
  };
  const srh1 = srh(1000);
  const srh3 = srh(3000);

  const lcl = t2 != null && td2 != null ? Math.max(0, 125 * (t2 - td2)) : null;

  // Parâmetro significativo de tornado (STP, camada fixa)
  const lclT = lcl == null ? 1 : lcl < 1000 ? 1 : lcl > 2000 ? 0 : (2000 - lcl) / 1000;
  const shrT = bwd < 12.5 ? 0 : bwd > 30 ? 1.5 : bwd / 20;
  const cinAbs = cin == null ? 0 : Math.abs(cin);
  const cinT = cinAbs > 200 ? 0 : cinAbs < 50 ? 1 : (200 - cinAbs) / 150;
  const stp = (cape / 1500) * lclT * (srh1 / 150) * shrT * cinT;

  // Parâmetro composto de supercélula (SCP)
  const shrS = bwd < 10 ? 0 : bwd > 20 ? 1 : bwd / 20;
  const scp = (cape / 1000) * (srh3 / 50) * shrS;

  return { cape, bwd, srh1, srh3, lcl, stp, scp };
}

// Escala usada na página. 0 baixo, 1 atenção, 2 alto, 3 muito alto, 4 extremo.
export function riskLevel(scp, stp) {
  if (scp == null) return null;
  if (scp >= 10 && (stp ?? 0) >= 2) return 4;
  if (scp >= 6 && (stp ?? 0) >= 0.75) return 3;
  if (scp >= 3) return 2;
  if (scp >= 1) return 1;
  return 0;
}

export const LEVEL_NAMES = ['Baixo', 'Atenção', 'Alto', 'Muito alto', 'Extremo'];

const POINT_VARS = [
  'cape', 'convective_inhibition', 'temperature_2m', 'dew_point_2m', 'wind_gusts_10m',
  'precipitation', 'weather_code', 'wind_speed_10m', 'wind_direction_10m',
  ...LEVELS.flatMap((p) => [`wind_speed_${p}hPa`, `wind_direction_${p}hPa`, `geopotential_height_${p}hPa`]),
];

function hourInput(h, i, elev, withHeights = true) {
  const s = {}, d = {}, gh = {};
  for (const p of LEVELS) {
    s[p] = h[`wind_speed_${p}hPa`]?.[i] ?? null;
    d[p] = h[`wind_direction_${p}hPa`]?.[i] ?? null;
    if (withHeights) gh[p] = h[`geopotential_height_${p}hPa`]?.[i] ?? undefined;
  }
  return {
    cape: h.cape?.[i] ?? null,
    cin: h.convective_inhibition?.[i] ?? null,
    t2: h.temperature_2m?.[i] ?? null,
    td2: h.dew_point_2m?.[i] ?? null,
    s10: h.wind_speed_10m?.[i] ?? null,
    d10: h.wind_direction_10m?.[i] ?? null,
    s, d, gh, elev,
  };
}

// Série de hora em hora, por modelo, para o ponto de Maringá.
export async function fetchModelSeries(get) {
  const base = 'https://api.open-meteo.com/v1/forecast';
  const common = `latitude=${MGA.lat}&longitude=${MGA.lon}&past_hours=3&forecast_hours=66&timeformat=unixtime&wind_speed_unit=ms&hourly=${POINT_VARS.join(',')}`;
  const results = await Promise.allSettled(MODELS.map((m) => get(`${base}?${common}&models=${m.id}`)));
  let times = null;
  const out = [];
  results.forEach((r, k) => {
    const meta = MODELS[k];
    if (r.status !== 'fulfilled' || !r.value?.hourly) return;
    const h = r.value.hourly;
    const elev = r.value.elevation ?? 555;
    if (!times) times = h.time;
    if (h.time.length !== times.length || h.time[0] !== times[0]) return;
    const row = { id: meta.id, short: meta.short, org: meta.org, scp: [], stp: [], cape: [], bwd: [], srh1: [], srh3: [], gust: [], rain: [], code: [] };
    for (let i = 0; i < times.length; i++) {
      const x = severeIndices(hourInput(h, i, elev));
      row.scp.push(round(x?.scp, 1));
      row.stp.push(round(x?.stp, 2));
      row.cape.push(round(x?.cape));
      row.bwd.push(round(x?.bwd));
      row.srh1.push(round(x?.srh1));
      row.srh3.push(round(x?.srh3));
      const g = h.wind_gusts_10m?.[i];
      row.gust.push(g == null ? null : Math.round(g * 3.6));
      row.rain.push(round(h.precipitation?.[i], 1));
      row.code.push(h.weather_code?.[i] ?? null);
    }
    if (row.scp.some((v) => v != null)) out.push(row);
  });
  if (!out.length) throw new Error('nenhum modelo respondeu');
  return { fetchedAt: Date.now(), times, models: out };
}

// Probabilidade por conjunto de cenários (ensemble) do GFS e do ECMWF.
export async function fetchEnsemble(get) {
  const base = 'https://ensemble-api.open-meteo.com/v1/ensemble';
  const vars = ['cape', 'precipitation', 'wind_gusts_10m', 'wind_speed_10m', 'wind_direction_10m', 'wind_speed_500hPa', 'wind_direction_500hPa'];
  const common = `latitude=${MGA.lat}&longitude=${MGA.lon}&forecast_hours=66&timeformat=unixtime&wind_speed_unit=ms&hourly=${vars.join(',')}`;
  const res = await Promise.allSettled(['gfs025', 'ecmwf_ifs025'].map((m) => get(`${base}?${common}&models=${m}`)));
  let times = null;
  let env, rain1, n;
  for (const r of res) {
    if (r.status !== 'fulfilled' || !r.value?.hourly) continue;
    const h = r.value.hourly;
    if (!times) {
      times = h.time;
      env = times.map(() => 0); rain1 = times.map(() => 0); n = times.map(() => 0);
    }
    if (h.time.length !== times.length) continue;
    const members = Object.keys(h).filter((k) => /^cape(_member\d+)?$/.test(k)).map((k) => k.replace('cape', ''));
    for (const sfx of members) {
      for (let i = 0; i < times.length; i++) {
        const cape = h[`cape${sfx}`]?.[i];
        const s10 = h[`wind_speed_10m${sfx}`]?.[i];
        const d10 = h[`wind_direction_10m${sfx}`]?.[i];
        const s5 = h[`wind_speed_500hPa${sfx}`]?.[i];
        const d5 = h[`wind_direction_500hPa${sfx}`]?.[i];
        if (cape == null || s10 == null || d10 == null || s5 == null || d5 == null) continue;
        const [a, b] = windUV(s10, d10);
        const [c, e] = windUV(s5, d5);
        n[i]++;
        if (cape >= 1000 && Math.hypot(c - a, e - b) >= 12.5) env[i]++;
        if ((h[`precipitation${sfx}`]?.[i] ?? 0) >= 1) rain1[i]++;
      }
    }
  }
  if (!times) throw new Error('ensemble indisponível');
  const pct = (a) => a.map((v, i) => (n[i] ? Math.round((100 * v) / n[i]) : null));
  return { fetchedAt: Date.now(), times, members: Math.max(...n), env: pct(env), rain1: pct(rain1) };
}

// Grade regional para o mapa de calor: média de GFS e ICON.
const GRID_VARS = [
  'cape', 'convective_inhibition', 'temperature_2m', 'dew_point_2m', 'wind_gusts_10m', 'precipitation',
  'wind_speed_10m', 'wind_direction_10m',
  ...LEVELS.flatMap((p) => [`wind_speed_${p}hPa`, `wind_direction_${p}hPa`]),
];

export async function fetchGrid(get, pause = async () => {}) {
  const lats = [], lons = [];
  for (let la = GRID.latMin; la <= GRID.latMax + 1e-6; la += GRID.step) lats.push(Number(la.toFixed(2)));
  for (let lo = GRID.lonMin; lo <= GRID.lonMax + 1e-6; lo += GRID.step) lons.push(Number(lo.toFixed(2)));
  const pts = [];
  for (const la of lats) for (const lo of lons) pts.push([la, lo]);
  const base = 'https://api.open-meteo.com/v1/forecast';
  let times = null;
  const sum = {}, cnt = {};
  const names = ['scp', 'stp', 'gust', 'rain', 'cape'];
  const add = (t, idx, name, val) => {
    if (val == null || Number.isNaN(val)) return;
    sum[name][t][idx] += val;
    cnt[name][t][idx] += 1;
  };
  let okModels = 0;
  for (const model of GRID.models) {
    const rows = [];
    for (let i = 0; i < pts.length; i += 60) {
      const chunk = pts.slice(i, i + 60);
      const url = `${base}?latitude=${chunk.map((p) => p[0]).join(',')}&longitude=${chunk.map((p) => p[1]).join(',')}&past_hours=1&forecast_hours=66&timeformat=unixtime&wind_speed_unit=ms&hourly=${GRID_VARS.join(',')}&models=${model}`;
      const r = await get(url);
      rows.push(...(Array.isArray(r) ? r : [r]));
      await pause();
    }
    if (rows.length !== pts.length) continue;
    if (!times) {
      times = rows[0].hourly.time;
      for (const n of names) {
        sum[n] = times.map(() => new Float64Array(pts.length));
        cnt[n] = times.map(() => new Uint8Array(pts.length));
      }
    }
    rows.forEach((row, idx) => {
      const h = row.hourly;
      for (let t = 0; t < times.length; t++) {
        const x = severeIndices(hourInput(h, t, row.elevation ?? 500, false));
        add(t, idx, 'scp', x?.scp);
        add(t, idx, 'stp', x?.stp);
        add(t, idx, 'cape', x?.cape);
        const g = h.wind_gusts_10m?.[t];
        add(t, idx, 'gust', g == null ? null : g * 3.6);
        add(t, idx, 'rain', h.precipitation?.[t]);
      }
    });
    okModels++;
  }
  if (!okModels) throw new Error('grade indisponível');
  // Inteiros para o arquivo ficar pequeno
  const scale = { scp: 10, stp: 100, gust: 1, rain: 10, cape: 0.1 };
  const layers = {};
  for (const n of names) {
    layers[n] = times.map((_, t) => Array.from(sum[n][t], (v, i) => (cnt[n][t][i] ? Math.round((v / cnt[n][t][i]) * scale[n]) : -1)));
  }
  return { fetchedAt: Date.now(), lats, lons, times, scale, layers, models: GRID.models };
}

// ---------- Avisos do INMET ----------

const BRT = '-03:00';
export const parseBRT = (s) => {
  if (!s) return null;
  const t = Date.parse(`${s.replace(' ', 'T')}:00${BRT}`);
  return Number.isNaN(t) ? null : t;
};

function simplifyRing(ring, tol) {
  if (ring.length < 8) return ring;
  const keep = new Uint8Array(ring.length);
  const mid = Math.floor(ring.length / 2);
  keep[0] = keep[mid] = keep[ring.length - 1] = 1;
  // O anel é fechado (primeiro ponto = último), então começa dividido em dois trechos.
  const stack = [[0, mid], [mid, ring.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let best = -1, bestD = tol;
    const [x1, y1] = ring[a], [x2, y2] = ring[b];
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1e-9;
    for (let i = a + 1; i < b; i++) {
      const dist = Math.abs(dy * ring[i][0] - dx * ring[i][1] + x2 * y1 - y2 * x1) / len;
      if (dist > bestD) { bestD = dist; best = i; }
    }
    if (best > 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  return ring.filter((_, i) => keep[i]).map(([x, y]) => [Number(x.toFixed(3)), Number(y.toFixed(3))]);
}

function geometryNear(a) {
  let geo;
  try {
    geo = typeof a.poligono === 'string' ? JSON.parse(a.poligono) : a.poligono;
  } catch {
    return null;
  }
  if (!geo?.coordinates) return null;
  const polys = geo.type === 'Polygon' ? [geo.coordinates] : geo.type === 'MultiPolygon' ? geo.coordinates : [];
  const out = [];
  for (const poly of polys) {
    const ring = poly[0];
    if (!ring?.length) continue;
    let minX = 999, maxX = -999, minY = 999, maxY = -999;
    for (const [x, y] of ring) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    if (maxX < -60 || minX > -44 || maxY < -30 || minY > -17) continue;
    out.push([simplifyRing(ring, 0.02)]);
  }
  return out.length ? out : null;
}

const textList = (v) => {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === 'string' && v.trim()) return [v.trim()];
  return [];
};

export function parseInmet(json) {
  const all = [
    ...(json.hoje || []).map((a) => ({ ...a, _when: 'hoje' })),
    ...(json.futuro || []).map((a) => ({ ...a, _when: 'futuro' })),
  ];
  const out = [];
  for (const a of all) {
    const covers = String(a.geocodes || '').split(',').map((s) => s.trim()).includes(MGA.ibge);
    const polygons = geometryNear(a);
    if (!covers && !polygons) continue;
    out.push({
      id: a.id,
      event: a.descricao,
      severity: a.severidade,
      severityId: Number(a.id_severidade) || 0,
      color: a.aviso_cor,
      start: parseBRT(a.inicio),
      end: parseBRT(a.fim),
      covers,
      risks: textList(a.riscos),
      instructions: textList(a.instrucoes),
      polygons,
    });
  }
  return out;
}

export const INMET_URL = 'https://apiprevmet3.inmet.gov.br/avisos/ativos';
