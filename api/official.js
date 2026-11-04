// Fontes oficiais lidas por página: Simepar, Defesa Civil do Paraná e aeroportos.
import { execFile } from 'node:child_process';
import { MGA } from '../assets/shared.js';
import { UA, getText, sendJson, sendError } from './_lib.js';

function curlText(url, timeoutS = 12) {
  return new Promise((resolve, reject) => {
    execFile('curl', ['-sS', '-f', '-L', '-m', String(timeoutS), '-A', UA, url], { maxBuffer: 20 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        const lines = String(err.message).split('\n').map((l) => l.trim()).filter(Boolean);
        reject(new Error(err.code === 'ENOENT' ? 'curl ausente' : (lines[lines.length - 1] || 'curl falhou').slice(0, 100)));
      } else {
        resolve(stdout);
      }
    });
  });
}

const ENT = { aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', atilde: 'ã', otilde: 'õ', ccedil: 'ç', ecirc: 'ê', ocirc: 'ô', acirc: 'â', agrave: 'à', nbsp: ' ', amp: '&', quot: '"' };
const decode = (s) => s
  .replace(/&(\w+);/g, (m, n) => ENT[n] ?? m)
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
const plain = (html) => decode(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');

const MONTHS = { Jan: 0, Fev: 1, Mar: 2, Abr: 3, Mai: 4, Jun: 5, Jul: 6, Ago: 7, Set: 8, Out: 9, Nov: 10, Dez: 11 };
function brtEpoch(dateText, hhmm = '00:00') {
  const m = dateText.match(/(\d{2}) de (\w{3}) de (\d{4})/);
  if (!m) return null;
  const mm = String(MONTHS[m[2]] + 1).padStart(2, '0');
  return Date.parse(`${m[3]}-${mm}-${m[1]}T${hhmm}:00-03:00`);
}

function parseSimepar(html) {
  const text = plain(html);
  const out = { obs: null, daily: [] };
  const o = text.match(/(\w{3}, \d{2} de \w{3} de \d{4}) - (\d{2}:\d{2}) - Dados medidos por esta\S+ meteorol\S+ (-?\d+)\S*\s*C Sensação Térmica: (-?\d+)\S* Precipitação: ([\d.]+) mm Vento: ([A-Z]+) (\d+) km\/h Rajada: (\d+) km\/h/);
  if (o) {
    out.obs = { at: brtEpoch(o[1], o[2]), temp: +o[3], feels: +o[4], rain: +o[5], windDir: o[6], wind: +o[7], gust: +o[8] };
  }
  const dailyRe = /(\w{3}, \d{2} de \w{3} de \d{4}) UR Umidade Relativa: (\d+)% - (\d+)% Precipitação Acumulada: ([\d.]+) mm Probabilidade de Ocorrência de Chuva: (\d+)% Vento: ([A-Z]+) (\d+) km\/h Rajada: (\d+) km\/h/g;
  for (const m of text.matchAll(dailyRe)) {
    out.daily.push({ day: m[1], at: brtEpoch(m[1]), rain: +m[4], prob: +m[5], gust: +m[8] });
  }
  return out;
}

function parseMetar(raw) {
  return raw.split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
    const clean = line.replace(/^(METAR|SPECI)\s+/, '');
    const station = clean.split(/\s+/)[0];
    const w = clean.match(/\b(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?KT\b/);
    const kmh = (kt) => Math.round(kt * 1.852);
    const t = clean.match(/\b(M?\d{2})\/(M?\d{2})\b/);
    const q = clean.match(/\bQ(\d{4})\b/);
    const when = clean.match(/\b(\d{2})(\d{2})(\d{2})Z\b/);
    const now = new Date();
    let at = null;
    if (when) {
      at = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), +when[1], +when[2], +when[3]);
      if (at > Date.now() + 86_400_000) at = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, +when[1], +when[2], +when[3]);
    }
    return {
      station, raw: line, at,
      windDir: w && w[1] !== 'VRB' ? +w[1] : null,
      wind: w ? kmh(+w[2]) : null,
      gust: w && w[3] ? kmh(+w[3]) : null,
      temp: t ? +t[1].replace('M', '-') : null,
      pressure: q ? +q[1] : null,
      thunder: /(^|\s)[-+]?(VC)?TS|\bCB\b/.test(clean),
    };
  });
}

export default async function handler(req, res) {
  const out = { fetchedAt: Date.now(), simepar: null, radarNotice: null, defesaCivil: null, metar: null, problems: [] };
  const jobs = [
    (async () => {
      out.simepar = parseSimepar(await curlText(`https://www.simepar.br/simepar/forecast_by_counties/${MGA.ibge}`));
      if (!out.simepar.obs && !out.simepar.daily.length) { out.simepar = null; throw new Error('formato mudou'); }
    })().catch((e) => out.problems.push(`simepar: ${e.message}`)),
    (async () => {
      const m = plain(await curlText('https://www.simepar.br/simepar/radar_msc')).match(/ATENÇÃO:.{10,300}?km\./);
      out.radarNotice = m ? m[0] : null;
    })().catch((e) => out.problems.push(`radar: ${e.message}`)),
    (async () => {
      const html = await getText('https://www.defesacivil.pr.gov.br/', { timeout: 12_000 });
      const b = html.match(/https?:\/\/[^"']*boletim_gestao_riscos_(\d+)_(\d{4})\.pdf/);
      const news = [];
      for (const m of html.matchAll(/<a[^>]+href="(\/Noticia\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
        const t = plain(m[2]).trim();
        if (t.length > 8 && /tempestad|tornado|alerta|vendaval|Maring|temporal/i.test(t) && !news.some((n) => n.title === t)) {
          news.push({ title: t, url: `https://www.defesacivil.pr.gov.br${m[1]}` });
        }
      }
      out.defesaCivil = { boletimUrl: b ? b[0] : null, boletimNumber: b ? `${Number(b[1])}/${b[2]}` : null, news: news.slice(0, 3) };
    })().catch((e) => out.problems.push(`defesa civil: ${e.message}`)),
    (async () => {
      out.metar = parseMetar(await getText('https://aviationweather.gov/api/data/metar?ids=SBMG,SBLO&format=raw&hours=3', { timeout: 10_000 }));
    })().catch((e) => out.problems.push(`metar: ${e.message}`)),
  ];
  await Promise.all(jobs);
  if (!out.simepar && !out.defesaCivil && !out.metar) {
    sendError(res, new Error(out.problems.join('; ')));
    return;
  }
  sendJson(res, out, { fresh: 300, stale: 1800 });
}
