# CFE Location Picker + Solar Config Toggle — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a location picker to the CFE GDMTO tariff section, enable multi-step WebForms scraping with state/municipality cascade, add year/month selectors, and add a "use same location as CFE" toggle to the Solar Config section.

**Architecture:** Three independent changes: (1) HTML structure additions, (2) JS logic for location pickers and sync, (3) Flask backend endpoint for multi-step CFE WebForms.

**Tech Stack:** HTML/CSS (existing toggle-switch pattern), vanilla JS (Google Maps Places API already loaded), Python/Flask/BeautifulSoup (already in project)

---

### Task 1: HTML — CFE location picker + year/month + Solar Config toggle

**Files:**
- Modify: `index.html`

Read the file before editing.

The existing project path is `/Users/eugenioleon/Calculadora-Recurso-Solar`.

#### Sub-task 1a: Add CFE location picker to #economia section

In `index.html`, find this comment before the economia card tariff section:
```
      <!-- Precio GDMTO + botón sync CFE -->
      <h3 style="font-size:.85rem;color:var(--accent-orange);text-transform:uppercase;letter-spacing:.06em;margin-bottom:.5rem;">⏰ Precio CFE GDMTO — Tarifa Plana</h3>
```

Insert BEFORE that h3 comment+element:

```html
      <!-- ── Ubicación para Consulta de Tarifas CFE ─────────────────────── -->
      <h3 style="font-size:.85rem;color:var(--accent-orange);text-transform:uppercase;letter-spacing:.06em;margin-bottom:.5rem;">📍 Ubicación para Consulta de Tarifas CFE</h3>
      <div style="font-size:.75rem;color:var(--text-muted);margin-bottom:1rem;line-height:1.6">
        Ingresa o detecta tu ubicación para consultar la División CFE correspondiente y obtener las tarifas GDMTO actualizadas automáticamente.
      </div>

      <!-- Buscador de dirección CFE -->
      <div class="form-group" style="margin-bottom:1rem;">
        <label class="form-label" for="cfe-address-search">
          🔎 Buscar dirección o ciudad <span class="label-unit">[autocompletado por Google]</span>
        </label>
        <input type="text" class="form-input" id="cfe-address-search"
               placeholder="Ej: Monterrey, Nuevo León" autocomplete="off" />
        <div id="cfe-address-status" class="geo-status"></div>
      </div>

      <!-- GPS CFE -->
      <div class="geo-btn-row">
        <button class="geo-locate-btn" id="btn-cfe-geolocate" type="button">
          <span>📡</span> Usar mi ubicación actual (GPS)
        </button>
        <div><div class="geo-status" id="cfe-geo-status"></div></div>
      </div>

      <!-- Lat / Lon CFE -->
      <div class="form-grid" style="margin-bottom:1.5rem;">
        <div class="form-group">
          <label class="form-label" for="cfe-lat">Latitud <span class="label-unit">[° N positivo]</span></label>
          <input type="number" class="form-input" id="cfe-lat" step="0.0001" value="25.6700" placeholder="Ej: 25.6700" />
        </div>
        <div class="form-group">
          <label class="form-label" for="cfe-lon">Longitud <span class="label-unit">[° E positivo / O negativo]</span></label>
          <input type="number" class="form-input" id="cfe-lon" step="0.0001" value="-100.3100" placeholder="Ej: -100.3100" />
        </div>
      </div>

      <!-- Año y Mes de la tarifa -->
      <div class="form-grid" style="margin-bottom:1.5rem;">
        <div class="form-group">
          <label class="form-label" for="cfe-anio">Año de la Tarifa</label>
          <select class="form-input" id="cfe-anio" style="cursor:pointer">
            <option value="2026" selected>2026</option>
            <option value="2025">2025</option>
            <option value="2024">2024</option>
            <option value="2023">2023</option>
            <option value="2022">2022</option>
            <option value="2021">2021</option>
            <option value="2020">2020</option>
            <option value="2019">2019</option>
            <option value="2018">2018</option>
            <option value="2017">2017</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label" for="cfe-mes">Mes de la Tarifa</label>
          <select class="form-input" id="cfe-mes" style="cursor:pointer">
            <option value="1">Enero</option>
            <option value="2">Febrero</option>
            <option value="3">Marzo</option>
            <option value="4">Abril</option>
            <option value="5">Mayo</option>
            <option value="6" selected>Junio</option>
            <option value="7">Julio</option>
            <option value="8">Agosto</option>
            <option value="9">Septiembre</option>
            <option value="10">Octubre</option>
            <option value="11">Noviembre</option>
            <option value="12">Diciembre</option>
          </select>
        </div>
      </div>

```

