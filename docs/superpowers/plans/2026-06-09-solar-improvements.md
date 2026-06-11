# Solar FV v2.2 – Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply six improvements to the solar FV calculator: document `eta_ref` in the guide table, switch economics from GDMTH to GDMTO (live CFE scraping), add Panel FV padding, fix NaN in T_cel display, fetch RH2M from NASA POWER, and add missing dependencies.

**Architecture:** Six independent changes across four files (`index.html`, `solar_app.js`, `solar_economics.js`, `app.py`). Changes are ordered so each task leaves the app in a working state. NASA RH2M is fetched as a second parameter in the existing NASA POWER climatology call. GDMTO replaces GDMTH completely (no dual-mode). CFE prices are fetched via a Flask proxy (SSL bypass) and fall back to hard-coded CDMX values if the site is unreachable.

**Tech Stack:** Flask 3.x, BeautifulSoup4, Requests, Vanilla JS (ES2020), Chart.js, NASA POWER REST API

---

## File Map

| File | Tasks |
|---|---|
| `requirements.txt` | Task 1 |
| `solar_engine.py` | Task 1 |
| `index.html` | Tasks 2, 5 |
| `assets/js/solar_app.js` | Tasks 3, 4 |
| `assets/js/solar_economics.js` | Tasks 5, 6 |
| `app.py` | Task 6 |

---

## Task 1: Dependency & solar_engine.py bug fixes

**Files:**
- Modify: `requirements.txt`
- Modify: `solar_engine.py:588`

- [ ] **Step 1: Add missing dependencies to requirements.txt**

Current content of `requirements.txt`:
```
flask
flask-cors
numpy
pandas
openpyxl
```

New content:
```
flask
flask-cors
numpy
pandas
openpyxl
requests
beautifulsoup4
```

- [ ] **Step 2: Install the new dependencies**

```bash
pip install requests beautifulsoup4
```

Expected: both packages install without error.

- [ ] **Step 3: Fix the undefined `eta` bug in solar_engine.py**

Line 588 references `eta` which is not defined in the function scope (the variable is `eta_ref`):

```python
# BEFORE (line 588):
'eta'                      : eta,           # guardado por compatibilidad
```

```python
# AFTER:
'eta'                      : eta_ref,       # guardado por compatibilidad
```

- [ ] **Step 4: Verify the backend starts without error**

```bash
python app.py
```

Expected: Flask starts on port 8000 with no `NameError: name 'eta' is not defined`.

- [ ] **Step 5: Commit**

```bash
git add requirements.txt solar_engine.py
git commit -m "fix: add requests/bs4 deps; fix undefined eta in solar_engine stats dict"
```

---

## Task 2: HTML quick fixes — eta_ref guide row + Panel FV padding

**Files:**
- Modify: `index.html:473` (guide table)
- Modify: `index.html:993` (Panel FV heading)

- [ ] **Step 1: Add eta_ref row to the guide reference table**

After line 473 (the closing `</tr>` of the "N° Paneles" row), insert:

```html
          <tr>
            <td class="param-name">&eta;_ref STC [fracción]</td>
            <td>Eficiencia real del panel en condiciones STC. <em>Opcional</em>: si se omite, se calcula automáticamente como P<sub>nom</sub> / (1000 × A)</td>
            <td class="param-range">0.05 – 0.30 (opcional)</td>
            <td>0.20, o vacío = auto</td>
          </tr>
```

The table `</tbody>` is at line 474 — this row goes just before it.

- [ ] **Step 2: Add margin-top to the Panel FV heading**

Line 993 currently reads:
```html
      <h3 style="font-size:0.85rem;color:var(--accent-orange);text-transform:uppercase;letter-spacing:.06em;margin-bottom:1rem;">
```

Change to:
```html
      <h3 style="font-size:0.85rem;color:var(--accent-orange);text-transform:uppercase;letter-spacing:.06em;margin-top:2.5rem;margin-bottom:1rem;">
```

- [ ] **Step 3: Verify visually**

Open `http://localhost:8000` → navigate to "Guía de Datos" section → confirm η_ref row appears at the end of the table. Then navigate to "Configuración del Sistema FV" → confirm visible space between the green Ángulos Óptimos box and "🔆 Especificaciones del Panel FV".

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat: add eta_ref row to guide table; add padding above Panel FV heading"
```

---

## Task 3: Fix NaN in T_cel display — add noct to thermalParams

**Files:**
- Modify: `assets/js/solar_app.js:1061-1067`

The `thermalParams` object (line 1061–1067) is missing `noct`. Line 1212 then evaluates `thermalParams.noct` → `undefined` → NaN in the displayed formula.

- [ ] **Step 1: Add `noct` to thermalParams**

Current code (lines 1061–1067):
```javascript
      const thermalParams = useThermal ? {
        temp_verano:  parseFloat($('temp-amb-verano').value),
        temp_invierno:parseFloat($('temp-amb-invierno').value),
        hum_verano:   parseFloat($('hum-verano').value),
        hum_invierno: parseFloat($('hum-invierno').value),
        viento:       parseFloat($('viento-vel').value)
      } : null;
