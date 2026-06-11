# Spec: CFE GDMTO Location Picker + Solar Config Toggle v2.3
**Fecha:** 2026-06-09  
**Estado:** Aprobado

---

## Problema

El botón "Actualizar tarifas desde CFE" usa un GET simple que devuelve HTML de formulario (elementos de dropdown como texto), no datos de tarifas. La página CFE usa ASP.NET WebForms con cascada de PostBack: ddEstado → ddMunicipio → ddDivision. El usuario tampoco puede especificar su ubicación para que la región correcta se seleccione automáticamente.

Además, la sección "Configuración del Sistema Fotovoltaico" duplica innecesariamente la entrada de ubicación cuando ya se ingresó en CFE.

---

## Cambio A — Location Picker en CFE GDMTO

### A1. HTML (`index.html` sección `#economia`)

Insertar **antes** del `<h3>` "⏰ Precio CFE GDMTO" (línea ~689), dentro del `div.card.card-lg`:

```html
<!-- ── Ubicación para Consulta de Tarifas CFE ─────────────────────── -->
<h3 id="cfe-location-h3" style="font-size:.85rem;color:var(--accent-orange);
    text-transform:uppercase;letter-spacing:.06em;margin-bottom:.5rem;">
  📍 Ubicación para Consulta de Tarifas CFE
</h3>
<div style="font-size:.75rem;color:var(--text-muted);margin-bottom:1rem;line-height:1.6">
  Ingresa o detecta tu ubicación para consultar la División CFE correspondiente
  y obtener las tarifas GDMTO actualizadas automáticamente.
</div>

<!-- Buscador de dirección -->
<div class="form-group" style="margin-bottom:1rem;">
  <label class="form-label" for="cfe-address-search">
    🔎 Buscar dirección o ciudad
    <span class="label-unit">[autocompletado por Google]</span>
  </label>
  <input type="text" class="form-input" id="cfe-address-search"
         placeholder="Ej: Monterrey, Nuevo León" autocomplete="off" />
  <div id="cfe-address-status" class="geo-status"></div>
</div>

<!-- GPS -->
<div class="geo-btn-row" style="margin-bottom:1rem;">
  <button class="geo-locate-btn" id="btn-cfe-geolocate" type="button">
    <span>📡</span> Usar mi ubicación actual (GPS)
  </button>
  <div><div class="geo-status" id="cfe-geo-status"></div></div>
</div>

<!-- Lat / Lon CFE -->
<div class="form-grid" style="margin-bottom:1.5rem;">
  <div class="form-group">
    <label class="form-label" for="cfe-lat">
      Latitud <span class="label-unit">[° N positivo]</span>
    </label>
    <input type="number" class="form-input" id="cfe-lat"
           step="0.0001" value="25.6700" placeholder="Ej: 25.6700" />
  </div>
  <div class="form-group">
    <label class="form-label" for="cfe-lon">
      Longitud <span class="label-unit">[° E positivo / O negativo]</span>
    </label>
    <input type="number" class="form-input" id="cfe-lon"
           step="0.0001" value="-100.3100" placeholder="Ej: -100.3100" />
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

### A2. JS — Google Maps Autocomplete para CFE (`index.html` inline script, función `initGoogleMaps`)

Agregar al final de `initGoogleMaps()`, después del setup del Solar Config autocomplete:

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

### A3. JS — GPS handler + toggle/sync (`index.html` DOMContentLoaded block)

Dentro del mismo bloque `DOMContentLoaded` donde está `btn-geolocate`, agregar:

```javascript
// ── CFE GPS button ──────────────────────────────────────────────────
function syncCFELocationToSolar() {
  const toggle = document.getElementById('toggle-use-cfe-location');
  if (!toggle || !toggle.checked) return;
  const lat = document.getElementById('cfe-lat')?.value;
  const lon = document.getElementById('cfe-lon')?.value;
  if (lat) { document.getElementById('input-lat').value = lat; document.getElementById('input-lat').dispatchEvent(new Event('input',{bubbles:true})); }
  if (lon) { document.getElementById('input-lon').value = lon; document.getElementById('input-lon').dispatchEvent(new Event('input',{bubbles:true})); }
}

const cfeBtnGeo = document.getElementById('btn-cfe-geolocate');
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

// Sync manual cfe-lat/cfe-lon edits
['cfe-lat', 'cfe-lon'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('input', syncCFELocationToSolar);
});
```

### A4. JS — Update `fetchCFETariff()` (`solar_economics.js`)

Cambiar el fetch de `/api/cfe_gdmto` (GET) a `/api/cfe_gdmto_tarifa` (POST):

```javascript
const lat  = parseFloat(document.getElementById('cfe-lat')?.value  || '25.67');
const lon  = parseFloat(document.getElementById('cfe-lon')?.value  || '-100.31');
const anio = parseInt(document.getElementById('cfe-anio')?.value   || new Date().getFullYear());
const mes  = parseInt(document.getElementById('cfe-mes')?.value    || (new Date().getMonth() + 1));