- [ ] **Step 1a:** Insert the CFE location picker HTML block before the "⏰ Precio CFE GDMTO" h3

#### Sub-task 1b: Add "Usar misma ubicación" toggle to Solar Config

In `index.html`, find the exact Geolocalización h3:
```html
      <!-- Geolocalización -->
      <h3 style="font-size:0.85rem;color:var(--accent-orange);text-transform:uppercase;letter-spacing:.06em;margin-bottom:1rem;">
        📍 Geolocalización del Sitio
      </h3>
```

After this h3 block, and BEFORE the existing "Buscador de dirección" form-group, insert the toggle:

```html
      <!-- Toggle: usar misma ubicación que CFE -->
      <div style="display:flex;align-items:center;gap:.75rem;margin-bottom:1rem;">
        <label class="toggle-switch">
          <input type="checkbox" id="toggle-use-cfe-location" checked />
          <span class="toggle-slider"></span>
        </label>
        <span style="font-size:.875rem;color:var(--text-secondary);">Usar misma ubicación que la de Tarifas CFE GDMTO</span>
      </div>
```

Then wrap the address search div + GPS button row in `<div id="solar-location-picker" style="display:none">...</div>`.

Specifically, wrap from:
```html
      <!-- Buscador de dirección con Google Places -->
      <div class="form-group" style="margin-bottom: 1rem;">
```
to the closing `</div>` of the GPS button row:
```html
      </div>
```
(the `</div>` that closes `<div class="geo-btn-row">`)

The form-grid for lat/lon/alt stays OUTSIDE the wrapper.

- [ ] **Step 1b:** Add toggle after geolocalización h3
- [ ] **Step 1c:** Wrap address search + GPS row in `<div id="solar-location-picker" style="display:none">`

- [ ] **Step 1d:** Commit
```bash
git add index.html
git commit -m "feat(html): CFE location picker, year/month selectors, and Solar Config toggle"
```

---

### Task 2: JS — Google Maps init for CFE + toggle/sync logic + fetchCFETariff update

**Files:**
- Modify: `index.html` (two inline `<script>` blocks)
- Modify: `assets/js/solar_economics.js`

Read both files before editing.

#### Sub-task 2a: Add CFE Autocomplete to `initGoogleMaps()` in index.html

Find the closing brace of `initGoogleMaps()` function (after `input.addEventListener('keydown', ...)` block) and add the CFE autocomplete setup BEFORE the closing `}`:

```javascript
    // ── CFE Location Autocomplete ──────────────────────────────────────
    const cfeInput  = document.getElementById('cfe-address-search');
    const cfeStatus = document.getElementById('cfe-address-status');
    if (cfeInput) {
      const cfeAuto = new google.maps.places.Autocomplete(cfeInput, {
        fields: ['formatted_address', 'geometry', 'name'],
        componentRestrictions: { country: ['mx'] },
      });
      cfeAuto.addListener('place_changed', () => {
        const place = cfeAuto.getPlace();
        if (!place.geometry?.location) {
          if (cfeStatus) { cfeStatus.className = 'geo-status err'; cfeStatus.textContent = '⚠️ No se encontraron coordenadas.'; }
          return;
        }
        const lat = place.geometry.location.lat();
        const lng = place.geometry.location.lng();
        document.getElementById('cfe-lat').value = lat.toFixed(6);
        document.getElementById('cfe-lon').value = lng.toFixed(6);
        syncCFELocationToSolar();
        if (cfeStatus) { cfeStatus.className = 'geo-status ok'; cfeStatus.textContent = `✅ ${place.formatted_address || place.name}`; }
      });
      cfeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
    }
```