```

New code:
```javascript
      const thermalParams = useThermal ? {
        temp_verano:  parseFloat($('temp-amb-verano').value),
        temp_invierno:parseFloat($('temp-amb-invierno').value),
        hum_verano:   parseFloat($('hum-verano').value),
        hum_invierno: parseFloat($('hum-invierno').value),
        viento:       parseFloat($('viento-vel').value),
        noct:         parseFloat($('input-NOCT').value),
      } : null;
```

- [ ] **Step 2: Verify**

In the app: enable "Modelo Térmico Extendido", run a solar calculation (manual T_amb mode). Confirm the "T_cel verano estimada" line shows a numeric value like `52.3°C` instead of `NaN°C`.

- [ ] **Step 3: Commit**

```bash
git add assets/js/solar_app.js
git commit -m "fix: add missing noct to thermalParams — was causing NaN in T_cel display"
```

---

## Task 4: NASA POWER — fetch RH2M alongside T2M

**Files:**
- Modify: `assets/js/solar_app.js:973-994` (`fetchTambienteNASA`)
- Modify: `assets/js/solar_app.js:1024-1038` (caller in `runSolar`)
- Modify: `assets/js/solar_app.js:793-811` (thermal block in `runSolarEngine`)
- Modify: `assets/js/solar_app.js:1205-1215` (T_cel display block)

- [ ] **Step 1: Rewrite `fetchTambienteNASA` to return `{ tamb_arr, rh_arr }`**

Replace lines 973–994 with:
```javascript
async function fetchTambienteNASA(lat, lon) {
  const url = `https://power.larc.nasa.gov/api/temporal/climatology/point?parameters=T2M,RH2M&community=RE&longitude=${lon}&latitude=${lat}&format=JSON`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`NASA POWER HTTP ${res.status}`);
  const data = await res.json();
  const t2m  = data.properties.parameter.T2M;
  const rh2m = data.properties.parameter.RH2M || null;
  const months = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
  const tamb_mensual = months.map(m => t2m[m]);
  const rh_mensual   = rh2m ? months.map(m => rh2m[m]) : null;

  const days_in_month = [31,28,31,30,31,30,31,31,30,31,30,31];
  const tamb_arr = new Float64Array(35040);
  const rh_arr   = rh_mensual ? new Float64Array(35040) : null;
  let idx = 0;
  for (let m = 0; m < 12; m++) {
    const pts  = days_in_month[m] * 96;
    const temp = tamb_mensual[m];
    const rh   = rh_mensual ? rh_mensual[m] : 0;
    for (let i = 0; i < pts; i++) {
      tamb_arr[idx] = temp;
      if (rh_arr) rh_arr[idx] = rh;
      idx++;
    }
  }
  return { tamb_arr, rh_arr };
}
```

- [ ] **Step 2: Update the NASA fetch caller in `runSolar` to update status messages**

Replace lines 1029–1037 (the try block inside `if (useThermal && currentTambMode === 'nasa')`):
```javascript
    try {
      const statusEl = $('nasa-tamb-status');
      if (statusEl) statusEl.innerHTML = `📡 Obteniendo perfil climatológico (T2M + RH2M) desde NASA POWER API...`;
      tamb_nasa_arr = await fetchTambienteNASA(payload.lat, payload.lon);
      const rhOk = tamb_nasa_arr.rh_arr !== null;
      if (statusEl) statusEl.innerHTML = rhOk
        ? `✅ Perfil T_amb + Humedad Relativa descargado de NASA POWER (resolución mensual → 15 min).`
        : `✅ T_amb de NASA POWER · ⚠️ RH2M no disponible para estas coordenadas — usando humedad manual.`;
    } catch (e) {
      console.error("NASA API Error:", e);
      if ($('nasa-tamb-status')) $('nasa-tamb-status').innerHTML = `⚠️ Falló conexión a NASA (${e.message}). Regresando a modo manual.`;
      setTambMode('manual');
    }
```

- [ ] **Step 3: Update the thermal block in `runSolarEngine` to use `rh_arr`**

The engine function uses `tamb_nasa_arr.length` directly (old array format). Replace lines 793–811:

```javascript
        // Soporte para ambos formatos: { tamb_arr, rh_arr } (nuevo) o Float64Array legacy
        const nasa_tamb = (tamb_nasa_arr && tamb_nasa_arr.tamb_arr) ? tamb_nasa_arr.tamb_arr : tamb_nasa_arr;
        const nasa_rh   = (tamb_nasa_arr && tamb_nasa_arr.rh_arr)   ? tamb_nasa_arr.rh_arr   : null;

        if (nasa_tamb && nasa_tamb.length > idx) {
          T_amb = nasa_tamb[idx];
          if (thermalParams) {
            const isVerano = (month_idx >= 4 && month_idx <= 9);
            RH     = nasa_rh ? nasa_rh[idx] : (isVerano ? thermalParams.hum_verano : thermalParams.hum_invierno);
            V_wind = thermalParams.viento;
          }
        } else if (thermalParams) {
          const isVerano = (month_idx >= 4 && month_idx <= 9);
          T_amb  = isVerano ? thermalParams.temp_verano  : thermalParams.temp_invierno;
          RH     = isVerano ? thermalParams.hum_verano   : thermalParams.hum_invierno;
          V_wind = thermalParams.viento;
        }
