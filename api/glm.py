"""Raios detectados pelo sensor GLM do satélite GOES-19 (NOAA) nos últimos 20 minutos."""
import datetime as dt
import io
import json
import math
import re
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler

import h5py
import numpy as np

BUCKET = "https://noaa-goes19.s3.amazonaws.com"
MGA = (-23.4205, -51.9333)
BOX = dict(lat_min=-27.5, lat_max=-19.5, lon_min=-57.0, lon_max=-47.0)
WINDOW_MIN = 20
MAX_FLASHES = 2500
# Arquivos já lidos ficam na memória: a cada minuto só os novos são baixados
FILE_CACHE = {}
UA = "tempestade-maringa (monitor comunitario; github.com/diogovb/tempestade-maringa)"


def fetch(url, timeout=20):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def list_hour(when):
    prefix = when.strftime("GLM-L2-LCFA/%Y/%j/%H/")
    xml = fetch(f"{BUCKET}/?list-type=2&prefix={prefix}").decode()
    return re.findall(r"<Key>([^<]+)</Key>", xml)


def start_time(key):
    m = re.search(r"_s(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})", key)
    y, j, h, mi, s = map(int, m.groups())
    return dt.datetime(y, 1, 1, h, mi, s, tzinfo=dt.timezone.utc) + dt.timedelta(days=j - 1)


def read_one(key):
    if key in FILE_CACHE:
        return FILE_CACHE[key]
    try:
        data = fetch(f"{BUCKET}/{key}")
        with h5py.File(io.BytesIO(data), "r") as f:
            lat = f["flash_lat"][:]
            lon = f["flash_lon"][:]
        m = (lat > BOX["lat_min"]) & (lat < BOX["lat_max"]) & (lon > BOX["lon_min"]) & (lon < BOX["lon_max"])
        FILE_CACHE[key] = (start_time(key), lat[m], lon[m])
        return FILE_CACHE[key]
    except Exception as e:
        print("arquivo falhou", key, e)
        return None


def dist_km(lat, lon):
    p1, p2 = math.radians(MGA[0]), np.radians(lat)
    dphi = p2 - p1
    dl = np.radians(lon) - math.radians(MGA[1])
    a = np.sin(dphi / 2) ** 2 + math.cos(p1) * np.cos(p2) * np.sin(dl / 2) ** 2
    return 2 * 6371.0 * np.arcsin(np.sqrt(a))


def build():
    now = dt.datetime.now(dt.timezone.utc)
    keys = []
    for back in (0, 1):
        try:
            keys += list_hour(now - dt.timedelta(hours=back))
        except Exception as e:
            print("listagem falhou", e)
    limit = now - dt.timedelta(minutes=WINDOW_MIN + 1)
    keys = [k for k in keys if start_time(k) >= limit]
    for old in [k for k in FILE_CACHE if k not in keys]:
        del FILE_CACHE[old]
    if not keys:
        raise RuntimeError("sem arquivos GLM recentes")

    rows, newest, ok = [], None, 0
    with ThreadPoolExecutor(16) as pool:
        for res in pool.map(read_one, keys):
            if not res:
                continue
            ok += 1
            when, lat, lon = res
            newest = when if newest is None or when > newest else newest
            if len(lat):
                rows.append((lat, lon, np.full(len(lat), (now - when).total_seconds())))
    if not ok:
        raise RuntimeError("nenhum arquivo GLM pôde ser lido")

    if rows:
        lat = np.concatenate([r[0] for r in rows])
        lon = np.concatenate([r[1] for r in rows])
        age = np.concatenate([r[2] for r in rows])
        dist = dist_km(lat, lon)
    else:
        lat = lon = age = dist = np.array([])

    counts = {}
    for radius in (25, 50, 100, 200):
        inside = dist <= radius
        counts[str(radius)] = {
            "last10": int(np.sum(inside & (age <= 600))),
            "prev10": int(np.sum(inside & (age > 600))),
        }
    recent = dist[age <= 600] if len(dist) else np.array([])
    nearest = round(float(recent.min()), 1) if len(recent) else None
    order = np.argsort(age)[:MAX_FLASHES] if len(age) else []
    flashes = [[round(float(lat[i]), 2), round(float(lon[i]), 2), int(age[i])] for i in order]
    return {
        "fetchedAt": int(now.timestamp() * 1000),
        "newest": int(newest.timestamp() * 1000) if newest else None,
        "windowMin": WINDOW_MIN,
        "files": ok,
        "total": int(len(lat)),
        "nearestKm": nearest,
        "counts": counts,
        "flashes": flashes,
    }


LAST_GOOD = None


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        global LAST_GOOD
        try:
            body = json.dumps(build(), separators=(",", ":")).encode()
            LAST_GOOD = body
            status, cache = 200, "max-age=45, stale-while-revalidate=300, stale-if-error=86400"
        except Exception as e:
            print("glm falhou", e)
            if LAST_GOOD:
                # O horário original vai junto, e a página mostra que o dado está antigo.
                body, status, cache = LAST_GOOD, 200, "max-age=30, stale-while-revalidate=120"
            else:
                body = json.dumps({"ok": False, "error": str(e)[:160]}).encode()
                status, cache = 502, "max-age=15"
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "public, max-age=0, must-revalidate")
        self.send_header("Vercel-CDN-Cache-Control", cache)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)