- [ ] **Step 2a:** Add CFE autocomplete inside initGoogleMaps()

#### Sub-task 2b: Add syncCFELocationToSolar + toggle handler + CFE GPS in DOMContentLoaded

Find the DOMContentLoaded block that contains the Solar GPS button handler (the `const geoBtn = document.getElementById('btn-geolocate')` block). 

BEFORE the `const geoBtn = ...` line, add:

```javascript
    // ── syncCFELocationToSolar ──────────────────────────────────────────
    function syncCFELocationToSolar() {
      const toggle = document.getElementById('toggle-use-cfe-location');
      if (!toggle || !toggle.checked) return;
      const latVal = document.getElementById('cfe-lat')?.value;
      const lonVal = document.getElementById('cfe-lon')?.value;
      if (latVal) { const el = document.getElementById('input-lat'); if (el) { el.value = latVal; el.dispatchEvent(new Event('input', { bubbles: true })); } }
      if (lonVal) { const el = document.getElementById('input-lon'); if (el) { el.value = lonVal; el.dispatchEvent(new Event('input', { bubbles: true })); } }
    }

    // ── Toggle: Usar misma ubicación que CFE ────────────────────────────
    const toggleCFE = document.getElementById('toggle-use-cfe-location');
    const solPicker = document.getElementById('solar-location-picker');
    if (toggleCFE) {
      const applyToggle = () => {
        const isOn = toggleCFE.checked;
        if (solPicker) solPicker.style.display = isOn ? 'none' : '';
        ['input-lat', 'input-lon'].forEach(id => {
          const el = document.getElementById(id);
          if (el) el.readOnly = isOn;
        });
        if (isOn) syncCFELocationToSolar();
      };
      toggleCFE.addEventListener('change', applyToggle);
      applyToggle();
    }

    // Sync manual cfe-lat/cfe-lon edits to Solar Config
    ['cfe-lat', 'cfe-lon'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('input', syncCFELocationToSolar);
    });

    // ── CFE GPS button ──────────────────────────────────────────────────
    const cfeBtnGeo    = document.getElementById('btn-cfe-geolocate');
    const cfeGeoStatus = document.getElementById('cfe-geo-status');
    if (cfeBtnGeo) {
      cfeBtnGeo.addEventListener('click', () => {
        if (!navigator.geolocation) {
          if (cfeGeoStatus) { cfeGeoStatus.className = 'geo-status err'; cfeGeoStatus.textContent = '⚠️ Tu navegador no soporta geolocalización.'; }
          return;
        }
        cfeBtnGeo.classList.add('loading');
        cfeBtnGeo.textContent = '⏳ Obteniendo ubicación…';
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            document.getElementById('cfe-lat').value = pos.coords.latitude.toFixed(6);
            document.getElementById('cfe-lon').value = pos.coords.longitude.toFixed(6);
            syncCFELocationToSolar();
            cfeBtnGeo.classList.remove('loading');
            cfeBtnGeo.innerHTML = '<span>📡</span> Usar mi ubicación actual (GPS)';
            if (cfeGeoStatus) { cfeGeoStatus.className = 'geo-status ok'; cfeGeoStatus.textContent = `✅ ${pos.coords.latitude.toFixed(5)}°, ${pos.coords.longitude.toFixed(5)}° (±${Math.round(pos.coords.accuracy)} m)`; }
          },
          (err) => {
            cfeBtnGeo.classList.remove('loading');
            cfeBtnGeo.innerHTML = '<span>📡</span> Usar mi ubicación actual (GPS)';
            const msgs = { 1: 'Permiso denegado.', 2: 'Posición no disponible.', 3: 'Tiempo de espera agotado.' };
            if (cfeGeoStatus) { cfeGeoStatus.className = 'geo-status err'; cfeGeoStatus.textContent = '⚠️ ' + (msgs[err.code] || 'Error.'); }
          },
          { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }
        );
      });
    }
```