```

Note: the two lines `let T_amb = 25.0; let RH = 0.0; let V_wind = 0.0;` at lines 789–791 remain unchanged — only the if/else block below them changes.

- [ ] **Step 4: Update the T_cel display block to use NASA averages when available**

Replace lines 1205–1215:
```javascript
      if (useThermal) {
        const tBox = $('thermal-result-box');
        const tContent = $('thermal-result-content');
        if (tBox && tContent) {
          const noct_val   = parseFloat($('input-NOCT').value);
          const viento_val = parseFloat($('viento-vel').value);
          let tempVerano, humVerano;

          if (tamb_nasa_arr) {
            // Calcular promedio de meses de verano (mayo–oct, índices 4–9) del perfil NASA
            const nasaTamb = tamb_nasa_arr.tamb_arr ?? tamb_nasa_arr;
            const nasaRH   = tamb_nasa_arr.rh_arr   ?? null;
            const dpm = [31,28,31,30,31,30,31,31,30,31,30,31];
            let sumT = 0, sumRH = 0, count = 0;
            let ix = 0;
            for (let m = 0; m < 12; m++) {
              const pts = dpm[m] * 96;
              if (m >= 4 && m <= 9) {
                for (let i = 0; i < pts; i++) {
                  sumT += nasaTamb[ix + i];
                  if (nasaRH) sumRH += nasaRH[ix + i];
                }
                count += pts;
              }
              ix += pts;
            }
            tempVerano = sumT / count;
            humVerano  = nasaRH ? sumRH / count : (thermalParams?.hum_verano ?? 65);
          } else {
            tempVerano = thermalParams.temp_verano;
            humVerano  = thermalParams.hum_verano;
          }

          const T_cel = tempVerano + (noct_val - 20) * (1 - 0.003 * humVerano) * Math.max(0.1, 1 - 0.1 * viento_val);
          const totalGen       = data.stats.energia_anual_kWh;
          const genSinTermico  = data.stats.eta_ref * parseFloat($('input-area').value) * data.stats.horas_pico_sol_equiv * parseInt($('input-npanels').value) * 0.85 * (1.0 - parseFloat($('soiling-loss-pct')?.value ?? 0.05));
          const pctThermal     = genSinTermico > 0 ? ((genSinTermico - totalGen) / genSinTermico * 100) : 0;
          tContent.innerHTML   = `T_cel verano estimada (mediodía): <strong>${T_cel.toFixed(1)}°C</strong> &nbsp;|&nbsp; Pérdida térmica estimada: <strong style="color:#ef4444">${Math.max(0, pctThermal).toFixed(1)}%</strong>`;
          tBox.style.display = '';
        }
      }
```

- [ ] **Step 5: Verify**

Run the app. Enable thermal mode, switch to NASA mode, enter a valid lat/lon (e.g. 25.67 / -100.31), run the calculation. Confirm:
1. Status line reads "✅ Perfil T_amb + Humedad Relativa descargado..."
2. T_cel box shows a numeric temperature with no NaN.
3. Network tab shows `parameters=T2M,RH2M` in the NASA POWER request URL.

- [ ] **Step 6: Commit**

```bash
git add assets/js/solar_app.js
git commit -m "feat: fetch RH2M from NASA POWER alongside T2M; use in thermal model and T_cel display"
```

---

## Task 5: GDMTO economics — HTML redesign

**Files:**
- Modify: `index.html:669-806` (economics section)

Replace the entire `#economia` section content. The section opening tag `<section id="economia" class="section">` at line 669 and its closing `</section>` at ~line 807 stay; only the inner content changes.

- [ ] **Step 1: Replace the economics section inner content**

Replace everything from line 671 (`<div class="section-inner">`) to line 805 (`</div>`) with:

