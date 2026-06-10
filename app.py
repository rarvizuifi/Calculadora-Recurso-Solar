"""
app.py — Servidor Flask para la Calculadora de Recurso Solar.

Endpoints activos:
  GET  /                        → index.html
  GET  /api/cfe_gdmto           → Tarifas GDMTO vía scraping simple (fallback)
  POST /api/cfe_gdmto_tarifa    → Tarifas GDMTO por ubicación/mes/año (WebForms cascade)

Toda la lógica de simulación solar, demanda y Excel corre en el cliente (JS).
"""

import re
import unicodedata
import datetime
import requests
import urllib3
from bs4 import BeautifulSoup
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

app = Flask(__name__, static_folder='.', static_url_path='')
CORS(app)


# ─── Frontend ─────────────────────────────────────────────────────────────────
@app.route('/')
def index():
    return send_from_directory('.', 'index.html')


# ─── Tarifas CFE GDMTO (scraping simple) ──────────────────────────────────────
FALLBACK_DIVISIONES = [
    {'nombre': 'CDMX / Valle de México (referencia 2025)', 'precio_kwh': 1.699, 'cargo_fijo': 466.83, 'cargo_dist': 57.74,  'cargo_cap': 334.65, 'cargo_trans': 89.12},
    {'nombre': 'Noroeste (referencia 2025)',                'precio_kwh': 1.821, 'cargo_fijo': 466.83, 'cargo_dist': 61.20,  'cargo_cap': 350.40, 'cargo_trans': 89.12},
    {'nombre': 'Norte (referencia 2025)',                   'precio_kwh': 1.756, 'cargo_fijo': 466.83, 'cargo_dist': 59.10,  'cargo_cap': 344.70, 'cargo_trans': 89.12},
]

CFE_URL = 'https://app.cfe.mx/Aplicaciones/CCFE/Tarifas/TarifasCRENegocio/Tarifas/GranDemandaMTO.aspx'
CFE_HDR = {'User-Agent': 'Mozilla/5.0 (compatible; SolarCalc/2.3)'}
GMAPS_KEY = 'AIzaSyDIO9AKyM4TeZJ2O2uLbgPETJapKZLo_d4'


@app.route('/api/cfe_gdmto', methods=['GET'])
def api_cfe_gdmto():
    """Scraping simple (GET). Retorna fallback si la página cambia de estructura."""
    fecha_hoy = datetime.date.today().isoformat()
    money_re = re.compile(r'\$?\s*(\d{1,6}(?:,\d{3})*(?:\.\d+)?)')

    try:
        r = requests.get(CFE_URL, verify=False, timeout=12, headers=CFE_HDR)
        r.raise_for_status()
        r.encoding = r.apparent_encoding or 'utf-8'
        soup = BeautifulSoup(r.text, 'html.parser')

        divisiones = []
        for table in soup.find_all('table'):
            for row in table.find_all('tr'):
                cells = row.find_all(['td', 'th'])
                if len(cells) < 3:
                    continue
                row_text = ' '.join(c.get_text(strip=True) for c in cells)
                nums_raw = money_re.findall(row_text)
                nums = [float(n.replace(',', '')) for n in nums_raw if float(n.replace(',', '')) > 0.01]
                if len(nums) < 2:
                    continue
                nombre = cells[0].get_text(strip=True)
                if not nombre or nombre.lower() in ('concepto', 'división', 'division', 'region', 'región'):
                    continue
                cargo_fijo    = nums[0] if len(nums) > 0 else FALLBACK_DIVISIONES[0]['cargo_fijo']
                precio_kwh    = nums[1] if len(nums) > 1 else FALLBACK_DIVISIONES[0]['precio_kwh']
                cargo_dist    = nums[2] if len(nums) > 2 else FALLBACK_DIVISIONES[0]['cargo_dist']
                cargo_cap     = nums[3] if len(nums) > 3 else FALLBACK_DIVISIONES[0]['cargo_cap']
                divisiones.append({'nombre': nombre, 'precio_kwh': precio_kwh,
                                   'cargo_fijo': cargo_fijo, 'cargo_dist': cargo_dist, 'cargo_cap': cargo_cap})

        if not divisiones:
            return jsonify({'ok': True, 'divisiones': FALLBACK_DIVISIONES, 'fuente': 'fallback', 'fecha': fecha_hoy})

        return jsonify({'ok': True, 'divisiones': divisiones, 'fuente': CFE_URL, 'fecha': fecha_hoy})

    except Exception as e:
        return jsonify({'ok': True, 'divisiones': FALLBACK_DIVISIONES, 'fuente': 'fallback',
                        'error_detail': str(e), 'fecha': fecha_hoy})


# ─── Tarifas CFE GDMTO por ubicación (WebForms cascade) ───────────────────────
def _norm(s):
    return unicodedata.normalize('NFD', s).encode('ascii', 'ignore').decode('ascii').upper()