- [ ] **Step 2b:** Add sync function, toggle handler, and CFE GPS handler in DOMContentLoaded block

#### Sub-task 2c: Update `fetchCFETariff()` in solar_economics.js

Replace the `const res = await fetch('/api/cfe_gdmto')` call and surrounding context:

Old code:
```javascript
    const res  = await fetch('/api/cfe_gdmto');
    const data = await res.json();
```

New code:
```javascript
    const lat  = parseFloat(document.getElementById('cfe-lat')?.value  || '25.67');
    const lon  = parseFloat(document.getElementById('cfe-lon')?.value  || '-100.31');
    const anio = parseInt(document.getElementById('cfe-anio')?.value   || new Date().getFullYear());
    const mes  = parseInt(document.getElementById('cfe-mes')?.value    || (new Date().getMonth() + 1));

    const res  = await fetch('/api/cfe_gdmto_tarifa', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat, lon, anio, mes })
    });
    const data = await res.json();
```

Also update the badge success text. Old:
```javascript
    const esFallback = data.fuente === 'fallback';
    if (badge) badge.textContent = esFallback
      ? `⚠️ Valores de respaldo (CFE no accesible) · ${data.fecha}`
      : `✅ Tarifas de CFE · ${data.fecha}`;
```

New:
```javascript
    const esFallback = data.fuente === 'fallback';
    if (badge) badge.textContent = esFallback
      ? `⚠️ Valores de respaldo (CFE no accesible) · ${data.fecha}`
      : `✅ Tarifas CFE en vivo · ${data.division ? data.division + ' · ' : ''}${data.fecha}`;
```

- [ ] **Step 2c:** Update fetchCFETariff() to POST to /api/cfe_gdmto_tarifa

- [ ] **Step 2d:** Commit
```bash
git add index.html assets/js/solar_economics.js
git commit -m "feat(js): CFE location picker init, toggle sync logic, fetchCFETariff POST"
```

---

### Task 3: Backend — multi-step CFE WebForms endpoint

**Files:**
- Modify: `app.py`

Read `app.py` before editing. The current file has `import unicodedata` — check; if not present, add it at module level alongside the other imports.

Add `import unicodedata` near the top of `app.py` if not already there.

Then add the new endpoint BEFORE `if __name__ == '__main__':` (currently the last thing in the file):