```html
  <div class="section-inner">
    <div class="section-header fade-in">
      <span class="section-tag tag-green">💰 Economía</span>
      <h2 class="section-title">Tarifas CFE GDMTO y Análisis de Inversión</h2>
      <p class="section-desc">
        Define el precio de la tarifa GDMTO (Gran Demanda Media Tensión Ordinaria) —
        tarifa plana sin distinción de horario ni temporada, que varía por región CFE.
        El costo total incluye energía consumida, cargo por demanda máxima mensual y cargo fijo.
      </p>
    </div>

    <div class="card card-lg fade-in">

      <!-- Precio GDMTO + botón sync CFE -->
      <h3 style="font-size:.85rem;color:var(--accent-orange);text-transform:uppercase;letter-spacing:.06em;margin-bottom:.5rem;">⏰ Precio CFE GDMTO — Tarifa Plana</h3>
      <div style="font-size:0.75rem;color:var(--text-muted);margin-bottom:1rem;line-height:1.6">
        La tarifa GDMTO tiene un <strong style="color:#fbbf24">precio único por kWh</strong> — sin distinción de hora ni temporada.
        El cargo varía por división CFE y se actualiza periódicamente.
      </div>

      <!-- Badge de fuente + botón actualizar -->
      <div style="display:flex;align-items:center;gap:.75rem;flex-wrap:wrap;margin-bottom:1rem;">
        <span id="cfe-tariff-source" style="font-size:.8rem;color:#94a3b8;">
          ⚠️ Valores de referencia — haz clic en "Actualizar" para obtener tarifas en vivo
        </span>
        <button onclick="fetchCFETariff()" id="cfe-sync-btn"
          style="background:rgba(249,115,22,0.12);border:1px solid rgba(249,115,22,0.4);color:#f97316;padding:.3rem .8rem;border-radius:8px;font-size:.8rem;cursor:pointer;white-space:nowrap;">
          🔄 Actualizar tarifas desde CFE
        </button>
      </div>

      <!-- Select de división (oculto hasta que el fetch retorne divisiones) -->
      <div id="cfe-division-wrap" style="display:none;margin-bottom:1rem;">
        <label class="form-label">División CFE de tu región</label>
        <select class="form-input" id="cfe-division-select" onchange="applyCFETariff()" style="cursor:pointer"></select>
      </div>

      <!-- Precios GDMTO -->
      <div class="form-grid" style="margin-bottom:1.5rem">
        <div class="form-group">
          <label class="form-label" for="precio-kwh">Precio de Energía <span class="label-unit">[$/kWh MXN]</span></label>
          <input type="number" class="form-input" id="precio-kwh" step="0.001" value="1.699" />
          <div style="font-size:.72rem;color:var(--text-muted);margin-top:.3rem">Precio único por kWh — sin variación horaria ni estacional</div>
        </div>
        <div class="form-group">
          <label class="form-label" for="cargo-fijo">Cargo Fijo Mensual <span class="label-unit">[$/mes MXN]</span></label>
          <input type="number" class="form-input" id="cargo-fijo" step="1" value="466.83" />
          <div style="font-size:.72rem;color:var(--text-muted);margin-top:.3rem">Cargo por usuario CFE independiente del consumo</div>
        </div>
        <div class="form-group">
          <label class="form-label" for="cargo-demanda-punta">Cargo por Demanda Máxima <span class="label-unit">[$/kW/mes MXN]</span></label>
          <input type="number" class="form-input" id="cargo-demanda-punta" step="0.01" value="437.87" />
          <div style="font-size:.72rem;color:var(--text-muted);margin-top:.3rem">Se cobra sobre la demanda máxima del mes (cualquier hora, no solo punta)</div>
        </div>
        <div class="form-group">
          <label class="form-label" for="cargo-respaldo">Cargo por Demanda de Respaldo <span class="label-unit">[$/kW/mes MXN]</span></label>
          <input type="number" class="form-input" id="cargo-respaldo" step="0.01" value="67.23" />
          <div style="font-size:.72rem;color:var(--text-muted);margin-top:.3rem">Aplica sobre la capacidad FV instalada como cargo de respaldo de red</div>
        </div>
        <div class="form-group">
          <label class="form-label" for="factor-respaldo">Factor de Demanda Respaldo <span class="label-unit">[0 – 100 %]</span></label>
          <input type="range" class="form-range" id="factor-respaldo" min="0" max="1" step="0.05" value="0.50" />
          <div class="range-value" id="factor-respaldo-val">50%</div>
        </div>
      </div>

      <!-- Análisis de Inversión -->
      <h3 style="font-size:.85rem;color:var(--accent-orange);text-transform:uppercase;letter-spacing:.06em;margin-bottom:1rem;">📈 Parámetros de Inversión y Precios</h3>
      <div class="form-grid" style="margin-bottom:1.5rem">
        <div class="form-group">
          <label class="form-label" for="panel-price-usd">Precio unitario del panel <span class="label-unit">[USD]</span></label>
          <input type="range" class="form-range" id="panel-price-usd" min="80" max="400" step="5" value="180" />
          <div class="range-value" id="panel-price-usd-val">$180 USD</div>
          <div style="font-size:0.72rem;color:var(--text-muted);margin-top:.3rem">Costo FOB del módulo Tier 1 de 400W en el mercado</div>
        </div>
        <div class="form-group">
          <label class="form-label" for="bos-cost">Otros Costos e Instalación <span class="label-unit">[MXN]</span></label>
          <input type="number" class="form-input" id="bos-cost" step="5000" value="240000" />
          <div style="font-size:0.72rem;color:var(--text-muted);margin-top:.3rem">Inversor, estructuras, cableado, ingeniería y mano de obra</div>
        </div>
        <div class="form-group">
          <label class="form-label" for="capex-total">CAPEX Total del Sistema <span class="label-unit">[Calculado, MXN]</span></label>
          <input type="number" class="form-input" id="capex-total" readonly style="background:rgba(16,185,129,0.06);color:#10b981;font-weight:700;border:1px solid rgba(16,185,129,0.3)" value="397500" />
          <div style="font-size:0.72rem;color:var(--text-muted);margin-top:.3rem">Fórmula: (Precio Panel × Tipo de Cambio × N° Paneles) + Otros Costos</div>
        </div>
        <div class="form-group">
          <label class="form-label" for="opex-pct">OPEX Anual <span class="label-unit">[% del CAPEX]</span></label>
          <input type="range" class="form-range" id="opex-pct" min="0.005" max="0.05" step="0.005" value="0.015" />
          <div class="range-value" id="opex-pct-val">1.5%</div>
        </div>
        <div class="form-group">
          <label class="form-label" for="vida-util">Vida Útil del Sistema <span class="label-unit">[años]</span></label>
          <input type="number" class="form-input" id="vida-util" step="1" min="5" max="40" value="25" />
        </div>
        <div class="form-group">
          <label class="form-label" for="degradacion-pct">Degradación Anual Paneles <span class="label-unit">[%/año]</span></label>
          <input type="range" class="form-range" id="degradacion-pct" min="0.002" max="0.01" step="0.001" value="0.005" />
          <div class="range-value" id="degradacion-pct-val">0.5%</div>
        </div>
        <div class="form-group">
          <label class="form-label" for="wacc">WACC / Tasa de Descuento <span class="label-unit">[%]</span></label>
          <input type="range" class="form-range" id="wacc" min="0.05" max="0.25" step="0.005" value="0.10" />
          <div class="range-value" id="wacc-val">10.0%</div>
        </div>
        <div class="form-group">
          <label class="form-label" for="inflacion-tarifa">Inflación Tarifaria CFE <span class="label-unit">[%/año]</span></label>
          <input type="range" class="form-range" id="inflacion-tarifa" min="0.00" max="0.15" step="0.005" value="0.05" />
          <div class="range-value" id="inflacion-tarifa-val">5.0%</div>
        </div>
        <div class="form-group">
          <label class="form-label" for="usd-mxn">Tipo de Cambio USD/MXN <span class="label-unit">[pesos por dólar]</span></label>
          <input type="number" class="form-input" id="usd-mxn" step="0.1" value="17.50" />
        </div>
      </div>

    </div>
  </div>
```