const res = await fetch('/api/cfe_gdmto_tarifa', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ lat, lon, anio, mes })
});
```

Also update the success badge to show `data.division` if present:
```javascript
if (badge) badge.textContent = esFallback
  ? `⚠️ Valores de respaldo (CFE no accesible) · ${data.fecha}`
  : `✅ Tarifas CFE en vivo · ${data.division || ''} · ${data.fecha}`;
```

---

## Cambio B — Toggle "Usar misma ubicación" en Solar Config

### B1. HTML (`index.html` sección `#solar`)

1. Después del `<h3>` "📍 Geolocalización del Sitio" (~línea 814), **antes** del buscador, agregar el toggle:

```html
<!-- Toggle: usar ubicación de CFE -->
<div style="display:flex;align-items:center;gap:.75rem;margin-bottom:1rem;">
  <label class="toggle-switch">
    <input type="checkbox" id="toggle-use-cfe-location" checked />
    <span class="toggle-slider"></span>
  </label>
  <span style="font-size:.875rem;color:var(--text-secondary);">
    Usar misma ubicación que la de Tarifas CFE GDMTO
  </span>
</div>
```

2. Envolver el buscador de dirección + botón GPS (líneas ~819-836) en:
```html
<div id="solar-location-picker" style="display:none">
  <!-- address search div -->
  <!-- GPS button row -->
</div>
```

(El form-grid de lat/lon/alt permanece fuera del wrapper, siempre visible.)

### B2. JS — Toggle handler (`index.html` DOMContentLoaded)

```javascript
// ── Toggle: Usar misma ubicación que CFE ────────────────────────────
const toggleCFE  = document.getElementById('toggle-use-cfe-location');
const solPicker  = document.getElementById('solar-location-picker');
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
  applyToggle(); // run on page load
}
```

---

## Cambio C — Backend: multi-step WebForms `/api/cfe_gdmto_tarifa`

### C1. `app.py` — nuevo endpoint POST

```python
@app.route('/api/cfe_gdmto_tarifa', methods=['POST'])
def api_cfe_gdmto_tarifa():
    """Multi-step WebForms POST para obtener tarifas GDMTO por ubicación + mes/año."""
```

Flujo:
1. Recibir `{lat, lon, anio, mes}` del body JSON
2. Reverse geocoding: `GET maps.googleapis.com/maps/api/geocode/json?latlng={lat},{lon}&key=...&language=es` → extraer `administrative_area_level_1` (estado) y `locality` o `administrative_area_level_2` (municipio)
3. GET CFE page → extraer `__VIEWSTATE`, `__VIEWSTATEGENERATOR`, `__EVENTVALIDATION`, opciones de `ddEstado`
4. Normalizar estado_name → comparar con opciones (strip acentos, uppercase) → elegir `estado_val`
5. POST `__EVENTTARGET=...ddEstado` con `ddEstado=estado_val` → extraer opciones `ddMunicipio`
6. Normalizar municipio_name → match → elegir `municipio_val` (fallback: primer valor no vacío)
7. POST `__EVENTTARGET=...ddMunicipio` con `ddMunicipio=municipio_val` → extraer opciones `ddDivision` → elegir primera `division_val`
8. POST `ctl00$ContentPlaceHolder1$btnConsultar` con todos los campos y `ddAnio={anio}`, `ddMes={mes}` → parsear tabla de tarifas
9. Devolver `{ok, divisiones, fuente, fecha, division}` ó fallback

El módulo `unicodedata` (stdlib) se importa a nivel de módulo.

**Campos del POST:**
```
__VIEWSTATE, __VIEWSTATEGENERATOR, __EVENTVALIDATION
ctl00$ContentPlaceHolder1$EdoMpoDiv$ddEstado
ctl00$ContentPlaceHolder1$EdoMpoDiv$ddMunicipio
ctl00$ContentPlaceHolder1$EdoMpoDiv$ddDivision
ctl00$ContentPlaceHolder1$Fecha$ddAnio
ctl00$ContentPlaceHolder1$Fecha2$ddMes
ctl00$ContentPlaceHolder1$hdAnio
ctl00$ContentPlaceHolder1$hdMes
ctl00$ContentPlaceHolder1$btnConsultar  (valor: "Consultar")
```

GMAPS_KEY = `AIzaSyDIO9AKyM4TeZJ2O2uLbgPETJapKZLo_d4` (ya usada en el frontend)

Fallback idéntico al de `/api/cfe_gdmto`.
