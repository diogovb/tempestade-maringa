import { MGA, INMET_URL, parseInmet, riskLevel, fetchModelSeries } from './shared.js';
import { analyzeRadar, distanceKm, bearing, STRONG_DBZ } from './nowcast.js';

const L = window.L;
const $ = (s) => document.querySelector(s);
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
// "por volta das 20h", "por volta da 1h", "por volta da meia-noite"
function around(ms) {
  const h = brt(ms).getUTCHours();
  if (h === 0) return 'por volta da meia-noite';
  if (h === 1) return 'por volta da 1h';
  return `por volta das ${h}h`;
}
function duration(ms) {
  const m = Math.max(0, Math.round(ms / MIN));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  if (h >= 24) { const d = Math.floor(h / 24); return `${d} dia${d > 1 ? 's' : ''} e ${h % 24} h`; }
  return r && h < 6 ? `${h}h${pad(r)}` : `${h} h`;
}
function ago(ms) {
  if (!ms) return 'sem dado';
  const m = Math.round((Date.now() - ms) / MIN);
  if (m <= 0) return 'agora';
  if (m < 60) return `há ${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `há ${h} h` : `há ${Math.round(h / 24)} dias`;
}

// ---------- Direções ----------

const COMPASS = [['norte', 'ao'], ['nordeste', 'a'], ['leste', 'a'], ['sudeste', 'a'], ['sul', 'ao'], ['sudoeste', 'a'], ['oeste', 'a'], ['noroeste', 'a']];
const compass = (b) => COMPASS[Math.round(b / 45) % 8];
const atDir = (b) => { const [n, p] = compass(b); return `${p} ${n}`; };
const toDir = (b) => `para o ${compass(b)[0]}`;

// ---------- Estado ----------

const data = { alerts: null, official: null, model: null, ensemble: null, grid: null, glm: null, radarMeta: null, nowcast: null, radarError: false, cities: null };
const view = { mode: 'radar', hourIdx: null, frameIdx: 0, stripMetric: 'scp', stripSel: null, playing: null, heatTouched: false };

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

// ---------- Faixa de status ----------

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

function renderStatus() {
  const box = $('#status');
  const d = data.alerts;
  const setSev = (c) => { box.className = `status sev-${c}`; };
  const tag = $('#status-tag'), title = $('#status-title'), detail = $('#status-detail'), near = $('#status-near');
  near.hidden = true;
  $('#status-fresh').textContent = d ? `INMET consultado às ${hhmm(d.fetchedAt)}. A página se atualiza sozinha.` : '';
  if (!d) {
    setSev('stale');
    tag.textContent = 'Avisos oficiais';
    title.textContent = 'Não consegui ler os avisos do INMET';
    detail.innerHTML = 'Isso não quer dizer que não há aviso. Confira em <a href="https://avisos.inmet.gov.br/" rel="noopener">avisos.inmet.gov.br</a>.';
    return;
  }
  const { active, upcoming, redNear } = activeAlerts();
  const stale = Date.now() - d.fetchedAt > 30 * MIN;
  if (stale) {
    setSev('stale');
    tag.textContent = `Avisos do INMET de ${ago(d.fetchedAt)}`;
    title.textContent = 'Os avisos oficiais estão desatualizados';
    detail.innerHTML = `Último dado às ${hhmm(d.fetchedAt)}. Confira em <a href="https://avisos.inmet.gov.br/" rel="noopener">avisos.inmet.gov.br</a>.`;
    return;
  }
  if (active.length) {
    const top = active[0];
    const c = sevClass(top.severityId);
    setSev(c);
    tag.textContent = `Aviso oficial ativo · INMET · ${sevName(top.severityId)} · ${top.severity}`;
    const ev = top.event.toLowerCase();
    title.textContent = top.severityId >= 8
      ? `Aviso vermelho de ${ev} para Maringá`
      : top.severityId === 7
        ? (/tempestade/i.test(top.event) ? 'Risco alto de tempestades em Maringá' : `Aviso laranja de ${ev} para Maringá`)
        : (/tempestade/i.test(top.event) ? 'Atenção para tempestades em Maringá' : `Aviso amarelo de ${ev} para Maringá`);
    // Só a primeira frase do aviso: o que pode acontecer. O texto completo fica no site do INMET.
    const risk = top.risks[0] ? `${top.risks[0].split(/(?<=\.)\s+/)[0]} ` : '';
    const nextSame = upcoming.find((a) => a.severityId >= top.severityId && /tempestade/i.test(a.event));
    detail.textContent = `${risk}Válido até ${dayName(top.end)} às ${hhmm(top.end)}.${nextSame ? ` Há novo aviso ${sevName(nextSame.severityId).toLowerCase()} para ${dayName(nextSame.start)}.` : ''}`;
  } else {
    setSev('none');
    tag.textContent = 'INMET';
    title.textContent = 'Sem aviso do INMET ativo para Maringá agora';
    const nextOne = upcoming[0];
    detail.textContent = nextOne
      ? `Próximo aviso: ${nextOne.event}, ${sevName(nextOne.severityId).toLowerCase()}, a partir de ${dayName(nextOne.start)} às ${hhmm(nextOne.start)}.`
      : 'Nenhum aviso previsto nos próximos dias. Tempestades isoladas podem surgir mesmo assim.';
  }
  if (redNear.length && !active.some((a) => a.severityId >= 8)) {
    let best = null;
    for (const a of redNear) {
      const x = distanceToPolygons(a.polygons);
      if (x && (!best || x.km < best.km)) best = x;
    }
    if (best) {
      near.hidden = false;
      near.textContent = `Maringá está fora do aviso vermelho. O limite mais próximo fica a cerca de ${Math.round(best.km)} km ${atDir(best.bearing)}.`;
    }
  }
}

// ---------- Cartões ----------

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
  const title = $('#now-title'), detail = $('#now-detail'), fresh = $('#now-fresh');
  const banner = $('#radar-alert');
  banner.hidden = true;
  const nc = data.nowcast;
  const glm = data.glm;
  let text = '';
  if (!nc) {
    title.textContent = data.radarError ? 'Radar indisponível' : 'Lendo o radar';
    text = data.radarError ? 'Não consegui ler o radar agora. Veja o radar do Simepar no painel de fontes.' : '';
  } else {
    const age = Date.now() - nc.frameTime;
    const threats = nc.threats || [];
    const near = (c) => { const n = nearestCity(c.nearLat, c.nearLon); return n ? `perto de ${n}` : ''; };
    if (nc.overCity >= STRONG_DBZ) {
      title.textContent = 'Tempestade forte sobre Maringá';
      text = 'O radar mostra chuva muito forte a menos de 12 km do centro.';
    } else if (threats.length) {
      const c = threats[0];
      title.textContent = c.etaMin < 15 ? 'Célula forte chegando' : `Célula forte vindo para cá`;
      text = `A ${Math.round(c.distKm)} km ${atDir(c.fromBearing)}${near(c) ? `, ${near(c)}` : ''}, a ${Math.round(c.speed)} km/h. Se mantiver o rumo, chega em cerca de ${duration(c.etaMin * MIN)}.`;
    } else if (nc.cells.length) {
      const c = nc.cells[0];
      title.textContent = `Célula forte a ${Math.round(c.distKm)} km ${atDir(c.fromBearing)}`;
      const moving = nn(c.speed) && c.speed >= 8
        ? `Indo ${toDir(c.toBearing)} a ${Math.round(c.speed)} km/h, sem rota direta para Maringá neste momento.`
        : 'Sem rumo definido na última meia hora.';
      text = `${near(c) ? `${cap(near(c))}. ` : ''}${moving}`;
    } else if (nc.overCity >= 20) {
      title.textContent = 'Chovendo em Maringá';
      text = 'Sem células fortes a até 350 km no radar.';
    } else if (nc.nearestRain) {
      title.textContent = 'Sem células fortes por perto';
      text = `Chuva mais próxima a ${Math.round(nc.nearestRain.km)} km ${atDir(nc.nearestRain.bearing)}.`;
    } else {
      title.textContent = 'Radar sem chuva na região';
      text = 'Nenhum eco de chuva a até 350 km.';
    }
    const urgent = age < 35 * MIN && (nc.overCity >= STRONG_DBZ || threats.some((c) => c.etaMin <= 60));
    if (urgent) {
      banner.hidden = false;
      const c = threats[0];
      const head = nc.overCity >= STRONG_DBZ
        ? 'Tempestade forte sobre Maringá agora'
        : `Célula forte a ${Math.round(c.distKm)} km, chegada estimada em ${duration(c.etaMin * MIN)}`;
      banner.innerHTML = '';
      banner.append(head);
      const small = document.createElement('small');
      small.textContent = 'Fique em local abrigado até ela passar. Estimativa automática pelo radar: a célula pode mudar de rumo ou enfraquecer. Não é um alerta oficial.';
      banner.append(small);
    }
    fresh.className = age > 40 * MIN ? 'fresh old' : 'fresh';
    fresh.textContent = `Radar das ${hhmm(nc.frameTime)}, ${ago(nc.frameTime)}.`;
  }
  if (glm?.counts && Date.now() - glm.fetchedAt < 40 * MIN) {
    const c100 = glm.counts['100']?.last15 ?? 0;
    const c200 = glm.counts['200']?.last15 ?? 0;
    text += glm.nearestKm != null
      ? ` Raios em 15 min: ${c100.toLocaleString('pt-BR')} a até 100 km e ${c200.toLocaleString('pt-BR')} a até 200 km. O mais próximo, a ${Math.round(glm.nearestKm)} km.`
      : ' Nenhum raio detectado na região em 15 min.';
  }
  detail.textContent = text.trim();
}

function rangeLabel(a, b) {
  const same = dayIndex(a) === dayIndex(b);
  return same ? `${cap(dayName(a))}, ${hh(a)} às ${hh(b)}` : `${cap(dayName(a))} ${hh(a)} até ${dayName(b)} ${hh(b)}`;
}

function renderForecast() {
  const s = computeSummary();
  data.summary = s;
  const peakT = $('#peak-title'), peakD = $('#peak-detail');
  const etaT = $('#eta-title'), etaD = $('#eta-detail');
  const confT = $('#conf-title'), confD = $('#conf-detail');
  const worst = $('#worst-model');
  if (!s) {
    const msg = data.model === null ? 'Calculando' : 'Previsão indisponível';
    peakT.textContent = msg; etaT.textContent = msg; confT.textContent = msg;
    return;
  }
  const parts = [];
  if (s.gustMax) parts.push(`Maior rajada nos modelos: ${s.gustMax.v} km/h (${s.gustMax.model}, ${dayName(s.gustMax.t)} às ${hh(s.gustMax.t)}).`);
  if (s.rainMax) parts.push(`Maior chuva: ${String(s.rainMax.v).replace('.', ',')} mm/h (${s.rainMax.model}).`);
  parts.push('Modelos globais não enxergam uma célula isolada, então a rajada real de uma tempestade pode ser bem maior que isso.');
  worst.textContent = parts.join(' ');

  if (!s.window) {
    peakT.textContent = 'Sem janela clara em 48 h';
    peakD.textContent = 'Nenhum horário se destaca nos modelos para Maringá. Tempestades comuns ainda podem acontecer.';
    etaT.textContent = 'Sem horário marcado';
    etaD.textContent = 'Acompanhe o radar. Ele dá 1 a 2 horas de antecedência quando há célula por perto.';
    confT.textContent = 'Baixa';
    confD.textContent = `Ambiente pouco favorável na maioria dos ${s.n} modelos.`;
    return;
  }
  const { a, b } = s.window;
  const A = s.series[a].t, B = s.series[b].t + HOUR, P = s.series[s.peak];
  peakT.textContent = rangeLabel(A, B);
  const stpTxt = nn(P.stp) ? ` Índice de tornado (STP): ${P.stp.toFixed(1).replace('.', ',')}.` : '';
  const nextTxt = s.next ? ` Nova janela possível ${dayName(s.series[s.next].t)}, ${around(s.series[s.next].t)}.` : '';
  peakD.textContent = `Pico ${around(P.t)}: ambiente ${ENV_NAMES[P.level ?? 0]}, caso uma tempestade se forme aqui. Energia ${Math.round(P.cape)} J/kg, cisalhamento ${Math.round(P.bwd)} m/s.${stpTxt}${nextTxt}`;

  const now = Date.now();
  const radarNote = 'A tempestade em si pode surgir antes ou depois. Quem mostra é o radar, com 1 a 2 horas de antecedência.';
  if (now >= A) {
    etaT.textContent = now < P.t ? 'A janela já começou' : 'Estamos na janela';
    etaD.textContent = now < P.t
      ? `Pico em cerca de ${duration(P.t - now)}. O ambiente segue perigoso até ${around(B)}, em ${duration(B - now)}. ${radarNote}`
      : `O ambiente segue perigoso até ${around(B)}, em ${duration(B - now)}. ${radarNote}`;
  } else {
    etaT.textContent = `Em ${duration(A - now)}`;
    etaD.textContent = `O ambiente mais perigoso começa ${around(A)}, com pico em ${duration(P.t - now)}. ${radarNote}`;
  }
  confT.textContent = `${s.conf} para o ambiente`;
  const ens = s.ensEnv ? ` Em ${s.ensEnv.pct}% dos ${s.ensEnv.members} cenários do ECMWF o ambiente é favorável.` : '';
  confD.textContent = `${s.agree} de ${s.n} modelos concordam no pico.${ens} O lugar exato não é previsível: chuva em Maringá aparece em ${s.rainModels} de ${s.n} modelos nesse período, então a tempestade pode se formar sobre a cidade ou passar longe.`;
}

// ---------- Mapa ----------

const map = L.map('map', { center: [MGA.lat, MGA.lon], zoom: 7, minZoom: 5, maxZoom: 12, dragging: !L.Browser.mobile, tap: false, attributionControl: true });
map.attributionControl.setPrefix(false);
[['heat', 300], ['radar', 320], ['borders', 330], ['labels', 340], ['alerts', 350], ['rings', 360], ['lightning', 370], ['cells', 380]].forEach(([n, z]) => {
  const p = map.createPane(n);
  p.style.zIndex = z;
  if (n === 'labels' || n === 'borders' || n === 'rings' || n === 'lightning') p.style.pointerEvents = 'none';
});

// Mapa de fundo com troca automática se o provedor falhar
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

// Marcação de Maringá e anéis de distância
for (const km of [50, 100, 200]) {
  L.circle([MGA.lat, MGA.lon], { radius: km * 1000, color: '#c9d6df', weight: 1, opacity: 0.55, dashArray: '4 5', fill: false, interactive: false, pane: 'rings' }).addTo(map);
  L.marker([MGA.lat + km / 110.57, MGA.lon], {
    pane: 'rings', interactive: false, keyboard: false,
    icon: L.divIcon({ className: 'ring-label', html: `${km} km`, iconSize: [40, 12], iconAnchor: [20, 6] }),
  }).addTo(map);
}
L.marker([MGA.lat, MGA.lon], { pane: 'cells', interactive: false, keyboard: false, icon: L.divIcon({ className: 'city-mark', iconSize: [14, 14], iconAnchor: [7, 7] }) }).addTo(map);
L.marker([MGA.lat, MGA.lon], { pane: 'cells', interactive: false, keyboard: false, icon: L.divIcon({ className: 'city-label', html: 'Maringá', iconSize: [60, 14], iconAnchor: [-10, 7] }) }).addTo(map);

// Limites municipais e nomes de cidades
const borderRenderer = L.canvas({ pane: 'borders', padding: 0.2 });
fetch('/assets/municipios.json').then((r) => r.json()).then((m) => {
  data.cities = [
    ...m.f.map((c) => ({ n: c.n, lat: c.c[0], lon: c.c[1] })),
    ...m.extra.map(([n, lat, lon]) => ({ n, lat, lon })),
  ];
  const fc = { type: 'FeatureCollection', features: m.f.map((c) => ({ type: 'Feature', properties: { id: c.id }, geometry: { type: 'MultiPolygon', coordinates: c.g } })) };
  L.geoJSON(fc, {
    renderer: borderRenderer, interactive: false,
    style: (f) => (f.properties.id === MGA.ibge ? { color: '#ffffff', weight: 1.6, opacity: 0.95, fill: false } : { color: '#a9bac6', weight: 0.5, opacity: 0.32, fill: false }),
  }).addTo(map);
  safe(renderNow);
}).catch((e) => console.error(e));

// ---------- Camadas de previsão (mapa de calor) ----------

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const RAMPS = {
  scp: {
    title: 'Ambiente para supercélula (SCP)', ticks: ['1', '3', '6', '10', '16+'],
    stops: [[1, '#ffd60a', 0], [3, '#ffd60a', 0.55], [6, '#ff7a1a', 0.74], [10, '#ff2a20', 0.84], [16, '#e040c8', 0.9]],
    note: 'Mostra onde a atmosfera favorece supercélulas nessa hora, pela média dos modelos GFS e ICON. Não mostra onde a tempestade vai estar.',
  },
  stp: {
    title: 'Ambiente para tornado (STP)', ticks: ['0,25', '0,5', '1', '2', '4+'],
    stops: [[0.25, '#ffd60a', 0], [0.5, '#ffd60a', 0.55], [1, '#ff7a1a', 0.74], [2, '#ff2a20', 0.84], [4, '#e040c8', 0.9]],
    note: 'Mostra onde o ambiente combina energia, vento e nuvem baixa, caso uma supercélula se forme. Valor alto não quer dizer que haverá tornado ali.',
  },
  gust: {
    title: 'Rajada prevista (km/h)', ticks: ['35', '50', '70', '90', '110+'],
    stops: [[35, '#ffd60a', 0], [50, '#ffd60a', 0.5], [70, '#ff7a1a', 0.72], [90, '#ff2a20', 0.82], [110, '#e040c8', 0.9]],
    note: 'Rajada média dos modelos GFS e ICON. Eles não enxergam a rajada de uma célula isolada, que pode ser bem maior.',
  },
  rain: {
    title: 'Chuva prevista (mm/h)', ticks: ['0,2', '1', '3', '8', '15', '30+'],
    stops: [[0.2, '#58c7f3', 0], [1, '#58c7f3', 0.5], [3, '#1f7fd8', 0.7], [8, '#ffd60a', 0.8], [15, '#ff7a1a', 0.85], [30, '#ff2a20', 0.9]],
    note: 'Chuva média dos modelos GFS e ICON. Modelos erram bastante o lugar exato da chuva de verão.',
  },
};
for (const r of Object.values(RAMPS)) {
  r.stopsRGB = r.stops.map(([v, c, a]) => [v, ...hex(c), a]);
}
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

function renderHeat() {
  const g = data.grid;
  if (!g || view.mode === 'radar' || view.hourIdx == null) {
    if (heatOverlay) { map.removeLayer(heatOverlay); heatOverlay = null; }
    return;
  }
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
  if (!heatOverlay) {
    heatOverlay = L.imageOverlay(url, bounds, { pane: 'heat', interactive: false, opacity: 1 }).addTo(map);
  } else {
    heatOverlay.setUrl(url);
  }
}

// ---------- Radar ----------

const radarLayers = new Map();
function radarFrames() { return data.radarMeta?.radar?.past || []; }
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

// ---------- Avisos, raios e células no mapa ----------

const alertGroup = L.layerGroup().addTo(map);
const glmGroup = L.layerGroup().addTo(map);
const cellGroup = L.layerGroup().addTo(map);
const glmRenderer = L.canvas({ pane: 'lightning', padding: 0.1 });

function mapTime() {
  if (view.mode !== 'radar' && data.grid && view.hourIdx != null) return data.grid.times[view.hourIdx] * 1000;
  return Date.now();
}

function renderAlertsOnMap() {
  alertGroup.clearLayers();
  if (!$('#tg-alerts').checked) return;
  const t = mapTime();
  const list = (data.alerts?.alerts || [])
    .filter((a) => a.polygons && a.start <= t && t <= a.end && /tempestade|chuva|vendaval|granizo|acumulado/i.test(a.event))
    .sort((x, y) => x.severityId - y.severityId);
  for (const a of list) {
    L.geoJSON({ type: 'MultiPolygon', coordinates: a.polygons }, {
      pane: 'alerts',
      interactive: false,
      style: { color: a.color, weight: a.severityId >= 8 ? 3 : 2, opacity: 0.95, fillColor: a.color, fillOpacity: a.severityId >= 8 ? 0.07 : 0 },
    }).addTo(alertGroup);
  }
}

function renderGlmOnMap() {
  glmGroup.clearLayers();
  if (!$('#tg-glm').checked || view.mode !== 'radar' || !data.glm?.flashes) return;
  if (Date.now() - data.glm.fetchedAt > 40 * MIN) return;
  for (const [lat, lon, age] of data.glm.flashes) {
    if (age > 15) continue;
    L.circleMarker([lat, lon], { renderer: glmRenderer, radius: age <= 5 ? 1.9 : 1.4, stroke: false, fillColor: age <= 5 ? '#ffffff' : '#ffe14d', fillOpacity: 0.9, interactive: false }).addTo(glmGroup);
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
  if (!nc || !$('#tg-cells').checked || view.mode !== 'radar') return;
  if (Date.now() - nc.frameTime > 60 * MIN) return;
  for (const c of nc.cells.slice(0, 18)) {
    const color = c.threat ? '#ff4d42' : '#ffffff';
    const place = nearestCity(c.lat, c.lon);
    const moving = nn(c.speed) && c.speed >= 8 ? `Indo ${toDir(c.toBearing)} a ${Math.round(c.speed)} km/h.` : 'Sem rumo definido.';
    const eta = c.threat ? ` Pode chegar em ${duration(c.etaMin * MIN)} se mantiver o rumo.` : '';
    const tip = `Célula forte${place ? ` perto de ${place}` : ''}, a ${Math.round(c.distKm)} km de Maringá. ${moving}${eta}`;
    L.circleMarker([c.lat, c.lon], { pane: 'cells', radius: c.threat ? 7 : 5, color, weight: 2, fill: false }).bindTooltip(tip).addTo(cellGroup);
    if (nn(c.speed) && c.speed >= 8) {
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
    const target = s.series[s.peak].t / 1000;
    const i = g.times.findIndex((t) => t === target);
    if (i >= 0) return i;
  }
  return gridHours()[0] ?? null;
}

function setMode(mode) {
  stopPlay();
  view.mode = mode;
  tabsEl.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', b.dataset.mode === mode ? 'true' : 'false'));
  if (mode === 'radar') {
    clearHeatIfNeeded();
    showRadarFrame(radarFrames().length - 1);
  } else {
    radarLayers.forEach((l) => l.setOpacity(0));
    if (view.hourIdx == null || !gridHours().includes(view.hourIdx)) view.hourIdx = defaultHour();
  }
  syncMapUI();
  renderAll();
}
function clearHeatIfNeeded() {
  if (heatOverlay) { map.removeLayer(heatOverlay); heatOverlay = null; }
}

function renderLegend() {
  const el = $('#legend');
  if (view.mode === 'radar') {
    const colors = ['#88ddee', '#00a3e0', '#005588', '#ffee00', '#ffaa00', '#ff4400', '#c10000', '#ffaaff'];
    el.innerHTML = `<strong>Intensidade da chuva no radar</strong><div class="legend-bar">${colors.map((c) => `<i style="background:${c}"></i>`).join('')}</div><div class="legend-ticks"><span>fraca</span><span>forte</span><span>granizo</span></div>`;
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
    $('#map-note').textContent = 'Mosaico de radares públicos via RainViewer. Pontos brancos e amarelos: raios detectados pelo satélite GOES-19 nos últimos 15 minutos. Círculos e setas: células fortes e o caminho em 1 hora, se mantiverem o rumo. Linhas coloridas: avisos do INMET válidos agora.';
  } else {
    const hours = gridHours();
    range.max = Math.max(0, hours.length - 1);
    const pos = hours.indexOf(view.hourIdx);
    range.value = Math.max(0, pos);
    const ms = data.grid && view.hourIdx != null ? data.grid.times[view.hourIdx] * 1000 : null;
    label.innerHTML = ms ? `${cap(dayName(ms))} ${hh(ms)}<small>${ms <= Date.now() ? 'agora' : `daqui a ${duration(ms - Date.now())}`}</small>` : 'Sem dados';
    $('#map-note').textContent = data.grid
      ? `${RAMPS[view.mode].note} Linhas coloridas: avisos do INMET válidos nesse horário.`
      : data.gridError ? 'O mapa de calor está indisponível agora. A página tenta de novo sozinha.' : 'O mapa de calor está carregando.';
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
    renderHeat();
    renderAlertsOnMap();
  }
  syncMapUI();
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
        const pos = hours.indexOf(view.hourIdx);
        view.hourIdx = hours[(pos + 1) % hours.length];
        renderHeat();
        renderAlertsOnMap();
      }
    }
    syncMapUI();
  }, view.mode === 'radar' ? 650 : 480);
});
for (const id of ['#tg-alerts', '#tg-glm', '#tg-cells']) {
  $(id).addEventListener('change', () => { renderAlertsOnMap(); renderGlmOnMap(); renderCellsOnMap(); });
}

// ---------- Faixa hora a hora ----------

const STRIP_SCALE = {
  scp: { steps: [1, 3, 6, 10, 15], labels: ['abaixo de 1', '1 a 3', '3 a 6', '6 a 10', '10 a 15', '15 ou mais'], name: 'SCP' },
  stp: { steps: [0.25, 0.5, 1, 2, 4], labels: ['abaixo de 0,25', '0,25 a 0,5', '0,5 a 1', '1 a 2', '2 a 4', '4 ou mais'], name: 'STP' },
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
  const wrap = canvas.parentElement;
  const W = wrap.clientWidth;
  if (!W) return;
  const labelW = 64, top = 30, rowH = W < 480 ? 19 : 22;
  const start = Math.max(0, s.i0 - 3);
  const endI = m.times.length;
  const cols = endI - start;
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
  ctx.font = '600 12px Barlow, system-ui, sans-serif';
  ctx.textBaseline = 'middle';

  const rowY = (r) => top + r * rowH;
  const label = (txt, r, strong) => {
    ctx.fillStyle = strong ? '#eef3f6' : '#a3b4c0';
    ctx.font = `${strong ? 700 : 500} 12px Barlow, system-ui, sans-serif`;
    ctx.fillText(txt, 0, rowY(r) + rowH / 2);
  };
  label('Consenso', 0, true);
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

  // Dias e horas
  ctx.font = '500 11px Barlow, system-ui, sans-serif';
  ctx.textBaseline = 'alphabetic';
  let lastDay = null;
  const compact = cellW * 24 < 100;
  const hoursToMidnight = 24 - brt(m.times[start] * 1000).getUTCHours();
  for (let c = 0; c < cols; c++) {
    const i = start + c;
    const ms = m.times[i] * 1000;
    const d = brt(ms);
    const x = labelW + c * cellW;
    const hour = d.getUTCHours();
    const dayKey = dayIndex(ms);
    if (dayKey !== lastDay) {
      ctx.fillStyle = '#eef3f6';
      ctx.font = '600 12px Barlow, system-ui, sans-serif';
      const text = compact ? `${WEEK[d.getUTCDay()]} ${d.getUTCDate()}` : dateShort(ms);
      // O primeiro rótulo só aparece se couber antes da virada do dia
      const fits = lastDay !== null || hoursToMidnight * cellW >= (compact ? 42 : 66);
      if ((hour === 0 || lastDay === null) && fits) ctx.fillText(text, Math.min(x + 2, W - 64), 12);
      if (hour === 0) {
        ctx.fillStyle = 'rgba(238,243,246,.5)';
        ctx.fillRect(x, 16, 1, H - 22);
      }
      lastDay = dayKey;
      ctx.font = '500 11px Barlow, system-ui, sans-serif';
    }
    if (hour % 6 === 0 && hour !== 0 && cellW * 6 > 26) {
      ctx.fillStyle = '#a3b4c0';
      ctx.fillText(`${hour}h`, x + 1, 26);
    }
  }
  // Marca de agora
  const nowX = labelW + ((Date.now() / 1000 - m.times[start]) / 3600) * cellW;
  if (nowX > labelW && nowX < W) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(nowX - 1, top - 3, 2, H - top - 2);
  }
  // Hora selecionada
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

  const scale = $('#strip-scale');
  const sc = STRIP_SCALE[metric];
  scale.innerHTML = `${sc.labels.map((l, i) => `<span><i style="background:${STRIP_COLORS[i]}"></i>${l}</span>`).join('')}<span><i style="background:${RAIN_COLORS[4]}"></i>Chuva: azul mais claro, mais modelos com chuva</span>`;
}

function renderStripDetail() {
  const el = $('#strip-detail'), s = data.summary, m = data.model;
  if (!s || !m) { el.textContent = data.model === null ? '' : 'Previsão por modelos indisponível agora.'; return; }
  const i = view.stripSel ?? s.peak;
  const x = s.series[i];
  if (!x) return;
  const head = `${cap(dayName(x.t))} às ${hh(x.t)}${view.stripSel == null ? ' (pico)' : ''}`;
  el.textContent = `${head}: ambiente ${ENV_NAMES[x.level ?? 0]}. SCP ${x.scp?.toFixed(1).replace('.', ',') ?? '-'}, STP ${x.stp?.toFixed(1).replace('.', ',') ?? '-'}, energia ${Math.round(x.cape ?? 0)} J/kg, cisalhamento ${Math.round(x.bwd ?? 0)} m/s, helicidade ${Math.round(x.srh1 ?? 0)} m²/s². ${x.favorable} de ${x.n} modelos com ambiente favorável; ${x.rainy} com chuva em Maringá.`;
  $('#strip-map').hidden = !data.grid;
}
$('#strip').addEventListener('click', (e) => {
  const c = e.currentTarget;
  const r = c.getBoundingClientRect();
  const x = e.clientX - r.left - Number(c.dataset.labelW);
  if (x < 0) return;
  view.stripSel = Number(c.dataset.start) + Math.floor(x / Number(c.dataset.cellW));
  drawStrip();
  renderStripDetail();
});
$('#st-scp').addEventListener('click', () => setStrip('scp'));
$('#st-stp').addEventListener('click', () => setStrip('stp'));
function setStrip(metric) {
  view.stripMetric = metric;
  $('#st-scp').classList.toggle('on', metric === 'scp');
  $('#st-stp').classList.toggle('on', metric === 'stp');
  drawStrip();
}
$('#strip-map').addEventListener('click', () => {
  const s = data.summary, g = data.grid;
  if (!s || !g) return;
  const target = s.series[view.stripSel ?? s.peak].t / 1000;
  const i = g.times.findIndex((t) => t === target);
  if (i >= 0) view.hourIdx = i;
  if (view.mode === 'radar') setMode(view.stripMetric);
  else { syncMapUI(); renderHeat(); renderAlertsOnMap(); }
  $('.map-sec').scrollIntoView({ block: 'start' });
});

// ---------- O que cada fonte diz ----------

const BRIEF_UNTIL = Date.parse('2026-11-06T06:00:00-03:00');
const a = (href, text) => `<a href="${href}" rel="noopener">${text}</a>`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const timeTag = (ms, maxMin) => {
  if (!ms) return '<span class="agency-time old">sem dado</span>';
  const old = Date.now() - ms > maxMin * MIN;
  return `<span class="agency-time${old ? ' old' : ''}">${old ? 'antigo: ' : ''}${ago(ms)}</span>`;
};
function agency(name, role, time, body) {
  return `<div class="agency"><div class="agency-head"><span class="agency-name">${name}${role ? ` <small>${role}</small>` : ''}</span>${time || ''}</div>${body}</div>`;
}

function renderAgencies() {
  const out = [];
  const inBrief = Date.now() < BRIEF_UNTIL;

  // INMET
  const al = data.alerts;
  if (al) {
    const { active, upcoming } = activeAlerts();
    const rows = [...active, ...upcoming].filter((x) => x.end > Date.now()).sort((x, y) => x.start - y.start || y.severityId - x.severityId).slice(0, 7);
    const list = rows.length
      ? `<ul>${rows.map((x) => {
        const started = x.start <= Date.now();
        const when = started ? `até ${dayName(x.end)} ${hhmm(x.end)}` : `${dayName(x.start)}, ${hhmm(x.start)} a ${hhmm(x.end)}`;
        return `<li><span class="chip ${sevClass(x.severityId)}">${sevName(x.severityId)}</span>${esc(x.event)}, ${when}</li>`;
      }).join('')}</ul>`
      : '<p>Nenhum aviso cobrindo Maringá.</p>';
    out.push(agency('INMET', 'avisos para Maringá', timeTag(al.fetchedAt, 30), `${list}<div class="links">${a('https://avisos.inmet.gov.br/', 'Mapa de avisos')}</div>`));
  } else {
    out.push(agency('INMET', 'avisos', timeTag(null), `<p>Não foi possível ler os avisos.</p><div class="links">${a('https://avisos.inmet.gov.br/', 'Abrir o site do INMET')}</div>`));
  }

  // Defesa Civil
  const dc = data.official?.defesaCivil;
  const bol = dc?.boletimUrl ? a(dc.boletimUrl, `Boletim de Gestão de Riscos nº ${dc.boletimNumber} (PDF)`) : a('https://www.defesacivil.pr.gov.br/Pagina/Boletins-de-Gestao-de-Risco', 'Boletins de Gestão de Risco');
  const dcNews = (dc?.news || []).map((n) => `<li>${a(n.url, esc(n.title))}</li>`).join('');
  const dcBrief = inBrief
    ? `<p>O boletim nº 47, feito com o Simepar, prevê tempestades severas, rajadas pontualmente severas, granizo e muitos raios de quarta até o início da manhã de quinta (5/11). Segundo o ${a('https://massa.com.br/tempo-clima/risco-de-tempestades-no-parana', 'Massa')}, o risco é alto na região Norte e muito alto no Oeste, Sudoeste, Centro-Oeste e Centro-Sul. O coronel Ivan Fernandes disse à ${a('https://www.tribunapr.com.br/noticias/parana/parana-entra-em-alerta-maximo-para-tempestades-severas-e-risco-de-novos-tornados/', 'RPC, citada pela Tribuna')}: "Isso pode, sim, configurar possíveis tornados em algumas regiões".</p>`
    : '';
  out.push(agency('Defesa Civil do Paraná', 'boletim e alertas', '', `${dcBrief}<div class="links">${bol}${a('https://www.defesacivil.pr.gov.br/Pagina/Alertas-da-Defesa-Civil', 'Como receber alertas')}</div>${dcNews ? `<ul>${dcNews}</ul>` : ''}`));

  // Simepar: só links, porque o site recusa consultas automáticas
  let spBody = '';
  if (inBrief) {
    spBody += `<p>Segundo o ${a('https://hojepr.com/parana-enfrenta-risco-de-novos-tornados-e-temporais-com-ventos-acima-de-100-km-h/', 'HojePR')} e a ${a('https://www.gazetadopovo.com.br/parana/defesa-civil-aponta-segundo-pior-cenario-do-ano-e-coloca-pr-em-alerta-maximo-para-novos-tornados/', 'Gazeta do Povo')}, o Simepar aponta risco de supercélulas: o maior risco fica na metade sul nesta quarta e a instabilidade avança para o norte até quinta.</p>`;
    spBody += '<p>Em 4/11, o site do Simepar informava que o radar de Cascavel estava desativado por falha. O mosaico deles usava só o radar de Teixeira Soares, com alcance de 480 km.</p>';
  }
  out.push(agency('Simepar', 'órgão do Paraná', '', `${spBody}<div class="links">${a('https://www.simepar.br/simepar/radar_msc', 'Radar oficial')}${a('https://www.simepar.br/simepar/raios_simepar', 'Raios')}${a(`https://www.simepar.br/simepar/forecast_by_counties/${MGA.ibge}`, 'Previsão de Maringá')}</div><p class="muted">O Simepar não permite leitura automática pelo site, então esta página não mostra os dados dele ao vivo. Abra os links acima.</p>`));

  // Raios
  const g = data.glm;
  if (g?.counts) {
    const row = (r) => {
      const c = g.counts[r];
      const trend = c.last15 > c.prev15 * 1.25 ? 'subindo' : c.last15 < c.prev15 * 0.75 ? 'caindo' : 'estável';
      return `<tr><td>Até ${r} km</td><td>${c.last15.toLocaleString('pt-BR')}</td><td>${c.prev15.toLocaleString('pt-BR')}</td><td>${c.last15 + c.prev15 === 0 ? '-' : trend}</td></tr>`;
    };
    out.push(agency('NOAA', 'raios por satélite (GOES-19)', timeTag(g.fetchedAt, 30), `<table class="mini-table"><thead><tr><th>Distância</th><th>15 min</th><th>15 min antes</th><th>Tendência</th></tr></thead><tbody>${row('50')}${row('100')}${row('200')}</tbody></table><p class="muted">Aumento rápido de raios costuma indicar uma tempestade ganhando força.</p>`));
  }

  // Aeroporto
  const met = (data.official?.metar || []).filter((m) => m.station === 'SBMG').sort((x, y) => y.at - x.at)[0];
  if (met) {
    const wind = met.wind != null ? `vento de ${met.wind} km/h${met.gust ? ` com rajada de ${met.gust} km/h` : ''}` : 'vento não informado';
    const wx = met.thunder ? 'Trovoada ou nuvem de tempestade reportada.' : 'Sem trovoada reportada.';
    out.push(agency('Aeroporto de Maringá', 'observação oficial (METAR)', timeTag(met.at, 100), `<p>Às ${hhmm(met.at)}: ${met.temp ?? '-'} °C, ${wind}. ${wx}</p><p class="raw">${esc(met.raw)}</p>`));
  }

  // PREVOTS
  const pvBrief = inBrief ? '<p>Mapa de 4/11, em caráter experimental: nível 3 de 4 sobre Cascavel, Guarapuava e Curitiba. Maringá aparece na faixa entre os níveis 1 e 2.</p>' : '';
  out.push(agency('PREVOTS', 'meteorologistas independentes', '', `${pvBrief}<div class="links">${a('https://prevots.org/previsao-convectiva/', 'Previsão convectiva')}</div>`));

  // Cemaden
  const cm = data.alerts?.cemaden;
  if (cm) {
    const pr = cm.pr || [];
    const mga = pr.filter((x) => x.ibge === MGA.ibge);
    const txt = mga.length
      ? `${mga.length} alerta(s) para Maringá: ${mga.map((x) => esc(x.event)).join('; ')}.`
      : pr.length ? `${pr.length} alerta(s) no Paraná, nenhum para Maringá.` : 'Nenhum alerta ativo no Paraná.';
    out.push(agency('Cemaden', 'enchente e deslizamento', timeTag(data.alerts.fetchedAt, 30), `<p>${txt}</p><div class="links">${a('https://painelalertas.cemaden.gov.br/', 'Painel de alertas')}</div>`));
  }

  out.push(agency('Outros canais', 'consulta direta', '', `<div class="links">${a('https://satelite.cptec.inpe.br/', 'Satélite do CPTEC/INPE')}${a('https://redemet.decea.mil.br/', 'Radares da REDEMET')}${a('https://www.lightningmaps.org/?lang=pt#m=oss;t=3;s=0;o=0;b=;ts=0;y=-23.42;x=-51.93;z=8;', 'Raios ao vivo (LightningMaps)')}${a('https://www.maringa.pr.gov.br/', 'Prefeitura de Maringá')}</div>`));

  $('#agencies').innerHTML = out.join('');
}

// ---------- Boato ou fato ----------

function renderClaims() {
  const { active } = activeAlerts();
  const top = active[0];
  const official = data.alerts && top
    ? `O INMET mantém aviso ${sevName(top.severityId).toLowerCase()} de ${top.event.toLowerCase()} para Maringá agora.`
    : 'O INMET não tem aviso ativo para Maringá neste momento, mas a situação pode mudar rápido.';
  const inBrief = Date.now() < BRIEF_UNTIL;
  const claims = [
    {
      q: 'Vai passar um tornado em Maringá nesta madrugada.',
      v: 'Não dá para afirmar', c: 'maybe',
      t: `Ninguém consegue prever tornado com hora e lugar. O que os órgãos indicam é ambiente favorável a tempestades severas${inBrief ? ', e a Defesa Civil diz que tornados são possíveis em algumas regiões' : ''}. Quem garante hora ou bairro está chutando.`,
    },
    {
      q: 'É tudo exagero, não tem risco nenhum.',
      v: inBrief || top ? 'Falso' : 'Depende do dia', c: inBrief || top ? 'no' : 'maybe',
      t: `${official}${inBrief ? ' A Defesa Civil e o Simepar preveem tempestades severas até o início da manhã de quinta (5/11).' : ''}`,
    },
    {
      q: 'Recebi um áudio da Defesa Civil mandando sair de casa.',
      v: 'Desconfie', c: 'no',
      t: 'Alerta oficial chega por SMS do 40199, pelo WhatsApp (61) 2034-4611, pelo Telegram da Defesa Civil ou como aviso sonoro na tela do celular (Cell Broadcast). Áudio encaminhado não é canal oficial.',
    },
    {
      q: 'Olha este print do radar: o tornado está chegando.',
      v: 'Confira a hora', c: 'maybe',
      t: 'Prints circulam por dias. E o radar público mostra chuva e granizo, não o tornado em si. Compare com o radar desta página, que mostra o horário de cada imagem.',
    },
  ];
  $('#claims').innerHTML = claims.map((x) => `<div class="claim"><q>${esc(x.q)}</q><span class="verdict ${x.c}">${esc(x.v)}</span><p>${esc(x.t)}</p></div>`).join('');
}

// ---------- Compartilhar ----------

const shareText = `Monitor de tempestades em Maringá, com radar, raios, avisos do INMET e previsão. Antes de repassar áudio ou print, confira aqui: ${SITE_URL}`;
$('#share-wa').href = `https://wa.me/?text=${encodeURIComponent(shareText)}`;
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

// ---------- Escada de previsibilidade ----------

function renderLadder() {
  const s = data.summary, nc = data.nowcast;
  let step = 'days';
  if (s?.window) {
    const hoursAway = (s.series[s.window.a].t - Date.now()) / HOUR;
    if (hoursAway < 12) step = 'hours';
  }
  if (nc && ((nc.threats || []).length || (nc.cells[0]?.distKm ?? 999) < 150)) step = 'radar';
  document.querySelectorAll('#ladder li').forEach((li) => li.classList.toggle('here', li.dataset.step === step));
}

// ---------- Situação dos dados ----------

function renderHealth() {
  const rows = [
    ['Avisos', 'INMET', data.alerts?.fetchedAt, 30],
    ['Radar', 'RainViewer', data.nowcast?.frameTime, 40],
    ['Raios', 'NOAA, satélite GOES-19', data.glm?.fetchedAt, 30],
    ['Previsão por modelo', 'NOAA, ECMWF, DWD, Canadá, Reino Unido, França e China, via Open-Meteo', data.model?.fetchedAt, 180],
    ['Cenários', 'ECMWF, via Open-Meteo', data.ensemble?.fetchedAt, 360],
    ['Mapa de calor', 'GFS e ICON, via Open-Meteo', data.grid?.fetchedAt, 360],
    ['Boletim', 'Defesa Civil do Paraná', data.official?.defesaCivil ? data.official.fetchedAt : null, 120],
    ['Aeroporto', 'METAR, via NOAA', data.official?.metar ? data.official.fetchedAt : null, 60],
  ];
  $('#health tbody').innerHTML = rows.map(([n, src, at, max]) => {
    const cls = !at ? 'bad' : Date.now() - at > max * MIN ? 'old' : '';
    return `<tr><td>${n}</td><td>${src}</td><td class="${cls}">${at ? `${hhmm(at)} (${ago(at)})` : 'indisponível'}</td></tr>`;
  }).join('');
}

// ---------- Ciclo de atualização ----------

function renderAll() {
  safe(renderStatus);
  safe(renderForecast);
  safe(renderNow);
  safe(renderAgencies);
  safe(renderClaims);
  safe(renderLadder);
  safe(renderHealth);
  safe(syncMapUI);
  safe(renderAlertsOnMap);
  safe(renderGlmOnMap);
  safe(renderCellsOnMap);
  safe(renderHeat);
  safe(drawStrip);
  safe(renderStripDetail);
}

async function refreshAlerts() {
  let d = null;
  try { d = await api('alerts'); } catch (e) { console.warn(e); }
  if (!d || Date.now() - d.fetchedAt > 20 * MIN) {
    // Plano B: lê direto do INMET se o nosso servidor falhar
    try {
      const j = await (await fetch(INMET_URL)).json();
      d = { fetchedAt: Date.now(), alerts: parseInmet(j), cemaden: d?.cemaden ?? data.alerts?.cemaden ?? null };
    } catch (e) { console.warn(e); }
  }
  if (d) data.alerts = d;
  renderAll();
}
async function refreshOfficial() {
  try { data.official = await api('official'); renderAll(); } catch (e) { console.warn(e); safe(renderAgencies); }
}
async function refreshGlm() {
  try { data.glm = await api('glm'); safe(renderNow); safe(renderGlmOnMap); safe(renderAgencies); safe(renderHealth); } catch (e) { console.warn(e); }
}
async function refreshModel() {
  let d = null;
  try { d = await api('model'); } catch (e) { console.warn(e); }
  if (!d || Date.now() - d.fetchedAt > 3 * HOUR) {
    try {
      d = await fetchModelSeries(async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
    } catch (e) { console.warn(e); }
  }
  data.model = d ?? data.model ?? false;
  renderAll();
}
async function refreshEnsemble() {
  try { data.ensemble = await api('ensemble'); safe(renderForecast); safe(renderHealth); } catch (e) { console.warn(e); }
}
async function refreshGrid() {
  try {
    data.grid = await api('grid');
    data.gridError = false;
    if (view.hourIdx == null || !gridHours().includes(view.hourIdx)) view.hourIdx = defaultHour();
    safe(renderHeat); safe(syncMapUI); safe(renderHealth);
  } catch (e) {
    console.warn(e);
    data.gridError = true;
    safe(syncMapUI);
  }
}

let lastFrame = null;
let analyzing = false;
async function refreshRadar() {
  try {
    const res = await fetch('https://api.rainviewer.com/public/weather-maps.json');
    const meta = await res.json();
    const frames = meta?.radar?.past || [];
    if (!frames.length) throw new Error('sem frames');
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
    syncMapUI();
    if (changed && !analyzing) {
      analyzing = true;
      try {
        data.nowcast = await analyzeRadar(meta);
      } finally {
        analyzing = false;
      }
      safe(renderNow); safe(renderCellsOnMap); safe(renderLadder); safe(renderHealth);
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
}

// Início
tick();
setInterval(tick, 10_000);
renderLegend();
safe(renderClaims);
safe(renderAgencies);
safe(renderHealth);
refreshAlerts();
refreshRadar();
refreshGlm();
refreshOfficial();
refreshModel().then(() => { refreshGrid(); refreshEnsemble(); });

every(3 * MIN, refreshAlerts);
every(2 * MIN, refreshRadar);
every(5 * MIN, refreshGlm);
every(10 * MIN, refreshOfficial);
every(30 * MIN, refreshModel);
every(60 * MIN, refreshEnsemble);
every(60 * MIN, refreshGrid);
every(MIN, () => { safe(renderStatus); safe(renderForecast); safe(renderNow); safe(syncMapUI); safe(renderHealth); });

// Ao voltar para a aba, atualiza na hora o que importa
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { hiddenAt = Date.now(); return; }
  if (Date.now() - hiddenAt > MIN) { refreshAlerts(); refreshRadar(); refreshGlm(); }
});
window.addEventListener('resize', () => { safe(drawStrip); map.invalidateSize(); });