- [ ] **Step 2: Verify the economics section renders correctly**

Open `http://localhost:8000` → scroll to "Tarifas CFE GDMTO". Confirm:
- Title says "GDMTO", not "GDMTH"
- Single "Precio de Energía" input (no Base/Intermedio/Punta inputs)
- No summer tariff toggle or panel
- "🔄 Actualizar tarifas desde CFE" button is visible

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: replace GDMTH economics HTML with GDMTO flat-rate layout + CFE sync button"
```

---

## Task 6: GDMTO economics — JS calculation + CFE fetch + Flask endpoint

**Files:**
- Modify: `assets/js/solar_economics.js:1-97` (replace `getHorarioCFE` + `calcularFacturaCFE`)
- Modify: `assets/js/solar_economics.js:192-234` (`readEconomicParams`)
- Modify: `assets/js/solar_economics.js:240-326` (`renderEconomicResults`)
- Modify: `assets/js/solar_economics.js:484-492` (`runEconomics`)
- Add: `assets/js/solar_economics.js` (append `fetchCFETariff` + `applyCFETariff`)
- Modify: `assets/js/solar_app.js:1226,1236` (two string refs to "GDMTH")
- Modify: `app.py` (append `/api/cfe_gdmto` endpoint)

- [ ] **Step 1: Replace `getHorarioCFE` + `calcularFacturaCFE` with `calcularFacturaCFEGDMTO`**

Replace lines 1–97 of `solar_economics.js` (everything from the file header comment through the closing `}` of `calcularFacturaCFE`):

```javascript
/**
 * solar_economics.js
 * Módulo de análisis económico: Tarifas CFE GDMTO, ROI, VPN, TIR, LCOE
 * y gráfica de recuperación de inversión con barra móvil.
 */