```python
@app.route('/api/cfe_gdmto_tarifa', methods=['POST'])
def api_cfe_gdmto_tarifa():
    """Multi-step WebForms POST para tarifas GDMTO según ubicación y mes/año."""
    FALLBACK_DIVISIONES = [
        {'nombre': 'CDMX / Valle de México (respaldo 2025)', 'precio_kwh': 1.699, 'cargo_fijo': 466.83, 'cargo_demanda': 437.87},
        {'nombre': 'Noroeste (respaldo 2025)',                'precio_kwh': 1.821, 'cargo_fijo': 466.83, 'cargo_demanda': 450.12},
        {'nombre': 'Norte (respaldo 2025)',                   'precio_kwh': 1.756, 'cargo_fijo': 466.83, 'cargo_demanda': 442.55},
    ]
    fecha_hoy = datetime.date.today().isoformat()
    URL = "https://app.cfe.mx/Aplicaciones/CCFE/Tarifas/TarifasCRENegocio/Tarifas/GranDemandaMTO.aspx"
    HDR = {'User-Agent': 'Mozilla/5.0 (compatible; SolarCalc/2.3)'}

    body = request.get_json(silent=True) or {}
    lat  = float(body.get('lat',  25.67))
    lon  = float(body.get('lon', -100.31))
    anio = int(body.get('anio', datetime.date.today().year))
    mes  = int(body.get('mes',  datetime.date.today().month))

    # ── Reverse geocoding via Google Maps ──────────────────────────────
    GMAPS_KEY = 'AIzaSyDIO9AKyM4TeZJ2O2uLbgPETJapKZLo_d4'
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

    def normalize(s):
        return unicodedata.normalize('NFD', s).encode('ascii', 'ignore').decode('ascii').upper()

    def best_match(target, options):
        """Return option value whose text best matches target; fallback first non-zero."""
        if target:
            nt = normalize(target)
            for val, text in options:
                if val and val != '0' and (nt in normalize(text) or normalize(text) in nt):
                    return val
        for val, text in options:
            if val and val != '0':
                return val
        return None

    def extract_hidden(soup, name):
        el = soup.find('input', {'name': name})
        return el['value'] if el else ''

    def extract_options(soup, select_name):
        sel = soup.find('select', {'name': select_name})
        if not sel:
            return []
        return [(o.get('value', ''), o.get_text(strip=True)) for o in sel.find_all('option')]

    try:
        sess = requests.Session()

        # ── Step 1: GET ─────────────────────────────────────────────────
        r1 = sess.get(URL, verify=False, timeout=12, headers=HDR)
        r1.raise_for_status()
        r1.encoding = r1.apparent_encoding or 'utf-8'
        s1 = BeautifulSoup(r1.text, 'html.parser')

        vs  = extract_hidden(s1, '__VIEWSTATE')
        vsg = extract_hidden(s1, '__VIEWSTATEGENERATOR')
        ev  = extract_hidden(s1, '__EVENTVALIDATION')

        estado_options = extract_options(s1, 'ctl00$ContentPlaceHolder1$EdoMpoDiv$ddEstado')
        estado_val = best_match(estado_name, estado_options)
        if not estado_val:
            return jsonify({'ok': True, 'divisiones': FALLBACK_DIVISIONES, 'fuente': 'fallback', 'fecha': fecha_hoy})

        # ── Step 2: POST estado → get municipios ─────────────────────────
        base_fields = {
            '__VIEWSTATE':          vs,
            '__VIEWSTATEGENERATOR': vsg,
            '__EVENTVALIDATION':    ev,
            '__EVENTARGUMENT':      '',
            'ctl00$ContentPlaceHolder1$EdoMpoDiv$ddEstado':   estado_val,
            'ctl00$ContentPlaceHolder1$EdoMpoDiv$ddMunicipio': '0',
            'ctl00$ContentPlaceHolder1$EdoMpoDiv$ddDivision':  '0',
            'ctl00$ContentPlaceHolder1$Fecha$ddAnio':          str(anio),
            'ctl00$ContentPlaceHolder1$Fecha2$ddMes':          str(mes),
            'ctl00$ContentPlaceHolder1$hdAnio':                '',
            'ctl00$ContentPlaceHolder1$hdMes':                 '',
        }
        r2 = sess.post(URL, data={**base_fields,
            '__EVENTTARGET': 'ctl00$ContentPlaceHolder1$EdoMpoDiv$ddEstado'},
            verify=False, timeout=15, headers=HDR)
        s2 = BeautifulSoup(r2.text, 'html.parser')
        vs = extract_hidden(s2, '__VIEWSTATE') or vs
        ev = extract_hidden(s2, '__EVENTVALIDATION') or ev

        municipio_options = extract_options(s2, 'ctl00$ContentPlaceHolder1$EdoMpoDiv$ddMunicipio')
        municipio_val = best_match(municipio_name, municipio_options)
        if not municipio_val:
            return jsonify({'ok': True, 'divisiones': FALLBACK_DIVISIONES, 'fuente': 'fallback', 'fecha': fecha_hoy})

        # ── Step 3: POST municipio → get divisions ───────────────────────
        r3 = sess.post(URL, data={**base_fields,
            '__VIEWSTATE':       vs,
            '__EVENTVALIDATION': ev,
            '__EVENTTARGET':     'ctl00$ContentPlaceHolder1$EdoMpoDiv$ddMunicipio',
            'ctl00$ContentPlaceHolder1$EdoMpoDiv$ddMunicipio': municipio_val},
            verify=False, timeout=15, headers=HDR)
        s3 = BeautifulSoup(r3.text, 'html.parser')
        vs = extract_hidden(s3, '__VIEWSTATE') or vs
        ev = extract_hidden(s3, '__EVENTVALIDATION') or ev

        division_options = extract_options(s3, 'ctl00$ContentPlaceHolder1$EdoMpoDiv$ddDivision')
        division_val = best_match(None, division_options)  # just pick first non-zero
        if not division_val:
            return jsonify({'ok': True, 'divisiones': FALLBACK_DIVISIONES, 'fuente': 'fallback', 'fecha': fecha_hoy})
        division_nombre = next((t for v, t in division_options if v == division_val), division_val)

        # ── Step 4: POST final → get tariff table ────────────────────────
        # Find submit button name
        submit_btn = s3.find('input', {'type': 'submit'})
        btn_name  = submit_btn['name']  if submit_btn and submit_btn.get('name')  else 'ctl00$ContentPlaceHolder1$btnConsultar'
        btn_value = submit_btn['value'] if submit_btn and submit_btn.get('value') else 'Consultar'

        r4 = sess.post(URL, data={
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
        }, verify=False, timeout=20, headers=HDR)
        s4 = BeautifulSoup(r4.text, 'html.parser')

        # ── Parse tariff table ───────────────────────────────────────────
        money_re = re.compile(r'\$?\s*(\d{1,6}(?:,\d{3})*(?:\.\d+)?)')
        divisiones = []
        for table in s4.find_all('table'):
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
                if not nombre or normalize(nombre) in ('CONCEPTO', 'DIVISION', 'REGION'):
                    continue
                cargo_fijo    = nums[0]
                precio_kwh    = nums[1] if len(nums) > 1 else FALLBACK_DIVISIONES[0]['precio_kwh']
                cargo_demanda = (nums[2] + nums[3]) if len(nums) > 3 else (nums[2] if len(nums) > 2 else FALLBACK_DIVISIONES[0]['cargo_demanda'])
                divisiones.append({'nombre': nombre, 'precio_kwh': precio_kwh, 'cargo_fijo': cargo_fijo, 'cargo_demanda': cargo_demanda})

        if not divisiones:
            return jsonify({'ok': True, 'divisiones': FALLBACK_DIVISIONES, 'fuente': 'fallback', 'fecha': fecha_hoy})

        return jsonify({'ok': True, 'divisiones': divisiones, 'fuente': URL,
                        'fecha': fecha_hoy, 'division': division_nombre})

    except Exception as e:
        return jsonify({'ok': True, 'divisiones': FALLBACK_DIVISIONES, 'fuente': 'fallback',
                        'error_detail': str(e), 'fecha': fecha_hoy})
```

- [ ] **Step 3a:** Add `import unicodedata` at module level (near other stdlib imports)
- [ ] **Step 3b:** Add `api_cfe_gdmto_tarifa` endpoint before `if __name__ == '__main__':`

- [ ] **Step 3c:** Commit
```bash
git add app.py
git commit -m "feat(backend): /api/cfe_gdmto_tarifa multi-step WebForms scraper with reverse geocoding"
```