def _best_match(target, options):
    if target:
        nt = _norm(target)
        for val, text in options:
            if val and val != '0' and (_norm(text) and (nt in _norm(text) or _norm(text) in nt)):
                return val
    for val, text in options:
        if val and val != '0':
            return val
    return None


def _extract_hidden(soup, name):
    el = soup.find('input', {'name': name})
    return el['value'] if el else ''


def _extract_options(soup, select_name):
    sel = soup.find('select', {'name': select_name})
    if not sel:
        return []
    return [(o.get('value', ''), o.get_text(strip=True)) for o in sel.find_all('option')]


def _val_after(text, keyword, min_val=0.0, max_val=1e9, window=80):
    """Busca el primer número válido después de CUALQUIER ocurrencia de keyword."""
    start = 0
    while True:
        idx = text.find(keyword, start)
        if idx == -1:
            return None
        segment = text[idx + len(keyword): idx + len(keyword) + window]
        m = re.search(r'(\d[\d,]*\.?\d*)', segment)
        if m:
            v = float(m.group(1).replace(',', ''))
            if min_val < v <= max_val:
                return v
        start = idx + 1


@app.route('/api/cfe_gdmto_tarifa', methods=['POST'])
def api_cfe_gdmto_tarifa():
    """Multi-step WebForms POST para obtener tarifas GDMTO por ubicación y mes/año."""
    fecha_hoy = datetime.date.today().isoformat()

    body = request.get_json(silent=True) or {}
    lat  = float(body.get('lat',  25.67))
    lon  = float(body.get('lon', -100.31))
    anio = int(body.get('anio', datetime.date.today().year))
    mes  = int(body.get('mes',  datetime.date.today().month))

    # ── Reverse geocoding ──────────────────────────────────────────────────────
    estado_name = None
    municipio_name = None
    try:
        geo_r = requests.get(
            f'https://maps.googleapis.com/maps/api/geocode/json'
            f'?latlng={lat},{lon}&key={GMAPS_KEY}&language=es',
            timeout=5
        )
        geo_d = geo_r.json()
        if geo_d.get('status') == 'OK' and geo_d.get('results'):
            for comp in geo_d['results'][0].get('address_components', []):
                types = comp.get('types', [])
                if 'administrative_area_level_1' in types and estado_name is None:
                    estado_name = comp['long_name'].upper()
                if ('locality' in types or 'administrative_area_level_2' in types) and municipio_name is None:
                    municipio_name = comp['long_name'].upper()
    except Exception:
        pass

    try:
        sess = requests.Session()

        # Step 1: GET page ─────────────────────────────────────────────────────
        r1 = sess.get(CFE_URL, verify=False, timeout=12, headers=CFE_HDR)
        r1.raise_for_status()
        r1.encoding = r1.apparent_encoding or 'utf-8'
        s1 = BeautifulSoup(r1.text, 'html.parser')

        vs  = _extract_hidden(s1, '__VIEWSTATE')
        vsg = _extract_hidden(s1, '__VIEWSTATEGENERATOR')
        ev  = _extract_hidden(s1, '__EVENTVALIDATION')

        estado_options = _extract_options(s1, 'ctl00$ContentPlaceHolder1$EdoMpoDiv$ddEstado')
        estado_val = _best_match(estado_name, estado_options)
        if not estado_val:
            return jsonify({'ok': True, 'divisiones': FALLBACK_DIVISIONES, 'fuente': 'fallback', 'fecha': fecha_hoy})

        # Step 2: POST estado → get municipios ─────────────────────────────────
        base_fields = {
            '__VIEWSTATE':          vs,
            '__VIEWSTATEGENERATOR': vsg,
            '__EVENTVALIDATION':    ev,
            '__EVENTARGUMENT':      '',
            'ctl00$ContentPlaceHolder1$EdoMpoDiv$ddEstado':    estado_val,
            'ctl00$ContentPlaceHolder1$EdoMpoDiv$ddMunicipio': '0',
            'ctl00$ContentPlaceHolder1$EdoMpoDiv$ddDivision':  '0',
            'ctl00$ContentPlaceHolder1$Fecha$ddAnio':          str(anio),
            'ctl00$ContentPlaceHolder1$Fecha2$ddMes':          str(mes),
            'ctl00$ContentPlaceHolder1$hdAnio':                '',
            'ctl00$ContentPlaceHolder1$hdMes':                 '',
        }
        r2 = sess.post(CFE_URL, data={**base_fields,
            '__EVENTTARGET': 'ctl00$ContentPlaceHolder1$EdoMpoDiv$ddEstado'},
            verify=False, timeout=15, headers=CFE_HDR)
        s2 = BeautifulSoup(r2.text, 'html.parser')
        vs = _extract_hidden(s2, '__VIEWSTATE') or vs
        ev = _extract_hidden(s2, '__EVENTVALIDATION') or ev

        municipio_options = _extract_options(s2, 'ctl00$ContentPlaceHolder1$EdoMpoDiv$ddMunicipio')
        municipio_val = _best_match(municipio_name, municipio_options)
        if not municipio_val:
            return jsonify({'ok': True, 'divisiones': FALLBACK_DIVISIONES, 'fuente': 'fallback', 'fecha': fecha_hoy})

        # Step 3: POST municipio → get divisions ───────────────────────────────
        r3 = sess.post(CFE_URL, data={**base_fields,
            '__VIEWSTATE':       vs,
            '__EVENTVALIDATION': ev,
            '__EVENTTARGET': 'ctl00$ContentPlaceHolder1$EdoMpoDiv$ddMunicipio',
            'ctl00$ContentPlaceHolder1$EdoMpoDiv$ddMunicipio': municipio_val},
            verify=False, timeout=15, headers=CFE_HDR)
        s3 = BeautifulSoup(r3.text, 'html.parser')
        vs = _extract_hidden(s3, '__VIEWSTATE') or vs
        ev = _extract_hidden(s3, '__EVENTVALIDATION') or ev

        division_options = _extract_options(s3, 'ctl00$ContentPlaceHolder1$EdoMpoDiv$ddDivision')
        division_val = _best_match(None, division_options)
        if not division_val:
            return jsonify({'ok': True, 'divisiones': FALLBACK_DIVISIONES, 'fuente': 'fallback', 'fecha': fecha_hoy})
        division_nombre = next((t for v, t in division_options if v == division_val), division_val)

        # Step 4: POST final → get tariff table ────────────────────────────────
        submit_btn = s3.find('input', {'type': 'submit'})
        btn_name  = submit_btn['name']  if submit_btn and submit_btn.get('name')  else 'ctl00$ContentPlaceHolder1$btnConsultar'
        btn_value = submit_btn['value'] if submit_btn and submit_btn.get('value') else 'Consultar'

        r4 = sess.post(CFE_URL, data={
            '__VIEWSTATE':          vs,
            '__VIEWSTATEGENERATOR': vsg,
            '__EVENTVALIDATION':    ev,
            '__EVENTTARGET':        '',
            '__EVENTARGUMENT':      '',
            'ctl00$ContentPlaceHolder1$EdoMpoDiv$ddEstado':    estado_val,
            'ctl00$ContentPlaceHolder1$EdoMpoDiv$ddMunicipio': municipio_val,
            'ctl00$ContentPlaceHolder1$EdoMpoDiv$ddDivision':  division_val,
            'ctl00$ContentPlaceHolder1$Fecha$ddAnio':          str(anio),
            'ctl00$ContentPlaceHolder1$Fecha2$ddMes':          str(mes),
            'ctl00$ContentPlaceHolder1$hdAnio':                '',
            'ctl00$ContentPlaceHolder1$hdMes':                 '',
            btn_name:                                          btn_value,
        }, verify=False, timeout=20, headers=CFE_HDR)
        s4 = BeautifulSoup(r4.text, 'html.parser')

        # ── Parsear tabla de tarifas ───────────────────────────────────────────
        full_text = ' '.join(s4.stripped_strings).upper()

        fijo_val  = _val_after(full_text, 'FIJO',       min_val=50)
        kwh_val   = _val_after(full_text, 'VARIABLE',   max_val=20) or \
                    _val_after(full_text, 'ENERG',      max_val=20)
        dist_val  = _val_after(full_text, 'DISTRIBUCI', min_val=1)
        cap_val   = _val_after(full_text, 'CAPACIDAD',  min_val=1)
        trans_val = _val_after(full_text, 'TRANSMISI',  min_val=1)

        if kwh_val is None:
            return jsonify({'ok': True, 'divisiones': FALLBACK_DIVISIONES, 'fuente': 'fallback', 'fecha': fecha_hoy})

        divisiones = [{
            'nombre':      division_nombre,
            'precio_kwh':  kwh_val,
            'cargo_fijo':  fijo_val  if fijo_val  is not None else FALLBACK_DIVISIONES[0]['cargo_fijo'],
            'cargo_dist':  dist_val  if dist_val  is not None else FALLBACK_DIVISIONES[0]['cargo_dist'],
            'cargo_cap':   cap_val   if cap_val   is not None else FALLBACK_DIVISIONES[0]['cargo_cap'],
            'cargo_trans': trans_val,
        }]

        return jsonify({'ok': True, 'divisiones': divisiones, 'fuente': CFE_URL,
                        'fecha': fecha_hoy, 'division': division_nombre})

    except Exception as e:
        return jsonify({'ok': True, 'divisiones': FALLBACK_DIVISIONES, 'fuente': 'fallback',
                        'error_detail': str(e), 'fecha': fecha_hoy})


if __name__ == '__main__':
    print("=" * 60)
    print("  Calculadora de Recurso Solar — Servidor Flask")
    print("  Abrir en navegador: http://localhost:8000")
    print("=" * 60)
    app.run(debug=True, port=8000, use_reloader=False)