// ─────────────────────────────────────────────────────────────────────────────
// CALCULADORA DE FACTURA CFE GDMTO (tarifa plana — sin distinción horaria)
// ─────────────────────────────────────────────────────────────────────────────
function calcularFacturaCFEGDMTO(demandArr, genArr, solarStats, params) {
  const { precio_kwh, cargo_fijo_mensual, cargo_demanda_punta, cargo_respaldo, factor_respaldo } = params;
  const days_in_month = [31,28,31,30,31,30,31,31,30,31,30,31];

  let total_e_sin = 0, total_e_con = 0;
  const monthly_max_sin = new Array(12).fill(0);
  const monthly_max_con = new Array(12).fill(0);

  let gi = 0;
  for (let m = 0; m < 12; m++) {
    for (let d = 0; d < days_in_month[m]; d++) {
      for (let iv = 0; iv < 96; iv++) {
        const dem = demandArr[gi] || 0;
        const gen = genArr[gi]    || 0;
        const net = Math.max(0, dem - gen);
        total_e_sin += dem * 0.25;
        total_e_con += net * 0.25;
        if (dem > monthly_max_sin[m]) monthly_max_sin[m] = dem;
        if (net > monthly_max_con[m]) monthly_max_con[m] = net;
        gi++;
      }
    }
  }

  const energy_cost_sin = total_e_sin * precio_kwh;
  const energy_cost_con = total_e_con * precio_kwh;
  const fixed_annual    = cargo_fijo_mensual * 12;

  let dem_charge_sin = 0, dem_charge_con = 0;
  for (let m = 0; m < 12; m++) {
    dem_charge_sin += monthly_max_sin[m] * cargo_demanda_punta;
    dem_charge_con += monthly_max_con[m] * cargo_demanda_punta;
  }

  const p_kw         = solarStats ? solarStats.p_nominal_total_kW : 0;
  const backup_annual = p_kw * factor_respaldo * cargo_respaldo * 12;

  const factura_sin = energy_cost_sin + dem_charge_sin + fixed_annual;
  const factura_con = energy_cost_con + dem_charge_con + fixed_annual + backup_annual;
  const ahorro      = factura_sin - factura_con;

  return {
    factura_sin, factura_con, ahorro,
    energy_cost_sin, energy_cost_con,
    dem_charge_sin, dem_charge_con,
    fixed_annual, backup_annual,
    total_e_sin, total_e_con,
  };
}
```

- [ ] **Step 2: Update `readEconomicParams` to read GDMTO fields**

Replace lines 192–234 (`readEconomicParams` function) with:

```javascript
// ─────────────────────────────────────────────────────────────────────────────
// LEER PARÁMETROS ECONÓMICOS DEL FORMULARIO (GDMTO)
// ─────────────────────────────────────────────────────────────────────────────
function readEconomicParams() {
  const g  = id => { const el = document.getElementById(id); return el ? parseFloat(el.value) : 0; };

  const panelPriceUSD = g('panel-price-usd') || 180;
  const usd_mxn       = g('usd-mxn')         || 17.50;
  const nPanels       = parseInt(document.getElementById('input-npanels')?.value ?? 50);
  const bosCost       = g('bos-cost')         || 240000;
  const capex         = (panelPriceUSD * usd_mxn * nPanels) + bosCost;

  const capexInput = document.getElementById('capex-total');
  if (capexInput) capexInput.value = Math.round(capex);

  return {
    precio_kwh:          g('precio-kwh')          || 1.699,
    cargo_fijo_mensual:  g('cargo-fijo')           || 466.83,
    cargo_demanda_punta: g('cargo-demanda-punta')  || 437.87,
    cargo_respaldo:      g('cargo-respaldo')       || 67.23,
    factor_respaldo:     g('factor-respaldo')      || 0.5,
    capex,
    opex_pct:            g('opex-pct')             || 0.015,
    vida_util:           Math.round(g('vida-util'))|| 25,
    degradacion:         g('degradacion-pct')      || 0.005,
    wacc:                g('wacc')                 || 0.10,
    inflacion:           g('inflacion-tarifa')     || 0.05,
    usd_mxn,
    outage_cost_ens:     g('outage-cost-ens')      || 8.50,
    outage_cost_fix:     g('outage-cost-fix')      || 5000,
    merma_maint_cost:    g('merma-maint-cost')     || 3500,
    merma_fail_cost:     g('merma-fail-cost')      || 85000,
  };
}
```

- [ ] **Step 3: Update `renderEconomicResults` — replace the `cfeBox` block with GDMTO layout**

The `cfeBox` block spans lines 274–326. Replace the entire `if (cfeBox && factura) { ... }` block:

```javascript
  // Tabla desglose CFE GDMTO
  const cfeBox = document.getElementById('cfe-breakdown-box');
  if (cfeBox && factura) {
    const th = (txt, color='#f97316') =>
      `<th style="padding:.6rem .9rem;text-align:left;color:${color};border-bottom:1px solid rgba(249,115,22,0.3)">${txt}</th>`;
    const td = (txt, extra='') =>
      `<td style="padding:.5rem .9rem;border-bottom:1px solid rgba(255,255,255,0.04)${extra}">${txt}</td>`;

    const rows = [
      ['⚡ Energía kWh/año',
        `${fm(factura.total_e_sin,0)} kWh`, `${fm(factura.total_e_con,0)} kWh`,
        fmMXN(factura.energy_cost_sin,0),    fmMXN(factura.energy_cost_con,0),
        fmMXN(factura.energy_cost_sin - factura.energy_cost_con, 0), '#10b981'],
      ['📈 Cargo por Demanda Máxima',
        '—', '—',
        fmMXN(factura.dem_charge_sin,0), fmMXN(factura.dem_charge_con,0),
        fmMXN(factura.dem_charge_sin - factura.dem_charge_con, 0), '#10b981'],
      ['🧾 Cargo Fijo',
        '—', '—',
        fmMXN(factura.fixed_annual,0), fmMXN(factura.fixed_annual,0),
        '$0 MXN', '#64748b'],
      ['🔌 Cargo Respaldo Solar',
        '—', '—',
        '—', fmMXN(factura.backup_annual,0),
        `<span style="color:#ef4444">-${fmMXN(factura.backup_annual,0)}</span>`, '#64748b'],
    ].map(([label, ks, kc, cs, cc, ahorro_fila, color]) => `<tr>
      ${td(label)}${td(ks)}${td(kc)}${td(cs)}${td(cc)}
      ${td(`<strong style="color:${color}">${ahorro_fila}</strong>`)}
    </tr>`).join('');

    cfeBox.innerHTML = `
      <div style="font-size:.85rem;color:var(--accent-orange);text-transform:uppercase;letter-spacing:.06em;margin-bottom:1rem;">
        💡 Desglose de Factura CFE GDMTO — Con Solar vs. Sin Solar
      </div>
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:.82rem">
          <thead>
            <tr style="background:rgba(249,115,22,0.12)">
              ${th('Concepto')}${th('kWh/año Sin Solar')}${th('kWh/año Con Solar')}
              ${th('Costo Sin Solar')}${th('Costo Con Solar')}${th('Ahorro','#10b981')}
            </tr>
          </thead>
          <tbody style="color:#cbd5e1">${rows}</tbody>
          <tfoot>
            <tr style="background:rgba(249,115,22,0.08);color:#f97316;font-weight:700">
              <td style="padding:.6rem .9rem;border-top:1px solid rgba(249,115,22,0.3)">TOTAL ANUAL</td>
              <td colspan="2" style="padding:.6rem .9rem;border-top:1px solid rgba(249,115,22,0.3)"></td>
              <td style="padding:.6rem .9rem;border-top:1px solid rgba(249,115,22,0.3)">${fmMXN(factura.factura_sin,0)}</td>
              <td style="padding:.6rem .9rem;border-top:1px solid rgba(249,115,22,0.3)">${fmMXN(factura.factura_con,0)}</td>
              <td style="padding:.6rem .9rem;border-top:1px solid rgba(249,115,22,0.3);color:#10b981">
                ${fmMXN(factura.ahorro,0)}<br><small style="color:var(--text-muted)">/ $${fm(factura.ahorro/usd,0)} USD</small>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>`;
    cfeBox.classList.add('visible');
  }
