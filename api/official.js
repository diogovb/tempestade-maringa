// Fontes oficiais lidas por página: Defesa Civil do Paraná e aeroportos.
// O site do Simepar recusa consultas automáticas, então a página só aponta para ele.
import { getText, serve } from './_lib.js';

const ENT = { aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', atilde: 'ã', otilde: 'õ', ccedil: 'ç', ecirc: 'ê', ocirc: 'ô', acirc: 'â', agrave: 'à', nbsp: ' ', amp: '&', quot: '"' };
const decode = (s) => s
  .replace(/&(\w+);/g, (m, n) => ENT[n] ?? m)
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
const plain = (html) => decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');

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

async function build() {
  const out = { fetchedAt: Date.now(), defesaCivil: null, metar: null, problems: [] };
  await Promise.all([
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
  ]);
  if (!out.defesaCivil && !out.metar) throw new Error(out.problems.join('; '));
  return out;
}

export default function handler(req, res) {
  return serve(res, 'official', build, { fresh: 300, stale: 1800 });
}
