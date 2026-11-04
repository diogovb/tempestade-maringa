import { MGA, INMET_URL, parseInmet, riskLevel, fetchModelSeries } from './shared.js';
import { analyzeRadar, STRONG_DBZ } from './nowcast.js';

const L = window.L;
const $ = (s) => document.querySelector(s);
const SEC = 1000;
const MIN = 60_000;
const HOUR = 3_600_000;
const SITE_URL = location.origin + location.pathname.replace(/index\.html$/, '');

// ---------- Datas, sempre no horário de Brasília ----------

const pad = (n) => String(n).padStart(2, '0');
const brt = (ms) => new Date(ms - 3 * HOUR);
const hhmm = (ms) => { const d = brt(ms); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
const hh = (ms) => { const d = brt(ms); const m = d.getUTCMinutes(); return m ? `${d.getUTCHours()}h${pad(m)}` : `${d.getUTCHours()}h`; };
const WEEK = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const dayIndex = (ms) => Math.floor((ms - 3 * HOUR) / 86_400_000);
const dateShort = (ms) => { const d = brt(ms); return `${WEEK[d.getUTCDay()]} ${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}`; };
function dayName(ms) {
  const diff = dayIndex(ms) - dayIndex(Date.now());
  if (diff === 0) return 'hoje';
  if (diff === 1) return 'amanhã';
  if (diff === -1) return 'ontem';
  return dateShort(ms);
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
function duration(ms) {
  const m = Math.max(0, Math.round(ms / MIN));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  if (h >= 24) { const d = Math.floor(h / 24); return `${d}d ${h % 24}h`; }
  return r && h < 6 ? `${h}h${pad(r)}` : `${h}h`;
}
function ago(ms) {
  if (!ms) return 'sem dado';
  const s = Math.max(0, Math.round((Date.now() - ms) / SEC));
  if (s < 60) return `há ${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `há ${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `há ${h} h` : `há ${Math.round(h / 24)} dias`;
}

// ---------- Direções ----------

const COMPASS = [['norte', 'ao'], ['nordeste', 'a'], ['leste', 'a'], ['sudeste', 'a'], ['sul', 'ao'], ['sudoeste', 'a'], ['oeste', 'a'], ['noroeste', 'a']];
const compass = (b) => COMPASS[Math.round(b / 45) % 8];
const atDir = (b) => { const [n, p] = compass(b); return `${p} ${n}`; };
const toDir = (b) => `para ${compass(b)[0]}`;

// ---------- Estado ----------

const data = { alerts: null, official: null, model: null, ensemble: null, grid: null, glm: null, radarMeta: null, nowcast: null, radarError: false, cities: null, summary: null };
const view = { mode: 'radar', hourIdx: null, frameIdx: 0, stripMetric: 'scp', stripSel: null, playing: null };

async function api(name) {
  const res = await fetch(`/api/${name}`);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return res.json();
}
const safe = (fn) => { try { fn(); } catch (e) { console.error(e); } };
const nn = (v) => v != null && !Number.isNaN(v);
function median(a) {
  const v = a.filter(nn).sort((x, y) => x - y);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}
const fmt = (n) => n.toLocaleString('pt-BR');
const dec = (n, d = 1) => (nn(n) ? n.toFixed(d).replace('.', ',') : '–');

const ENV_NAMES = ['pouco favorável', 'favorável a tempestades', 'favorável a tempestades severas', 'muito favorável a supercélulas', 'muito favorável a supercélulas e tornados'];

// ---------- Resumo da previsão ----------

function computeSummary() {
  const m = data.model;
  if (!m?.models?.length) return null;
  const nowS = Date.now() / 1000;
  const T = m.times;
  const i0 = T.findIndex((t) => t > nowS - 3600);
  if (i0 < 0) return null;
  const end48 = Math.min(T.length, i0 + 48);
  const models = m.models;
  const series = T.map((t, i) => {
    const scp = median(models.map((x) => x.scp[i]));
    const stp = median(models.map((x) => x.stp[i]));
    return {
      t: t * 1000, scp, stp,
      cape: median(models.map((x) => x.cape[i])),
      bwd: median(models.map((x) => x.bwd[i])),
      srh1: median(models.map((x) => x.srh1[i])),
      level: riskLevel(scp, stp),
      favorable: models.filter((x) => (riskLevel(x.scp[i], x.stp[i]) ?? 0) >= 2).length,
      rainy: models.filter((x) => (x.rain[i] ?? 0) >= 1).length,
      n: models.filter((x) => nn(x.scp[i])).length,
    };
  });
  let peak = i0;
  for (let i = i0; i < end48; i++) if ((series[i].scp ?? 0) > (series[peak].scp ?? 0)) peak = i;

  let gustMax = null, rainMax = null;
  for (const x of models) {
    for (let i = i0; i < end48; i++) {
      if (nn(x.gust[i]) && (!gustMax || x.gust[i] > gustMax.v)) gustMax = { v: x.gust[i], model: x.short, t: T[i] * 1000 };
      if (nn(x.rain[i]) && (!rainMax || x.rain[i] > rainMax.v)) rainMax = { v: x.rain[i], model: x.short, t: T[i] * 1000 };
    }
  }
  const base = { series, i0, end48, peak, gustMax, rainMax, n: models.length };
  if ((series[peak].scp ?? 0) < 3) return { ...base, window: null };

  const thr = Math.max(3, 0.6 * series[peak].scp);
  let a = peak, b = peak;
  while (a > i0 && (series[a - 1].scp ?? 0) >= thr) a--;
  while (b < T.length - 1 && (series[b + 1].scp ?? 0) >= thr) b++;

  const agree = models.filter((x) => (riskLevel(x.scp[peak], x.stp[peak]) ?? 0) >= 2).length;
  let timing = 0;
  for (const x of models) {
    let own = i0;
    for (let i = i0; i < end48; i++) if ((x.scp[i] ?? 0) > (x.scp[own] ?? 0)) own = i;
    if (Math.abs(own - peak) <= 3) timing++;
  }
  let rainModels = 0;
  for (const x of models) {
    for (let i = Math.max(0, a - 2); i <= Math.min(T.length - 1, b + 2); i++) {
      if ((x.rain[i] ?? 0) >= 1 || (x.code[i] ?? 0) >= 95) { rainModels++; break; }
    }
  }
  let next = null;
  for (let i = b + 3; i < Math.min(T.length, i0 + 60); i++) {
    if ((series[i].scp ?? 0) >= Math.max(3, 0.5 * series[peak].scp) && (!next || series[i].scp > series[next].scp)) next = i;
  }
  let ensEnv = null;
  const e = data.ensemble;
  if (e?.times) {
    const j = e.times.findIndex((t) => t === T[peak]);
    if (j >= 0 && nn(e.env[j])) ensEnv = { pct: e.env[j], members: e.members };
  }
  const ratio = agree / models.length;
  const conf = ratio >= 0.8 && timing / models.length >= 0.6 ? 'Alta' : ratio >= 0.5 ? 'Média' : 'Baixa';
  return { ...base, window: { a, b, thr }, agree, timing, rainModels, next, ensEnv, conf };
}

// ---------- Nível oficial ----------

function activeAlerts() {
  const list = data.alerts?.alerts || [];
  const now = Date.now();
  return {
    all: list,
    active: list.filter((a) => a.covers && a.start <= now && now <= a.end).sort((x, y) => y.severityId - x.severityId),
    upcoming: list.filter((a) => a.covers && a.start > now).sort((x, y) => x.start - y.start),
    redNear: list.filter((a) => !a.covers && a.severityId >= 8 && a.start <= now && now <= a.end && a.polygons),
  };
}

function distanceToPolygons(polygons) {
  let best = null;
  const k = Math.cos((MGA.lat * Math.PI) / 180);
  const toXY = ([lon, lat]) => [(lon - MGA.lon) * 111.32 * k, (lat - MGA.lat) * 110.57];
  for (const poly of polygons) {
    const ring = poly[0].map(toXY);
    for (let i = 0; i < ring.length - 1; i++) {
      const [x1, y1] = ring[i], [x2, y2] = ring[i + 1];
      const dx = x2 - x1, dy = y2 - y1;
      const u = Math.max(0, Math.min(1, -(x1 * dx + y1 * dy) / (dx * dx + dy * dy || 1)));
      const px = x1 + u * dx, py = y1 + u * dy;
      const d = Math.hypot(px, py);
      if (!best || d < best.km) best = { km: d, bearing: ((Math.atan2(px, py) * 180) / Math.PI + 360) % 360 };
    }
  }
  return best;
}

const sevClass = (id) => (id >= 8 ? 'red' : id === 7 ? 'orange' : 'yellow');
const sevName = (id) => (id >= 8 ? 'Vermelho' : id === 7 ? 'Laranja' : 'Amarelo');

// Resume o texto do INMET em poucas palavras: vento, chuva, granizo.
function hazards(a) {
  const t = a.risks[0] || '';
  const parts = [];
  const wind = t.match(/(\d+)\s*-\s*(\d+)\s*km\/h/);
  const windOver = t.match(/(?:superior(?:es)? a|acima de)\s*(\d+)\s*km\/h/i);
  const rain = t.match(/(\d+)\s*e\s*(\d+)\s*mm\/h/);
  const rainOver = t.match(/(?:superior(?:es)? a|acima de)\s*(\d+)\s*mm\/h/i);
  if (wind) parts.push(`vento ${wind[1]}-${wind[2]} km/h`);
  else if (windOver) parts.push(`vento +${windOver[1]} km/h`);
  if (rain) parts.push(`chuva ${rain[1]}-${rain[2]} mm/h`);
  else if (rainOver) parts.push(`chuva +${rainOver[1]} mm/h`);
  if (/granizo/i.test(t)) parts.push('granizo');
  return parts.join(', ');
}

function renderBar() {
  const bar = $('#bar'), lvl = $('#lvl'), txt = $('#bar-txt');
  const d = data.alerts;
  if (!d || Date.now() - d.fetchedAt > 30 * MIN) {
    bar.className = 'bar sev-stale';
    lvl.textContent = 'INMET';
    txt.innerHTML = !d && !tried.alerts ? 'Carregando avisos' : 'Sem dado recente. Veja <a href="https://avisos.inmet.gov.br/" rel="noopener">avisos.inmet.gov.br</a>';
    return;
  }
  const { active, upcoming } = activeAlerts();
  if (active.length) {
    const top = active[0];
    bar.className = `bar sev-${sevClass(top.severityId)}`;
    lvl.textContent = sevName(top.severityId);
    const end = dayIndex(top.end) === dayIndex(Date.now()) ? hhmm(top.end) : `${dayName(top.end)} ${hhmm(top.end)}`;
    const what = hazards(top);
    const label = /tempestade/i.test(top.event) ? '' : `${top.event}: `;
    txt.textContent = `${label}${what ? `${what}, ` : ''}até ${end}`;
  } else {
    bar.className = 'bar sev-none';
    lvl.textContent = 'Sem aviso';
    const n = upcoming[0];
    txt.textContent = n ? `INMET: próximo ${dayName(n.start)}, ${hhmm(n.start)}` : 'INMET: nada ativo para Maringá';
  }
}

// ---------- Agora ----------

function nearestCity(lat, lon) {
  if (!data.cities) return null;
  let best = null, bd = 1e12;
  for (const c of data.cities) {
    const d = (c.lat - lat) ** 2 + ((c.lon - lon) * 0.92) ** 2;
    if (d < bd) { bd = d; best = c; }
  }
  return best?.n ?? null;
}

function renderNow() {
  const title = $('#now-title'), sub = $('#now-sub'), box = $('#now');
  box.classList.remove('urgent');
  const nc = data.nowcast;
  if (!nc) {
    title.textContent = data.radarError ? 'Radar indisponível' : 'Lendo o radar';
    sub.innerHTML = data.radarError ? 'Veja o <a href="https://www.simepar.br/simepar/radar_msc" rel="noopener">radar do Simepar</a>' : '';
    return;
  }
  const age = Date.now() - nc.frameTime;
  if (age > 40 * MIN) {
    title.textContent = 'Radar atrasado';
    sub.innerHTML = `Última imagem às ${hhmm(nc.frameTime)}. Veja o <a href="https://www.simepar.br/simepar/radar_msc" rel="noopener">radar do Simepar</a>`;
    return;
  }
  const threats = nc.threats || [];
  const near = (c) => { const n = nearestCity(c.nearLat, c.nearLon); return n ? `perto de ${n}` : ''; };
  if (nc.overCity >= STRONG_DBZ) {
    title.textContent = 'Tempestade forte sobre Maringá';
    sub.textContent = 'Fique em local abrigado até passar';
    box.classList.add('urgent');
  } else if (threats.length) {
    const c = threats[0];
    title.textContent = c.etaMin < 10 ? 'Célula forte chegando' : `Célula forte chega em ~${duration(c.etaMin * MIN)}`;
    sub.textContent = [`${Math.round(c.distKm)} km ${atDir(c.fromBearing)}`, near(c), `${Math.round(c.speed)} km/h`, 'se mantiver o rumo'].filter(Boolean).join(', ');
    if (c.etaMin <= 60) box.classList.add('urgent');
  } else if (nc.cells.length) {
    const c = nc.cells[0];
    title.textContent = `Célula forte a ${Math.round(c.distKm)} km ${atDir(c.fromBearing)}`;
    const moving = nn(c.speed) && c.speed >= 10
      ? `indo ${toDir(c.toBearing)} a ${Math.round(c.speed)} km/h, sem rota para Maringá agora`
      : 'sem rumo definido';
    sub.textContent = cap([near(c), moving].filter(Boolean).join(', '));
  } else if (nc.overCity >= 20) {
    title.textContent = 'Chovendo em Maringá';
    sub.textContent = 'Sem célula forte por perto';
  } else if (nc.nearestRain) {
    title.textContent = 'Sem célula forte por perto';
    sub.textContent = `Chuva mais próxima a ${Math.round(nc.nearestRain.km)} km ${atDir(nc.nearestRain.bearing)}`;
  } else {
    title.textContent = 'Sem chuva no radar';
    sub.textContent = 'Nada a até 350 km';
  }
}

function renderStats() {
  const g = data.glm;
  const fresh = g?.counts && Date.now() - g.fetchedAt < 15 * MIN;
  $('#st-flash').textContent = fresh ? fmt(g.counts['100'].last10) : '–';
  $('#st-near').textContent = fresh ? (g.nearestKm != null ? `${Math.round(g.nearestKm)} km` : '+500 km') : '–';
  const s = data.summary;
  if (s?.window) {
    const P = s.series[s.peak].t, now = Date.now();
    const B = s.series[s.window.b].t + HOUR;
    $('#st-peak').textContent = hh(P);
    $('#st-peak-sub').textContent = now < P ? `pico em ${duration(P - now)}` : now < B ? 'pico agora' : 'pico';
    $('#st-models').textContent = `${s.agree}/${s.n}`;
  } else {
    $('#st-peak').textContent = '–';
    $('#st-peak-sub').textContent = s ? 'sem pico em 48h' : 'pico previsto';
    $('#st-models').textContent = s ? `0/${s.n}` : '–';
  }
}

function renderLive() {
  const g = data.glm, nc = data.nowcast;
  const parts = [];
  let late = false;
  if (g?.newest) {
    parts.push(`raios ${ago(g.newest)}`);
    if (Date.now() - g.newest > 10 * MIN) late = true;
  }
  if (nc) {
    parts.push(`radar ${ago(nc.frameTime)}`);
    if (Date.now() - nc.frameTime > 35 * MIN) late = true;
  }
  $('#age-txt').textContent = parts.join(' · ') || 'conectando';
  $('#age').classList.toggle('late', late);
}

// ---------- Próximas horas ----------

function rangeLabel(a, b) {
  const same = dayIndex(a) === dayIndex(b);
  return same ? `${cap(dayName(a))}, ${hh(a)} às ${hh(b)}` : `${cap(dayName(a))} ${hh(a)} a ${dayName(b)} ${hh(b)}`;
}

function renderHours() {
  const s = computeSummary();
  data.summary = s;
  const title = $('#peak-title'), line = $('#peak-line'), facts = $('#facts');
  if (!s) {
    title.textContent = data.model === null ? 'Calculando' : 'Previsão indisponível';
    line.textContent = '';
    facts.innerHTML = '';
    return;
  }
  const rows = [];
  rows.push(['Pior cenário', 'Supercélula: vento destrutivo, granizo, tornado isolado']);
  if (s.gustMax) rows.push(['Rajada', `até ${s.gustMax.v} km/h nos modelos, que não enxergam célula isolada`]);
  if (!s.window) {
    title.textContent = 'Sem janela clara em 48 h';
    line.textContent = `Ambiente pouco favorável na maioria dos ${s.n} modelos`;
  } else {
    const { a, b } = s.window;
    const A = s.series[a].t, B = s.series[b].t + HOUR, P = s.series[s.peak];
    const now = Date.now();
    title.textContent = rangeLabel(A, B);
    line.textContent = now < A
      ? `Começa em ${duration(A - now)}, pico às ${hh(P.t)}`
      : now < P.t ? `Já começou, pico em ${duration(P.t - now)}` : `Pico passou, segue até ${hh(B)}`;
    const ens = s.ensEnv ? `, ${s.ensEnv.pct}% dos ${s.ensEnv.members} cenários ECMWF` : '';
    rows.push(['Ambiente', `Confiança ${s.conf.toLowerCase()}: ${s.agree} de ${s.n} modelos${ens}`]);
    rows.push(['Local exato', `Incerto: chuva em Maringá em ${s.rainModels} de ${s.n} modelos`]);
    if (s.next) rows.push(['Depois', `Nova janela ${dayName(s.series[s.next].t)}, ${hh(s.series[s.next].t)}`]);
  }
  facts.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
}

// ---------- Mapa ----------

const map = L.map('map', { center: [MGA.lat, MGA.lon], zoom: 7, minZoom: 5, maxZoom: 12, attributionControl: true, zoomControl: true });
map.attributionControl.setPrefix(false);
[['heat', 300], ['radar', 320], ['borders', 330], ['labels', 340], ['alerts', 350], ['rings', 360], ['lightning', 370], ['cells', 380]].forEach(([n, z]) => {
  const p = map.createPane(n);
  p.style.zIndex = z;
  if (n !== 'cells') p.style.pointerEvents = 'none';
});

const BASES = [
  {
    base: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    label: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
    attr: 'Mapa © Esri',
  },
  // Plano B: OpenStreetMap escurecido por CSS
  { base: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', label: null, attr: '© OpenStreetMap', className: 'osm-dark' },
];
let baseLayers = [];
function useBase(i) {
  baseLayers.forEach((l) => map.removeLayer(l));
  const b = BASES[i];
  let errors = 0;
  const main = L.tileLayer(b.base, { maxZoom: 19, maxNativeZoom: 16, attribution: b.attr, className: b.className || 'base-dim' });
  main.on('tileerror', () => { if (++errors === 6 && i + 1 < BASES.length) useBase(i + 1); });
  baseLayers = [main];
  main.addTo(map);
  if (b.label) {
    const lab = L.tileLayer(b.label, { maxZoom: 19, maxNativeZoom: 16, pane: 'labels' });
    baseLayers.push(lab);
    lab.addTo(map);
  }
}
useBase(0);

for (const km of [50, 100, 200]) {
  L.circle([MGA.lat, MGA.lon], { radius: km * 1000, color: '#c9d6df', weight: 1, opacity: 0.5, dashArray: '4 5', fill: false, interactive: false, pane: 'rings' }).addTo(map);
  L.marker([MGA.lat + km / 110.57, MGA.lon], {
    pane: 'rings', interactive: false, keyboard: false,
    icon: L.divIcon({ className: 'ring-label', html: `${km} km`, iconSize: [40, 12], iconAnchor: [20, 6] }),
  }).addTo(map);
}
L.marker([MGA.lat, MGA.lon], { pane: 'cells', interactive: false, keyboard: false, icon: L.divIcon({ className: 'city-mark', iconSize: [14, 14], iconAnchor: [7, 7] }) }).addTo(map);
L.marker([MGA.lat, MGA.lon], { pane: 'cells', interactive: false, keyboard: false, icon: L.divIcon({ className: 'city-label', html: 'Maringá', iconSize: [60, 14], iconAnchor: [-10, 7] }) }).addTo(map);

const borderRenderer = L.canvas({ pane: 'borders', padding: 0.2 });
fetch('/assets/municipios.json').then((r) => r.json()).then((m) => {
  data.cities = [
    ...m.f.map((c) => ({ n: c.n, lat: c.c[0], lon: c.c[1] })),
    ...m.extra.map(([n, lat, lon]) => ({ n, lat, lon })),
  ];
  const fc = { type: 'FeatureCollection', features: m.f.map((c) => ({ type: 'Feature', properties: { id: c.id }, geometry: { type: 'MultiPolygon', coordinates: c.g } })) };
  L.geoJSON(fc, {
    renderer: borderRenderer, interactive: false,
    style: (f) => (f.properties.id === MGA.ibge ? { color: '#ffffff', weight: 1.6, opacity: 0.95, fill: false } : { color: '#a9bac6', weight: 0.5, opacity: 0.3, fill: false }),
  }).addTo(map);
  safe(renderNow);
}).catch((e) => console.error(e));

// ---------- Mapas de calor ----------

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const RAMPS = {
  scp: {
    title: 'Supercélula: ambiente favorável, não previsão', ticks: ['1', '3', '6', '10', '16+'],
    stops: [[1, '#ffd60a', 0], [3, '#ffd60a', 0.55], [6, '#ff7a1a', 0.74], [10, '#ff2a20', 0.84], [16, '#e040c8', 0.9]],
  },
  stp: {
    title: 'Tornado: ambiente favorável, não previsão', ticks: ['0,25', '0,5', '1', '2', '4+'],
    stops: [[0.25, '#ffd60a', 0], [0.5, '#ffd60a', 0.55], [1, '#ff7a1a', 0.74], [2, '#ff2a20', 0.84], [4, '#e040c8', 0.9]],
  },
  gust: {
    title: 'Rajada prevista (km/h)', ticks: ['35', '50', '70', '90', '110+'],
    stops: [[35, '#ffd60a', 0], [50, '#ffd60a', 0.5], [70, '#ff7a1a', 0.72], [90, '#ff2a20', 0.82], [110, '#e040c8', 0.9]],
  },
  rain: {
    title: 'Chuva prevista (mm/h)', ticks: ['0,2', '1', '3', '8', '15', '30+'],
    stops: [[0.2, '#58c7f3', 0], [1, '#58c7f3', 0.5], [3, '#1f7fd8', 0.7], [8, '#ffd60a', 0.8], [15, '#ff7a1a', 0.85], [30, '#ff2a20', 0.9]],
  },
};
for (const r of Object.values(RAMPS)) r.stopsRGB = r.stops.map(([v, c, a]) => [v, ...hex(c), a]);
function rampColor(r, v) {
  const s = r.stopsRGB;
  if (v <= s[0][0]) return null;
  for (let i = 1; i < s.length; i++) {
    if (v <= s[i][0]) {
      const f = (v - s[i - 1][0]) / (s[i][0] - s[i - 1][0]);
      return [0, 1, 2, 3].map((k) => s[i - 1][k + 1] + f * (s[i][k + 1] - s[i - 1][k + 1]));
    }
  }
  return s[s.length - 1].slice(1);
}

const heatCanvas = document.createElement('canvas');
heatCanvas.width = heatCanvas.height = 256;
const heatCtx = heatCanvas.getContext('2d');
let heatOverlay = null;
const merc = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const invMerc = (m) => ((2 * Math.atan(Math.exp(m)) - Math.PI / 2) * 180) / Math.PI;

function clearHeat() {
  if (heatOverlay) { map.removeLayer(heatOverlay); heatOverlay = null; }
}
function renderHeat() {
  const g = data.grid;
  if (!g || view.mode === 'radar' || view.hourIdx == null) { clearHeat(); return; }
  const ramp = RAMPS[view.mode];
  const values = g.layers[view.mode][view.hourIdx];
  const scale = g.scale[view.mode];
  const { lats, lons } = g;
  const nLat = lats.length, nLon = lons.length;
  const south = lats[0], north = lats[nLat - 1], west = lons[0], east = lons[nLon - 1];
  const W = 256, H = 256;
  const img = heatCtx.createImageData(W, H);
  const mN = merc(north), mS = merc(south);
  for (let y = 0; y < H; y++) {
    const lat = invMerc(mN + ((mS - mN) * (y + 0.5)) / H);
    const fy = ((lat - south) / (north - south)) * (nLat - 1);
    const j0 = Math.min(nLat - 2, Math.floor(fy));
    const ty = fy - j0;
    for (let x = 0; x < W; x++) {
      const fx = ((x + 0.5) / W) * (nLon - 1);
      const i0 = Math.min(nLon - 2, Math.floor(fx));
      const tx = fx - i0;
      const v00 = values[j0 * nLon + i0], v01 = values[j0 * nLon + i0 + 1];
      const v10 = values[(j0 + 1) * nLon + i0], v11 = values[(j0 + 1) * nLon + i0 + 1];
      if (v00 < 0 || v01 < 0 || v10 < 0 || v11 < 0) continue;
      const v = ((v00 * (1 - tx) + v01 * tx) * (1 - ty) + (v10 * (1 - tx) + v11 * tx) * ty) / scale;
      const col = rampColor(ramp, v);
      if (!col) continue;
      const edge = Math.min(1, Math.min(fx, nLon - 1 - fx, fy, nLat - 1 - fy) / 0.8);
      const p = (y * W + x) * 4;
      img.data[p] = col[0];
      img.data[p + 1] = col[1];
      img.data[p + 2] = col[2];
      img.data[p + 3] = col[3] * 255 * edge;
    }
  }
  heatCtx.putImageData(img, 0, 0);
  const url = heatCanvas.toDataURL('image/png');
  const bounds = [[south, west], [north, east]];
  if (!heatOverlay) heatOverlay = L.imageOverlay(url, bounds, { pane: 'heat', interactive: false, opacity: 1 }).addTo(map);
  else heatOverlay.setUrl(url);
}

// ---------- Radar ----------

const radarLayers = new Map();
const radarFrames = () => data.radarMeta?.radar?.past || [];
function showRadarFrame(i) {
  const frames = radarFrames();
  if (!frames[i]) return;
  view.frameIdx = i;
  const visible = view.mode === 'radar';
  const f = frames[i];
  if (!radarLayers.has(f.path) && visible) {
    const layer = L.tileLayer(`${data.radarMeta.host}${f.path}/256/{z}/{x}/{y}/2/1_1.png`, {
      pane: 'radar', maxNativeZoom: 7, maxZoom: 12, opacity: 0,
      attribution: 'Radar: <a href="https://www.rainviewer.com/" rel="noopener">RainViewer</a>',
    });
    layer.addTo(map);
    radarLayers.set(f.path, layer);
  }
  radarLayers.forEach((l, p) => l.setOpacity(visible && p === f.path ? 0.86 : 0));
}
function clearRadarLayers() {
  radarLayers.forEach((l) => map.removeLayer(l));
  radarLayers.clear();
}

// ---------- Avisos, raios e células ----------

const alertGroup = L.layerGroup().addTo(map);
const glmGroup = L.layerGroup().addTo(map);
const cellGroup = L.layerGroup().addTo(map);
const glmRenderer = L.canvas({ pane: 'lightning', padding: 0.1 });
const pingRenderer = L.svg({ pane: 'lightning' });

function mapTime() {
  if (view.mode !== 'radar' && data.grid && view.hourIdx != null) return data.grid.times[view.hourIdx] * 1000;
  return Date.now();
}

function renderAlertsOnMap() {
  alertGroup.clearLayers();
  const t = mapTime();
  const list = (data.alerts?.alerts || [])
    .filter((a) => a.polygons && a.start <= t && t <= a.end && /tempestade|chuva|vendaval|granizo|acumulado/i.test(a.event))
    .sort((x, y) => x.severityId - y.severityId);
  for (const a of list) {
    L.geoJSON({ type: 'MultiPolygon', coordinates: a.polygons }, {
      pane: 'alerts', interactive: false,
      style: { color: a.color, weight: a.severityId >= 8 ? 3 : 2, opacity: 0.95, fillColor: a.color, fillOpacity: a.severityId >= 8 ? 0.07 : 0 },
    }).addTo(alertGroup);
  }
}

function renderGlmOnMap() {
  glmGroup.clearLayers();
  const g = data.glm;
  if (view.mode !== 'radar' || !g?.flashes) return;
  if (Date.now() - g.fetchedAt > 15 * MIN) return;
  const drift = (Date.now() - g.fetchedAt) / SEC;
  const pings = [];
  for (const [lat, lon, ageS] of g.flashes) {
    const age = ageS + drift;
    if (age > 600) continue;
    const recent = age <= 120;
    L.circleMarker([lat, lon], {
      renderer: glmRenderer, stroke: false, interactive: false, fillOpacity: 0.95,
      radius: recent ? 2.4 : age <= 300 ? 1.8 : 1.3,
      fillColor: recent ? '#ffffff' : age <= 300 ? '#ffe14d' : '#ff9f40',
    }).addTo(glmGroup);
    if (age <= 100) pings.push([lat, lon, (lat - MGA.lat) ** 2 + (lon - MGA.lon) ** 2]);
  }
  pings.sort((a, b) => a[2] - b[2]);
  for (const [lat, lon] of pings.slice(0, 20)) {
    L.circleMarker([lat, lon], { renderer: pingRenderer, radius: 11, color: '#ffffff', weight: 1.5, fill: false, interactive: false, className: 'flash-ping' }).addTo(glmGroup);
  }
}

function destination(lat, lon, b, km) {
  const p = Math.PI / 180, d = km / 6371;
  const la = Math.asin(Math.sin(lat * p) * Math.cos(d) + Math.cos(lat * p) * Math.sin(d) * Math.cos(b * p));
  const lo = lon * p + Math.atan2(Math.sin(b * p) * Math.sin(d) * Math.cos(lat * p), Math.cos(d) - Math.sin(lat * p) * Math.sin(la));
  return [la / p, lo / p];
}

function renderCellsOnMap() {
  cellGroup.clearLayers();
  const nc = data.nowcast;
  if (!nc || view.mode !== 'radar' || Date.now() - nc.frameTime > 60 * MIN) return;
  for (const c of nc.cells.slice(0, 18)) {
    const color = c.threat ? '#ff4d42' : '#ffffff';
    const place = nearestCity(c.lat, c.lon);
    const moving = nn(c.speed) && c.speed >= 10;
    const tip = `${place || 'Célula forte'}: ${Math.round(c.distKm)} km de Maringá${moving ? `, ${toDir(c.toBearing)} a ${Math.round(c.speed)} km/h` : ''}${c.threat ? `, chega em ~${duration(c.etaMin * MIN)}` : ''}`;
    L.circleMarker([c.lat, c.lon], { pane: 'cells', radius: c.threat ? 7 : 5, color, weight: 2, fill: true, fillOpacity: 0, }).bindTooltip(tip).addTo(cellGroup);
    if (moving) {
      const end = destination(c.lat, c.lon, c.toBearing, c.speed);
      const left = destination(end[0], end[1], c.toBearing + 150, 7);
      const right = destination(end[0], end[1], c.toBearing - 150, 7);
      L.polyline([[c.lat, c.lon], end], { pane: 'cells', color, weight: 2, opacity: 0.9, interactive: false }).addTo(cellGroup);
      L.polyline([left, end, right], { pane: 'cells', color, weight: 2, opacity: 0.9, interactive: false }).addTo(cellGroup);
    }
  }
}

// ---------- Controles do mapa ----------

const TABS = [['radar', 'Radar'], ['scp', 'Supercélula'], ['stp', 'Tornado'], ['gust', 'Rajadas'], ['rain', 'Chuva']];
const tabsEl = $('#tabs');
for (const [id, label] of TABS) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.dataset.mode = id;
  b.setAttribute('role', 'tab');
  b.setAttribute('aria-selected', id === view.mode ? 'true' : 'false');
  b.addEventListener('click', () => setMode(id));
  tabsEl.append(b);
}

function gridHours() {
  const g = data.grid;
  if (!g) return [];
  const nowS = Date.now() / 1000;
  const out = [];
  g.times.forEach((t, i) => { if (t > nowS - 3600) out.push(i); });
  return out;
}

function defaultHour() {
  const s = data.summary, g = data.grid;
  if (!g) return null;
  if (s?.window) {
    const i = g.times.findIndex((t) => t === s.series[s.peak].t / 1000);
    if (i >= 0) return i;
  }
  return gridHours()[0] ?? null;
}

function setMode(mode) {
  stopPlay();
  view.mode = mode;
  tabsEl.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', b.dataset.mode === mode ? 'true' : 'false'));
  if (mode === 'radar') {
    clearHeat();
    showRadarFrame(radarFrames().length - 1);
  } else {
    radarLayers.forEach((l) => l.setOpacity(0));
    if (view.hourIdx == null || !gridHours().includes(view.hourIdx)) view.hourIdx = defaultHour();
  }
  safe(syncMapUI);
  safe(renderHeat);
  safe(renderAlertsOnMap);
  safe(renderGlmOnMap);
  safe(renderCellsOnMap);
}

function renderLegend() {
  const el = $('#legend');
  if (view.mode === 'radar') {
    const colors = ['#88ddee', '#00a3e0', '#005588', '#ffee00', '#ffaa00', '#ff4400', '#c10000', '#ffaaff'];
    el.innerHTML = `<div class="legend-bar">${colors.map((c) => `<i style="background:${c}"></i>`).join('')}</div><div class="legend-ticks"><span>fraca</span><span>forte</span><span>granizo</span></div>`;
  } else {
    const r = RAMPS[view.mode];
    const cols = r.stops.slice(1).map((s) => s[1]);
    el.innerHTML = `<strong>${r.title}</strong><div class="legend-bar">${cols.map((c) => `<i style="background:${c}"></i>`).join('')}</div><div class="legend-ticks">${r.ticks.map((t) => `<span>${t}</span>`).join('')}</div>`;
  }
}

function syncMapUI() {
  const range = $('#time'), label = $('#time-label');
  if (view.mode === 'radar') {
    const frames = radarFrames();
    range.max = Math.max(0, frames.length - 1);
    range.value = view.frameIdx;
    const f = frames[view.frameIdx];
    label.innerHTML = f ? `${hhmm(f.time * 1000)}<small>${ago(f.time * 1000)}</small>` : '--';
  } else {
    const hours = gridHours();
    range.max = Math.max(0, hours.length - 1);
    range.value = Math.max(0, hours.indexOf(view.hourIdx));
    const ms = data.grid && view.hourIdx != null ? data.grid.times[view.hourIdx] * 1000 : null;
    label.innerHTML = ms
      ? `${cap(dayName(ms))} ${hh(ms)}<small>${ms <= Date.now() ? 'agora' : `em ${duration(ms - Date.now())}`}</small>`
      : (data.gridError ? 'Sem dado<small>tentando</small>' : 'Carregando');
  }
  renderLegend();
}

$('#time').addEventListener('input', (e) => {
  stopPlay();
  const v = Number(e.target.value);
  if (view.mode === 'radar') {
    showRadarFrame(v);
  } else {
    view.hourIdx = gridHours()[v] ?? view.hourIdx;
    safe(renderHeat);
    safe(renderAlertsOnMap);
  }
  safe(syncMapUI);
});

function stopPlay() {
  if (view.playing) { clearInterval(view.playing); view.playing = null; $('#play').textContent = '▶'; $('#play').setAttribute('aria-label', 'Animar'); }
}
$('#play').addEventListener('click', () => {
  if (view.playing) { stopPlay(); return; }
  $('#play').textContent = '❚❚';
  $('#play').setAttribute('aria-label', 'Pausar');
  view.playing = setInterval(() => {
    if (view.mode === 'radar') {
      const n = radarFrames().length;
      if (n) showRadarFrame((view.frameIdx + 1) % n);
    } else {
      const hours = gridHours();
      if (hours.length) {
        view.hourIdx = hours[(hours.indexOf(view.hourIdx) + 1) % hours.length];
        safe(renderHeat);
        safe(renderAlertsOnMap);
      }
    }
    safe(syncMapUI);
  }, view.mode === 'radar' ? 650 : 480);
});

// ---------- Painéis ----------

const sheet = $('#sheet');
const panels = [...document.querySelectorAll('[data-panel]')];
const isDesktop = () => window.matchMedia('(min-width: 1000px)').matches;
function closePanel() {
  sheet.classList.remove('open');
  panels.forEach((p) => p.classList.remove('open'));
  document.querySelectorAll('.nav button').forEach((b) => b.classList.remove('on'));
}
function openPanel(name) {
  const panel = panels.find((p) => p.dataset.panel === name);
  if (isDesktop()) { panel.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
  if (panel.classList.contains('open')) { closePanel(); return; }
  sheet.style.top = `${$('#now').getBoundingClientRect().bottom}px`;
  sheet.style.bottom = `${$('.nav').offsetHeight}px`;
  sheet.classList.add('open');
  panels.forEach((p) => p.classList.toggle('open', p === panel));
  document.querySelectorAll('.nav button').forEach((b) => b.classList.toggle('on', b.dataset.open === name));
  sheet.scrollTop = 0;
  safe(drawStrip);
}
document.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openPanel(b.dataset.open)));
$('#sheet-close').addEventListener('click', closePanel);

// ---------- Faixa hora a hora ----------

const STRIP_SCALE = {
  scp: { steps: [1, 3, 6, 10, 15], labels: ['<1', '1-3', '3-6', '6-10', '10-15', '15+'] },
  stp: { steps: [0.25, 0.5, 1, 2, 4], labels: ['<0,25', '0,25-0,5', '0,5-1', '1-2', '2-4', '4+'] },
};
const STRIP_COLORS = ['#1a232b', '#5e5f1c', '#d9a800', '#f2690d', '#e5222b', '#d61fb4'];
const RAIN_COLORS = ['#1a232b', '#17415f', '#1d6aa5', '#2b93d9', '#58c7f3'];
const stripColor = (metric, v) => {
  if (!nn(v)) return '#0e1419';
  const st = STRIP_SCALE[metric].steps;
  let i = 0;
  while (i < st.length && v >= st[i]) i++;
  return STRIP_COLORS[i];
};

function drawStrip() {
  const canvas = $('#strip');
  const m = data.model, s = data.summary;
  if (!m?.models?.length || !s) return;
  const metric = view.stripMetric;
  const W = canvas.parentElement.clientWidth;
  if (!W) return;
  const labelW = 58, top = 30, rowH = 19;
  const start = Math.max(0, s.i0 - 3);
  const cols = m.times.length - start;
  const cellW = (W - labelW) / cols;
  const rows = 1 + m.models.length + 1;
  const H = top + rows * rowH + 6;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.height = `${H}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.textBaseline = 'middle';
  const rowY = (r) => top + r * rowH;
  const label = (txt, r, strong) => {
    ctx.fillStyle = strong ? '#eef3f6' : '#a3b4c0';
    ctx.font = `${strong ? 700 : 500} 12px Barlow, system-ui, sans-serif`;
    ctx.fillText(txt, 0, rowY(r) + rowH / 2);
  };
  label('Todos', 0, true);
  m.models.forEach((x, k) => label(x.short, k + 1));
  label('Chuva', rows - 1);

  for (let c = 0; c < cols; c++) {
    const i = start + c;
    const x = labelW + c * cellW;
    ctx.fillStyle = stripColor(metric, s.series[i][metric]);
    ctx.fillRect(x, rowY(0), Math.ceil(cellW), rowH - 3);
    m.models.forEach((mm, k) => {
      ctx.fillStyle = stripColor(metric, mm[metric][i]);
      ctx.fillRect(x, rowY(k + 1), Math.ceil(cellW), rowH - 1);
    });
    const frac = s.series[i].rainy / (s.series[i].n || 1);
    ctx.fillStyle = RAIN_COLORS[frac === 0 ? 0 : frac < 0.25 ? 1 : frac < 0.5 ? 2 : frac < 0.75 ? 3 : 4];
    ctx.fillRect(x, rowY(rows - 1) + 2, Math.ceil(cellW), rowH - 3);
  }

  ctx.textBaseline = 'alphabetic';
  let lastDay = null;
  const compact = cellW * 24 < 100;
  const toMidnight = 24 - brt(m.times[start] * 1000).getUTCHours();
  for (let c = 0; c < cols; c++) {
    const ms = m.times[start + c] * 1000;
    const d = brt(ms);
    const x = labelW + c * cellW;
    const hour = d.getUTCHours();
    const dayKey = dayIndex(ms);
    if (dayKey !== lastDay) {
      ctx.fillStyle = '#eef3f6';
      ctx.font = '600 12px Barlow, system-ui, sans-serif';
      const text = compact ? `${WEEK[d.getUTCDay()]} ${d.getUTCDate()}` : dateShort(ms);
      const fits = lastDay !== null || toMidnight * cellW >= (compact ? 42 : 66);
      if ((hour === 0 || lastDay === null) && fits) ctx.fillText(text, Math.min(x + 2, W - 64), 12);
      if (hour === 0) {
        ctx.fillStyle = 'rgba(238,243,246,.5)';
        ctx.fillRect(x, 16, 1, H - 22);
      }
      lastDay = dayKey;
    }
    if (hour % 6 === 0 && hour !== 0 && cellW * 6 > 26) {
      ctx.fillStyle = '#a3b4c0';
      ctx.font = '500 11px Barlow, system-ui, sans-serif';
      ctx.fillText(`${hour}h`, x + 1, 26);
    }
  }
  const nowX = labelW + ((Date.now() / 1000 - m.times[start]) / 3600) * cellW;
  if (nowX > labelW && nowX < W) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(nowX - 1, top - 3, 2, H - top - 2);
  }
  if (view.stripSel != null && view.stripSel >= start) {
    const x = labelW + (view.stripSel - start) * cellW;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x - 0.5, top - 1, Math.max(cellW, 3) + 1, H - top - 3);
  }
  canvas.dataset.start = start;
  canvas.dataset.labelW = labelW;
  canvas.dataset.cellW = cellW;
  canvas.setAttribute('aria-label', `Tabela por hora e por modelo. Pico às ${hh(s.series[s.peak].t)} de ${dayName(s.series[s.peak].t)}.`);
  const sc = STRIP_SCALE[metric];
  $('#strip-scale').innerHTML = sc.labels.map((l, i) => `<span><i style="background:${STRIP_COLORS[i]}"></i>${l}</span>`).join('');
}

function renderStripDetail() {
  const el = $('#strip-detail'), s = data.summary, m = data.model;
  if (!s || !m) { el.textContent = ''; return; }
  const x = s.series[view.stripSel ?? s.peak];
  if (!x) return;
  el.textContent = `${cap(dayName(x.t))} ${hh(x.t)}${view.stripSel == null ? ' (pico)' : ''}: ${ENV_NAMES[x.level ?? 0]}. SCP ${dec(x.scp)}, STP ${dec(x.stp)}. ${x.favorable} de ${x.n} favoráveis, ${x.rainy} com chuva.`;
  $('#strip-map').hidden = !data.grid;
}
$('#strip').addEventListener('click', (e) => {
  const c = e.currentTarget;
  const x = e.clientX - c.getBoundingClientRect().left - Number(c.dataset.labelW);
  if (x < 0) return;
  view.stripSel = Number(c.dataset.start) + Math.floor(x / Number(c.dataset.cellW));
  safe(drawStrip);
  safe(renderStripDetail);
});
function setStrip(metric) {
  view.stripMetric = metric;
  $('#st-scp').classList.toggle('on', metric === 'scp');
  $('#st-stp').classList.toggle('on', metric === 'stp');
  safe(drawStrip);
}
$('#st-scp').addEventListener('click', () => setStrip('scp'));
$('#st-stp').addEventListener('click', () => setStrip('stp'));
$('#strip-map').addEventListener('click', () => {
  const s = data.summary, g = data.grid;
  if (!s || !g) return;
  const i = g.times.findIndex((t) => t === s.series[view.stripSel ?? s.peak].t / 1000);
  if (i >= 0) view.hourIdx = i;
  setMode(view.mode === 'radar' ? view.stripMetric : view.mode);
  closePanel();
});

// ---------- Fontes ----------

const BRIEF_UNTIL = Date.parse('2026-11-06T06:00:00-03:00');
const a = (href, text) => `<a href="${href}" rel="noopener">${text}</a>`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const timeTag = (ms, maxMin) => {
  if (!ms) return '<span class="agency-time old">sem dado</span>';
  const old = Date.now() - ms > maxMin * MIN;
  return `<span class="agency-time${old ? ' old' : ''}">${ago(ms)}</span>`;
};
const agency = (name, time, body) => `<div class="agency"><div class="agency-head"><span class="agency-name">${name}</span>${time || ''}</div>${body}</div>`;

function renderSources() {
  const out = [];
  const inBrief = Date.now() < BRIEF_UNTIL;

  const al = data.alerts;
  if (al) {
    const { active, upcoming, redNear } = activeAlerts();
    const rows = [...active, ...upcoming].filter((x) => x.end > Date.now() && /tempestade|chuva|vendaval/i.test(x.event)).sort((x, y) => x.start - y.start || y.severityId - x.severityId).slice(0, 4);
    const list = rows.length
      ? `<ul>${rows.map((x) => `<li><span class="chip ${sevClass(x.severityId)}">${sevName(x.severityId)}</span>${esc(x.event)}, ${x.start <= Date.now() ? `até ${dayName(x.end)} ${hhmm(x.end)}` : dayName(x.start)}</li>`).join('')}</ul>`
      : '<p>Nenhum aviso para Maringá.</p>';
    let red = '';
    if (redNear.length && !active.some((x) => x.severityId >= 8)) {
      let best = null;
      for (const x of redNear) {
        const d = distanceToPolygons(x.polygons);
        if (d && (!best || d.km < best.km)) best = d;
      }
      if (best) red = `<p>Aviso vermelho mais próximo: ${Math.round(best.km)} km ${atDir(best.bearing)}.</p>`;
    }
    out.push(agency('INMET', timeTag(al.fetchedAt, 30), `${list}${red}<div class="links">${a('https://avisos.inmet.gov.br/', 'Mapa de avisos')}</div>`));
  } else {
    out.push(agency('INMET', timeTag(null), `<div class="links">${a('https://avisos.inmet.gov.br/', 'Abrir o site do INMET')}</div>`));
  }

  const dc = data.official?.defesaCivil;
  const bol = dc?.boletimUrl ? a(dc.boletimUrl, `Boletim nº ${dc.boletimNumber}`) : a('https://www.defesacivil.pr.gov.br/Pagina/Boletins-de-Gestao-de-Risco', 'Boletins');
  const dcBrief = inBrief ? `<p>Risco alto no Norte, muito alto no Oeste e Centro-Oeste (${a('https://massa.com.br/tempo-clima/risco-de-tempestades-no-parana', 'Massa')}). Tempestades severas até o início da manhã de 5/11.</p>` : '';
  out.push(agency('Defesa Civil PR', '', `${dcBrief}<div class="links">${bol}${a('https://www.defesacivil.pr.gov.br/Pagina/Alertas-da-Defesa-Civil', 'Receber alertas')}</div>`));

  const spBrief = inBrief ? '<p>Radar de Cascavel fora do ar em 4/11. O mosaico deles usa só Teixeira Soares.</p>' : '';
  out.push(agency('Simepar', '', `${spBrief}<div class="links">${a('https://www.simepar.br/simepar/radar_msc', 'Radar oficial')}${a('https://www.simepar.br/simepar/raios_simepar', 'Raios')}${a(`https://www.simepar.br/simepar/forecast_by_counties/${MGA.ibge}`, 'Previsão')}</div><p class="note">O site não permite leitura automática, por isso só o link.</p>`));

  const g = data.glm;
  if (g?.counts) {
    const row = (r) => {
      const c = g.counts[r];
      const trend = c.last10 + c.prev10 === 0 ? '–' : c.last10 > c.prev10 * 1.25 ? 'subindo' : c.last10 < c.prev10 * 0.75 ? 'caindo' : 'estável';
      return `<tr><td>${r} km</td><td>${fmt(c.last10)}</td><td>${trend}</td></tr>`;
    };
    out.push(agency('Raios: NOAA GOES-19', timeTag(g.newest, 10), `<table class="mini-table"><thead><tr><th>Até</th><th>10 min</th><th>Tendência</th></tr></thead><tbody>${row('50')}${row('100')}${row('200')}</tbody></table>`));
  }

  out.push(agency('Radar: RainViewer', timeTag(data.nowcast?.frameTime, 35), '<p class="note">Mosaico público, nova imagem a cada 10 min.</p>'));

  const names = (data.model?.models || []).map((m) => m.short).join(', ');
  out.push(agency('Modelos', timeTag(data.model?.fetchedAt, 180), `<p>${names || 'Carregando'}.</p><p class="note">Mapa de calor: GFS e ICON ${data.grid ? ago(data.grid.fetchedAt) : ''}. Via Open-Meteo.</p>`));

  const met = (data.official?.metar || []).filter((m) => m.station === 'SBMG').sort((x, y) => y.at - x.at)[0];
  if (met) {
    const wind = met.wind != null ? `vento ${met.wind} km/h${met.gust ? `, rajada ${met.gust}` : ''}` : '';
    out.push(agency('Aeroporto de Maringá', timeTag(met.at, 100), `<p>${[met.temp != null ? `${met.temp} °C` : '', wind, met.thunder ? 'trovoada' : 'sem trovoada'].filter(Boolean).join(', ')}</p>`));
  }

  const cm = data.alerts?.cemaden;
  if (cm) {
    const pr = cm.pr || [];
    out.push(agency('Cemaden', '', `<p>${pr.length ? `${pr.length} alerta(s) no Paraná` : 'Nenhum alerta no Paraná'}, enchente e deslizamento.</p>`));
  }

  const pv = inBrief ? ' (mapa de 4/11: Maringá entre os níveis 1 e 2, experimental)' : '';
  out.push(agency('Mais', '', `<div class="links">${a('https://prevots.org/previsao-convectiva/', 'PREVOTS')}${a('https://satelite.cptec.inpe.br/', 'CPTEC/INPE')}${a('https://redemet.decea.mil.br/', 'REDEMET')}${a('https://painelalertas.cemaden.gov.br/', 'Cemaden')}</div>${pv ? `<p class="note">PREVOTS${pv}.</p>` : ''}`));

  $('#agencies').innerHTML = out.join('');
}

// ---------- Compartilhar ----------

$('#share-wa').href = `https://wa.me/?text=${encodeURIComponent(`Radar, raios e avisos do INMET ao vivo para Maringá: ${SITE_URL}`)}`;
$('#share-copy').addEventListener('click', async (e) => {
  const b = e.currentTarget;
  try {
    await navigator.clipboard.writeText(SITE_URL);
    b.textContent = 'Link copiado';
  } catch {
    b.textContent = SITE_URL;
  }
  setTimeout(() => { b.textContent = 'Copiar link'; }, 4000);
});

// ---------- Ciclo de atualização ----------

function renderAll() {
  safe(renderBar);
  safe(renderHours);
  safe(renderNow);
  safe(renderStats);
  safe(renderLive);
  safe(renderSources);
  safe(syncMapUI);
  safe(renderAlertsOnMap);
  safe(renderGlmOnMap);
  safe(renderCellsOnMap);
  safe(renderHeat);
  safe(drawStrip);
  safe(renderStripDetail);
}

// Quando uma fonte falha, tenta de novo logo, com espera crescente.
const tried = {};
const attempts = {};
const retryTimers = {};
async function guarded(key, load, onOk, onFail) {
  try {
    const d = await load();
    tried[key] = true;
    attempts[key] = 0;
    clearTimeout(retryTimers[key]);
    onOk(d);
  } catch (e) {
    console.warn(key, e);
    tried[key] = true;
    attempts[key] = (attempts[key] || 0) + 1;
    clearTimeout(retryTimers[key]);
    const wait = Math.min(5 * MIN, 15_000 * 2 ** attempts[key]) + Math.random() * 10_000;
    retryTimers[key] = setTimeout(() => guarded(key, load, onOk, onFail), wait);
    if (onFail) onFail(e);
  }
}

function refreshAlerts() {
  return guarded('alerts', async () => {
    let d = null;
    try { d = await api('alerts'); } catch (e) { console.warn(e); }
    if (!d || Date.now() - d.fetchedAt > 20 * MIN) {
      // Plano B: lê direto do INMET se o nosso servidor falhar
      try {
        const j = await (await fetch(INMET_URL)).json();
        d = { fetchedAt: Date.now(), alerts: parseInmet(j), cemaden: d?.cemaden ?? data.alerts?.cemaden ?? null };
      } catch (e) { console.warn(e); }
    }
    if (!d) throw new Error('avisos indisponíveis');
    return d;
  }, (d) => { data.alerts = d; safe(renderBar); safe(renderSources); safe(renderAlertsOnMap); }, () => safe(renderBar));
}
function refreshOfficial() {
  return guarded('official', () => api('official'), (d) => { data.official = d; safe(renderSources); });
}
function refreshGlm() {
  return guarded('glm', () => api('glm'), (d) => { data.glm = d; safe(renderStats); safe(renderLive); safe(renderGlmOnMap); safe(renderSources); });
}
function refreshModel() {
  return guarded('model', async () => {
    let d = null;
    try { d = await api('model'); } catch (e) { console.warn(e); }
    if (!d || Date.now() - d.fetchedAt > 3 * HOUR) {
      d = await fetchModelSeries(async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
    }
    return d;
  }, (d) => { data.model = d; renderAll(); }, () => { data.model = data.model ?? false; safe(renderHours); });
}
function refreshEnsemble() {
  return guarded('ensemble', () => api('ensemble'), (d) => { data.ensemble = d; safe(renderHours); });
}
function refreshGrid() {
  return guarded('grid', () => api('grid'), (d) => {
    data.grid = d;
    data.gridError = false;
    if (view.hourIdx == null || !gridHours().includes(view.hourIdx)) view.hourIdx = defaultHour();
    safe(renderHeat); safe(syncMapUI); safe(renderSources);
  }, () => { data.gridError = true; safe(syncMapUI); });
}

let lastFrame = null;
let analyzing = false;
async function refreshRadar() {
  try {
    const meta = await (await fetch('https://api.rainviewer.com/public/weather-maps.json')).json();
    const frames = meta?.radar?.past || [];
    if (!frames.length) throw new Error('sem imagens');
    const newest = frames[frames.length - 1].path;
    const atLatest = view.frameIdx >= radarFrames().length - 1;
    const changed = newest !== lastFrame;
    data.radarMeta = meta;
    data.radarError = false;
    if (changed) {
      clearRadarLayers();
      lastFrame = newest;
    }
    if (changed || atLatest) showRadarFrame(frames.length - 1);
    safe(syncMapUI);
    if (changed && !analyzing) {
      analyzing = true;
      try {
        data.nowcast = await analyzeRadar(meta);
      } finally {
        analyzing = false;
      }
      safe(renderNow); safe(renderLive); safe(renderCellsOnMap); safe(renderSources);
    }
  } catch (e) {
    console.warn(e);
    if (!data.nowcast) data.radarError = true;
    safe(renderNow);
  }
}

function every(ms, fn) {
  setInterval(() => { if (!document.hidden) fn(); }, ms);
}

function tick() {
  const n = brt(Date.now());
  $('#clock').textContent = `${pad(n.getUTCHours())}:${pad(n.getUTCMinutes())}`;
  safe(renderLive);
}

// Início
tick();
setInterval(tick, 5_000);
safe(renderLegend);
safe(renderSources);
refreshAlerts();
refreshRadar();
refreshGlm();
refreshOfficial();
refreshModel().then(() => { refreshGrid(); refreshEnsemble(); });

// O que muda a cada minuto é lido a cada minuto
every(MIN, refreshAlerts);
every(MIN, refreshRadar);
every(MIN, refreshGlm);
every(10 * MIN, refreshOfficial);
every(15 * MIN, refreshModel);
every(60 * MIN, refreshEnsemble);
every(30 * MIN, refreshGrid);
every(MIN, () => { safe(renderBar); safe(renderHours); safe(renderNow); safe(renderStats); safe(syncMapUI); safe(renderGlmOnMap); });

// Ao voltar para a aba, atualiza na hora
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { hiddenAt = Date.now(); return; }
  if (Date.now() - hiddenAt > 20_000) { refreshAlerts(); refreshRadar(); refreshGlm(); }
});
window.addEventListener('resize', () => { safe(drawStrip); map.invalidateSize(); });