```

- [ ] **Step 4: Update `runEconomics` to call `calcularFacturaCFEGDMTO`**

Replace lines 487–492 (the `calcularFacturaCFE` call):
```javascript
  const factura = calcularFacturaCFEGDMTO(
    state.demandData.demand_kW,
    state.solarData.P_kw_arr,
    state.solarData.stats,
    params
  );
```

- [ ] **Step 5: Update "GDMTH" string references in solar_app.js**

Line 1226: `// Análisis económico (CFE GDMTH + ROI/VPN/TIR + gráfica inversión)`
→ `// Análisis económico (CFE GDMTO + ROI/VPN/TIR + gráfica inversión)`

Line 1236: `showAlert('solar-alert', 'success', 'Cálculo completado — Motor Jensen · Análisis CFE GDMTH · ROI calculado.');`
→ `showAlert('solar-alert', 'success', 'Cálculo completado — Motor Jensen · Análisis CFE GDMTO · ROI calculado.');`

- [ ] **Step 6: Append `fetchCFETariff` and `applyCFETariff` to solar_economics.js**

Add at the very end of `solar_economics.js` (after the last closing `}`):

```javascript

// ─────────────────────────────────────────────────────────────────────────────
// FETCH TARIFAS GDMTO EN VIVO DESDE CFE (vía backend Flask)
// ─────────────────────────────────────────────────────────────────────────────
let _cfeDivisiones = null;

async function fetchCFETariff() {
  const btn    = document.getElementById('cfe-sync-btn');
  const badge  = document.getElementById('cfe-tariff-source');
  const divWrap = document.getElementById('cfe-division-wrap');

  if (btn) { btn.disabled = true; btn.textContent = '⏳ Consultando CFE...'; }
  if (badge) badge.textContent = '⏳ Obteniendo tarifas desde CFE...';

  try {
    const res  = await fetch('/api/cfe_gdmto');
    const data = await res.json();
    _cfeDivisiones = data.divisiones || [];

    if (_cfeDivisiones.length === 0) throw new Error('Sin datos de divisiones en la respuesta');

    if (divWrap) {
      const sel = document.getElementById('cfe-division-select');
      if (sel) {
        sel.innerHTML = _cfeDivisiones.map((d, i) =>
          `<option value="${i}">${d.nombre}</option>`
        ).join('');
        divWrap.style.display = '';
      }
    }

    applyCFETariff();

    const esFallback = data.fuente === 'fallback';
    if (badge) badge.textContent = esFallback
      ? `⚠️ Valores de respaldo (CFE no accesible) · ${data.fecha}`
      : `✅ Tarifas de CFE · ${data.fecha}`;

  } catch (e) {
    if (badge) badge.textContent = `❌ Error al consultar CFE: ${e.message}. Ajusta los valores manualmente.`;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🔄 Actualizar tarifas desde CFE'; }
  }
}

function applyCFETariff() {
  if (!_cfeDivisiones) return;
  const sel = document.getElementById('cfe-division-select');
  const idx = sel ? parseInt(sel.value) : 0;
  const div = _cfeDivisiones[idx];
  if (!div) return;

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
  set('precio-kwh',          div.precio_kwh.toFixed(4));
  set('cargo-fijo',          div.cargo_fijo.toFixed(2));
  set('cargo-demanda-punta', div.cargo_demanda.toFixed(2));
}
```

- [ ] **Step 7: Add the `/api/cfe_gdmto` endpoint to app.py**

At the end of `app.py`, before `if __name__ == '__main__':`, insert:

```python
@app.route('/api/cfe_gdmto', methods=['GET'])
def api_cfe_gdmto():
    """Obtiene tarifas GDMTO en vivo desde app.cfe.mx (SSL-broken, usa verify=False)."""
    import re
    import requests
    from bs4 import BeautifulSoup

    FALLBACK_DIVISIONES = [
        {'nombre': 'CDMX / Valle de México (referencia 2025)', 'precio_kwh': 1.699, 'cargo_fijo': 466.83, 'cargo_demanda': 437.87},
        {'nombre': 'Noroeste (referencia 2025)',                'precio_kwh': 1.821, 'cargo_fijo': 466.83, 'cargo_demanda': 450.12},
        {'nombre': 'Norte (referencia 2025)',                   'precio_kwh': 1.756, 'cargo_fijo': 466.83, 'cargo_demanda': 442.55},
    ]
    fecha_hoy = datetime.date.today().isoformat()

    URL = "https://app.cfe.mx/Aplicaciones/CCFE/Tarifas/TarifasCRENegocio/Tarifas/GranDemandaMTO.aspx"

    try:
        requests.packages.urllib3.disable_warnings()
        r = requests.get(
            URL, verify=False, timeout=12,
            headers={'User-Agent': 'Mozilla/5.0 (compatible; SolarCalc/2.2)'}
        )
        r.raise_for_status()
        r.encoding = r.apparent_encoding or 'utf-8'
        soup = BeautifulSoup(r.text, 'html.parser')

        money_re = re.compile(r'\$?\s*(\d{1,6}(?:,\d{3})*(?:\.\d+)?)')
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
                if not nombre or nombre.lower() in ('concepto', 'división', 'region'):
                    continue
                # Columna más probable: cargo_fijo | precio_kwh | cargo_demanda_dist [| cargo_demanda_cap]
                cargo_fijo      = nums[0] if len(nums) > 0 else FALLBACK_DIVISIONES[0]['cargo_fijo']
                precio_kwh      = nums[1] if len(nums) > 1 else FALLBACK_DIVISIONES[0]['precio_kwh']
                cargo_demanda   = (nums[2] + nums[3]) if len(nums) > 3 else (nums[2] if len(nums) > 2 else FALLBACK_DIVISIONES[0]['cargo_demanda'])
                divisiones.append({'nombre': nombre, 'precio_kwh': precio_kwh, 'cargo_fijo': cargo_fijo, 'cargo_demanda': cargo_demanda})

        if not divisiones:
            return jsonify({'ok': True, 'divisiones': FALLBACK_DIVISIONES, 'fuente': 'fallback', 'fecha': fecha_hoy})

        return jsonify({'ok': True, 'divisiones': divisiones, 'fuente': URL, 'fecha': fecha_hoy})

    except Exception as e:
        return jsonify({'ok': True, 'divisiones': FALLBACK_DIVISIONES, 'fuente': 'fallback',
                        'error_detail': str(e), 'fecha': fecha_hoy})
```

- [ ] **Step 8: Verify the full economics flow**

1. Restart Flask: `python app.py`
2. Open `http://localhost:8000`
3. Load a demand profile, configure a solar system, run the calculation.
4. Confirm the "Desglose de Factura CFE GDMTO" table appears (4 rows: Energía / Demanda / Cargo Fijo / Cargo Respaldo) with numeric values.
5. Click "🔄 Actualizar tarifas desde CFE". Confirm:
   - Button shows "⏳ Consultando CFE..." during fetch
   - Badge updates to either "✅ Tarifas de CFE" or "⚠️ Valores de respaldo"
   - If the fetch succeeds and returns divisions, the `<select>` appears
   - The price inputs update when a division is selected
6. In the browser Network tab, confirm `GET /api/cfe_gdmto` returns JSON with `divisiones` array.

- [ ] **Step 9: Commit**

```bash
git add assets/js/solar_economics.js assets/js/solar_app.js app.py
git commit -m "feat: GDMTO economics — flat-rate calc, live CFE tariff fetch, updated breakdown table"
```

---

## Self-Review Checklist

- [x] **Spec §1 (eta_ref guide table):** Covered in Task 2 Step 1.
- [x] **Spec §2a (Flask /api/cfe_gdmto):** Covered in Task 6 Step 7.
- [x] **Spec §2b (calcularFacturaCFEGDMTO):** Covered in Task 6 Step 1. Max demand is computed over ALL intervals of the month (not just peak hours) — matches GDMTO spec.
- [x] **Spec §2c (HTML GDMTO):** Covered in Task 5 Step 1. Removed 3 price inputs + summer toggle + summer panel. Added single precio-kwh + CFE badge + sync button + division select.
- [x] **Spec §3 (padding Panel FV):** Covered in Task 2 Step 2 (`margin-top:2.5rem`).
- [x] **Spec §4 (NaN T_cel):** Covered in Task 3 Step 1 (added `noct` to thermalParams). Task 4 Step 4 also fixes the display path for NASA mode (uses NASA averages instead of thermalParams.temp_verano).
- [x] **Spec §5 (NASA RH2M):** Covered in Task 4. `fetchTambienteNASA` requests `T2M,RH2M`, returns `{ tamb_arr, rh_arr }`. Engine uses `rh_arr[idx]` when available.
- [x] **Spec §6 (requirements.txt):** Covered in Task 1.
- [x] **Type consistency:** `calcularFacturaCFEGDMTO` returns `{ factura_sin, factura_con, ahorro, energy_cost_sin, energy_cost_con, dem_charge_sin, dem_charge_con, fixed_annual, backup_annual, total_e_sin, total_e_con }`. `renderEconomicResults` accesses exactly these fields. `calcularROI` receives `factura.ahorro` — present. ✓
- [x] **No old field names in new code:** `readEconomicParams` returns `precio_kwh` (not `precio_base`/`precio_punta`). `calcularFacturaCFEGDMTO` destructures `precio_kwh` — consistent. ✓
- [x] **Fallback when CFE unreachable:** `/api/cfe_gdmto` always returns 200 with a `divisiones` array (either scraped or FALLBACK_DIVISIONES). ✓
- [x] **Legacy tamb_nasa_arr format:** Task 4 Step 3 adds `const nasa_tamb = (tamb_nasa_arr && tamb_nasa_arr.tamb_arr) ? tamb_nasa_arr.tamb_arr : tamb_nasa_arr;` — handles both old Float64Array and new `{ tamb_arr, rh_arr }` object. ✓
