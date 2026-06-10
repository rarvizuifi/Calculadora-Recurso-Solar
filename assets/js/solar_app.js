/**
 * solar_app.js
 * Lógica del frontend para el Motor Solar Fotovoltaico.
 * Ejecución 100% en el cliente (Browser-side / Serverless).
 * Calcula el modelo matemático de Jensen, generación de demanda, KPIs y
 * descargas de reportes multi-hoja de Excel de forma local e instantánea.
 */

// ─────────────────────────────────────────────────────────────────────────────
// ESTADO GLOBAL
// ─────────────────────────────────────────────────────────────────────────────
const state = {
  demandData: null,
  solarData:  null,
  charts: {}
};

const MONTHS = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
const HOURS_96 = Array.from({length: 96}, (_, i) => {
  const h = Math.floor(i / 4);
  const m = (i % 4) * 15;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
});

// ─────────────────────────────────────────────────────────────────────────────
// UTILIDADES
// ─────────────────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

function showLoader(text = 'Calculando...') {
  const ol = $('loader-overlay');
  if (ol) {
    ol.querySelector('.loader-text').textContent = text;
    ol.classList.add('active');
  }
}
function hideLoader() { if ($('loader-overlay')) $('loader-overlay').classList.remove('active'); }

function showAlert(containerId, type, msg) {
  const el = $(containerId);
  if (!el) return;
  el.innerHTML = `<div class="alert alert-${type}">
    <span>${type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️'}</span>
    <span>${msg}</span>
  </div>`;
}

function formatNum(n, dec = 1) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return Number(n).toFixed(dec).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// ─────────────────────────────────────────────────────────────────────────────
// CONVERSIONES Y CONSTANTES FÍSICAS DE JENSEN
// ─────────────────────────────────────────────────────────────────────────────
const DEG = Math.PI / 180.0;
const GSC = 1367.0;  // Constante solar [W/m²]
const RHO = 0.20;    // Albedo del suelo

function _dayOfYear(month, day) {
  const daysPerMonth = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let sum = 0;
  for (let i = 0; i < month; i++) sum += daysPerMonth[i];
  return sum + day;
}

function _declination(n) {
  return 23.45 * DEG * Math.sin(2.0 * Math.PI * (n - 81) / 365);
}

function _equationOfTime(n) {
  const B = 2.0 * Math.PI * (n - 1) / 365;
  return 229.18 * (0.000075 + 0.001868 * Math.cos(B) - 0.032077 * Math.sin(B)
                   - 0.014615 * Math.cos(2 * B) - 0.04089 * Math.sin(2 * B));
}

function _hourAngle(hourSolar) {
  return (hourSolar - 12.0) * 15.0 * DEG;
}

function _solarPosition(latRad, lonRad, n, hourStd, lonRefRad = 0.0) {
  const delta = _declination(n);
  const eot = _equationOfTime(n);
  const hourSolar = hourStd + (4.0 * (lonRad - lonRefRad) / DEG + eot) / 60.0;
  const omega = _hourAngle(hourSolar);

  let sinAlpha = Math.sin(latRad) * Math.sin(delta) +
                 Math.cos(latRad) * Math.cos(delta) * Math.cos(omega);
  sinAlpha = Math.max(-1.0, Math.min(1.0, sinAlpha));
  const alpha = Math.asin(sinAlpha);

  const cosAlpha = Math.cos(alpha);
  let azimuth = 0.0;
  if (cosAlpha >= 1e-10) {
    let cosAz = (Math.sin(delta) - Math.sin(latRad) * sinAlpha) / (Math.cos(latRad) * cosAlpha);
    cosAz = Math.max(-1.0, Math.min(1.0, cosAz));
    azimuth = Math.acos(cosAz);
    if (Math.sin(omega) > 0) {
      azimuth = 2.0 * Math.PI - azimuth;
    }
  }
  return { alpha, azimuth };
}

function _airMass(alphaRad) {
  if (alphaRad < 5.0 * DEG) return null;
  return 1.0 / Math.sin(alphaRad);
}

function _irradianceHorizontal(alphaRad, n) {
  if (alphaRad <= 5.0 * DEG) return { Gb_h: 0.0, Gd_h: 0.0 };

  const Eo = 1.0 + 0.033 * Math.cos(2.0 * Math.PI * n / 365);
  const G0 = GSC * Eo * Math.sin(alphaRad);

  const AM = _airMass(alphaRad);
  if (AM === null) return { Gb_h: 0.0, Gd_h: 0.0 };

  const tau_b = Math.pow(0.7, Math.pow(AM, 0.678));
  const Gb_h = G0 *  tau_b;
  const Gd_h = G0 * (1.0 - tau_b) * 0.5;

  return { Gb_h: Math.max(0.0, Gb_h), Gd_h: Math.max(0.0, Gd_h) };
}

function _angleOfIncidence(alphaRad, azimuthSunRad, tiltRad, azimuthPanelRad) {
  const cosTheta = Math.sin(alphaRad) * Math.cos(tiltRad) +
                   Math.cos(alphaRad) * Math.cos(azimuthSunRad - azimuthPanelRad) * Math.sin(tiltRad);
  return Math.acos(Math.max(-1.0, Math.min(1.0, cosTheta)));
}

function _poaIrradiance(Gb_h, Gd_h, alphaRad, azimuthSunRad, tiltRad, azimuthPanelRad) {
  if (alphaRad <= 5.0 * DEG) return 0.0;

  const theta_i = _angleOfIncidence(alphaRad, azimuthSunRad, tiltRad, azimuthPanelRad);
  const cosThetaI = Math.cos(theta_i);
  let Gb_poa = 0.0;
  if (cosThetaI > 0) {
    const Rb = Math.sin(alphaRad) > 0.01 ? cosThetaI / Math.sin(alphaRad) : 0.0;
    Gb_poa = Gb_h * Rb;
  }
  const Gd_poa = Gd_h * (1.0 + Math.cos(tiltRad)) / 2.0;
  const Gr_poa = (Gb_h + Gd_h) * RHO * (1.0 - Math.cos(tiltRad)) / 2.0;
  return Math.max(0.0, Gb_poa + Gd_poa + Gr_poa);
}

// ─────────────────────────────────────────────────────────────────────────────
// PERFILES DE DEMANDA INDUSTRIAL
// ─────────────────────────────────────────────────────────────────────────────
const PLANT_PROFILES = {
  manufactura_ligera: {
    name: 'Manufactura Ligera',
    weekday: [
      0.35, 0.33, 0.32, 0.32, 0.34, 0.60, 0.82, 0.95, 1.00, 1.00, 0.98, 0.72,
      0.72, 0.96, 1.00, 1.00, 0.95, 0.78, 0.68, 0.65, 0.60, 0.55, 0.45, 0.38
    ],
    weekend: [
      0.15, 0.14, 0.13, 0.13, 0.14, 0.20, 0.30, 0.42, 0.48, 0.48, 0.46, 0.40,
      0.38, 0.42, 0.46, 0.44, 0.40, 0.35, 0.30, 0.25, 0.22, 0.20, 0.17, 0.15
    ]
  },
  manufactura_pesada: {
    name: 'Manufactura Pesada',
    weekday: [
      0.70, 0.68, 0.67, 0.66, 0.68, 0.75, 0.85, 0.95, 1.00, 1.00, 0.98, 0.95,
      0.88, 0.95, 1.00, 1.00, 0.98, 0.95, 0.90, 0.85, 0.82, 0.80, 0.75, 0.72
    ],
    weekend: [
      0.60, 0.58, 0.56, 0.55, 0.56, 0.60, 0.65, 0.70, 0.75, 0.75, 0.73, 0.70,
      0.68, 0.70, 0.72, 0.70, 0.68, 0.65, 0.63, 0.62, 0.61, 0.60, 0.59, 0.60
    ]
  },
  oficinas: {
    name: 'Edificio de Oficinas',
    weekday: [
      0.12, 0.11, 0.11, 0.11, 0.12, 0.20, 0.45, 0.72, 0.90, 0.98, 1.00, 1.00,
      0.90, 0.98, 1.00, 0.98, 0.90, 0.70, 0.45, 0.30, 0.22, 0.18, 0.15, 0.12
    ],
    weekend: [
      0.10, 0.10, 0.10, 0.10, 0.10, 0.12, 0.15, 0.18, 0.20, 0.22, 0.22, 0.20,
      0.18, 0.18, 0.18, 0.15, 0.14, 0.12, 0.11, 0.10, 0.10, 0.10, 0.10, 0.10
    ]
  },
  almacen: {
    name: 'Almacén',
    weekday: [
      0.20, 0.18, 0.18, 0.18, 0.20, 0.40, 0.65, 0.85, 0.95, 1.00, 1.00, 0.95,
      0.88, 0.95, 1.00, 0.98, 0.92, 0.80, 0.60, 0.40, 0.32, 0.28, 0.24, 0.20
    ],
    weekend: [
      0.18, 0.17, 0.17, 0.17, 0.18, 0.25, 0.35, 0.50, 0.60, 0.65, 0.65, 0.62,
      0.58, 0.62, 0.65, 0.62, 0.55, 0.45, 0.35, 0.28, 0.24, 0.22, 0.20, 0.18
    ]
  },
  data_center: {
    name: 'Centro de Datos',
    weekday: [
      0.88, 0.87, 0.86, 0.86, 0.87, 0.89, 0.92, 0.96, 1.00, 1.00, 0.99, 0.98,
      0.97, 0.98, 1.00, 1.00, 0.99, 0.98, 0.96, 0.94, 0.92, 0.91, 0.90, 0.89
    ],
    weekend: [
      0.86, 0.85, 0.84, 0.84, 0.85, 0.86, 0.88, 0.90, 0.92, 0.93, 0.93, 0.92,
      0.91, 0.91, 0.92, 0.91, 0.90, 0.89, 0.88, 0.87, 0.87, 0.86, 0.86, 0.86
    ]
  }
};

// Generador de números pseudoaleatorios con semilla (Mulberry32)
function mulberry32(a) {
  return function() {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}

// Transformación Box-Muller para ruido Gaussiano normalizado
function gaussianRandom(rnd) {
  let u = 0, v = 0;
  while (u === 0) u = rnd();
  while (v === 0) v = rnd();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

// ─────────────────────────────────────────────────────────────────────────────
// SLIDERS EN TIEMPO REAL
// ─────────────────────────────────────────────────────────────────────────────
function initSliders() {
  const sliders = [
    { slider: 'fc-planta',        display: 'fc-planta-val',        suffix: '%',     multiplier: 100, decimals: 0 },
    { slider: 'fp-potencia',      display: 'fp-potencia-val',      suffix: '',      multiplier: 1,   decimals: 2 },
    { slider: 'chi-panel',        display: 'chi-panel-val',        suffix: ' %/°C', multiplier: 1,   decimals: 2 },
    { slider: 'tilt-angle',       display: 'tilt-val',             suffix: '°',     multiplier: 1,   decimals: 0 },
    { slider: 'weekend-factor',   display: 'weekend-factor-val',   suffix: '%',     multiplier: 100, decimals: 0 },
    { slider: 'summer-boost',     display: 'summer-boost-val',     suffix: '',      multiplier: 1,   decimals: 2, prefix: '×' },
    { slider: 'noise-pct',        display: 'noise-pct-val',        suffix: '%',     multiplier: 100, decimals: 1 },
    { slider: 'rain-loss-pct',    display: 'rain-loss-pct-val',    suffix: '%',     multiplier: 100, decimals: 0 },
    { slider: 'rain-days',        display: 'rain-days-val',        suffix: ' días', multiplier: 1,   decimals: 0 },
    { slider: 'soiling-loss-pct', display: 'soiling-loss-pct-val', suffix: '%',     multiplier: 100, decimals: 0 },
    { slider: 'panel-price-usd',  display: 'panel-price-usd-val',  suffix: ' USD',  multiplier: 1,   decimals: 0, prefix: '$' },
    { slider: 'factor-respaldo',  display: 'factor-respaldo-val',  suffix: '%',     multiplier: 100, decimals: 0 },
    { slider: 'opex-pct',         display: 'opex-pct-val',         suffix: '%',     multiplier: 100, decimals: 1 },
    { slider: 'degradacion-pct',  display: 'degradacion-pct-val',  suffix: '%',     multiplier: 100, decimals: 1 },
    { slider: 'wacc',             display: 'wacc-val',             suffix: '%',     multiplier: 100, decimals: 1 },
    { slider: 'inflacion-tarifa', display: 'inflacion-tarifa-val', suffix: '%',     multiplier: 100, decimals: 1 },
    { slider: 'outage-freq',      display: 'outage-freq-val',      suffix: ' eventos', multiplier: 1, decimals: 0 },
    { slider: 'outage-dur',       display: 'outage-dur-val',       suffix: ' horas', multiplier: 1, decimals: 2 },
    { slider: 'merma-maint-freq', display: 'merma-maint-freq-val', suffix: ' eventos', multiplier: 1, decimals: 0 },
    { slider: 'merma-maint-dur',  display: 'merma-maint-dur-val',  suffix: ' horas', multiplier: 1, decimals: 0 },
    { slider: 'merma-dmg-prob',   display: 'merma-dmg-prob-val',   suffix: '%', multiplier: 1, decimals: 0 },
    { slider: 'merma-dmg-impact', display: 'merma-dmg-impact-val', suffix: '%', multiplier: 1, decimals: 0 },
    { slider: 'merma-dmg-dur',    display: 'merma-dmg-dur-val',    suffix: ' días', multiplier: 1, decimals: 0 },
    { slider: 'merma-fail-prob',  display: 'merma-fail-prob-val',  suffix: '%', multiplier: 1, decimals: 1 },
    { slider: 'merma-fail-dur',   display: 'merma-fail-dur-val',   suffix: ' días', multiplier: 1, decimals: 0 },
    // Térmicos
    { slider: 'temp-amb-verano',  display: 'temp-amb-verano-val',  suffix: ' °C',   multiplier: 1, decimals: 1 },
    { slider: 'temp-amb-invierno',display: 'temp-amb-invierno-val',suffix: ' °C',   multiplier: 1, decimals: 1 },
    { slider: 'hum-verano',       display: 'hum-verano-val',       suffix: '%',     multiplier: 1, decimals: 0 },
    { slider: 'hum-invierno',     display: 'hum-invierno-val',     suffix: '%',     multiplier: 1, decimals: 0 },
    { slider: 'viento-vel',       display: 'viento-vel-val',       suffix: ' m/s',  multiplier: 1, decimals: 1 },
    // Baterías
    { slider: 'bat-capacidad',    display: 'bat-capacidad-val',    suffix: ' kWh',  multiplier: 1, decimals: 0 },
    { slider: 'bat-dod',          display: 'bat-dod-val',          suffix: '%',     multiplier: 1, decimals: 0 },
    { slider: 'bat-eficiencia',   display: 'bat-eficiencia-val',   suffix: '%',     multiplier: 1, decimals: 0 },
    { slider: 'bat-vida-util',    display: 'bat-vida-util-val',    suffix: ' años', multiplier: 1, decimals: 0 },
    { slider: 'bat-costo-kwh',    display: 'bat-costo-kwh-val',    prefix: '$',     suffix: ' USD/kWh', multiplier: 1, decimals: 0 },
  ];
  sliders.forEach(({ slider, display, suffix, multiplier, decimals, prefix }) => {
    const el = $(slider), disp = $(display);
    if (!el || !disp) return;
    const update = () => {
      const v = parseFloat(el.value) * multiplier;
      if (slider === 'panel-price-usd') {
        const usdRate = parseFloat($('usd-mxn')?.value ?? 17.50);
        const mxnVal = v * usdRate;
        disp.innerHTML = `$${v.toFixed(0)} USD <span style="font-size:0.75rem;color:var(--text-muted);margin-left:0.5rem">≈ $${mxnVal.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} MXN</span>`;
      } else {
        disp.textContent = `${prefix || ''}${v.toFixed(decimals)}${suffix}`;
      }

      // Auto-calcular CAPEX en pantalla si cambiamos precios
      if (slider === 'panel-price-usd') {
        if (typeof runEconomics === 'function') runEconomics();
      }
    };
    el.addEventListener('input', update);
    update();
  });

  // Escuchar también cambios en inputs de texto para el CAPEX interactivo
  ['usd-mxn', 'input-npanels', 'bos-cost'].forEach(id => {
    $(id)?.addEventListener('input', () => {
      // Forzar recálculo
      const pSlider = $('panel-price-usd');
      if (pSlider) {
        const v = parseFloat(pSlider.value);
        const usdRate = parseFloat($('usd-mxn')?.value ?? 17.50);
        const mxnVal = v * usdRate;
        const disp = $('panel-price-usd-val');
        if (disp) disp.innerHTML = `$${v.toFixed(0)} USD <span style="font-size:0.75rem;color:var(--text-muted);margin-left:0.5rem">≈ $${mxnVal.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} MXN</span>`;
      }
      if (typeof runEconomics === 'function') runEconomics();
    });
  });

  // Toggle verano panel
  const toggleVerano = $('toggle-verano');
  const summerPanel  = $('summer-tariff-panel');
  if (toggleVerano && summerPanel) {
    const updateToggle = () => { summerPanel.style.display = toggleVerano.checked ? '' : 'none'; };
    toggleVerano.addEventListener('change', updateToggle);
    updateToggle();
  }

  // Toggle Climático
  const toggleThermal = $('toggle-thermal');
  const thermalPanel = $('thermal-panel');
  if (toggleThermal && thermalPanel) {
    const upd = () => { thermalPanel.style.display = toggleThermal.checked ? '' : 'none'; };
    toggleThermal.addEventListener('change', upd); upd();
  }

  // Toggle Apagones
  const toggleOutages = $('toggle-outages');
  const outagesPanel = $('outages-panel');
  if (toggleOutages && outagesPanel) {
    const upd = () => { outagesPanel.style.display = toggleOutages.checked ? '' : 'none'; };
    toggleOutages.addEventListener('change', upd); upd();
  }

  // Toggle Mermas
  const toggleMermas = $('toggle-mermas');
  const mermasPanel = $('mermas-panel');
  if (toggleMermas && mermasPanel) {
    const upd = () => { mermasPanel.style.display = toggleMermas.checked ? '' : 'none'; };
    toggleMermas.addEventListener('change', upd); upd();
  }

  // Toggle Baterías
  const toggleBaterias = $('toggle-baterias');
  const bateriasPanel = $('baterias-panel');
  if (toggleBaterias && bateriasPanel) {
    const upd = () => { bateriasPanel.style.display = toggleBaterias.checked ? '' : 'none'; };
    toggleBaterias.addEventListener('change', upd); upd();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CHART.JS — COLORES GLOBALES
// ─────────────────────────────────────────────────────────────────────────────
Chart.defaults.color = '#94a3b8';
Chart.defaults.borderColor = 'rgba(255,255,255,0.06)';
Chart.defaults.font.family = "'Inter', sans-serif";

function destroyChart(key) {
  if (state.charts[key]) { state.charts[key].destroy(); delete state.charts[key]; }
}

// ─────────────────────────────────────────────────────────────────────────────
// CLIENT-SIDE: GENERACIÓN DE DEMANDA INDUSTRIAL
// ─────────────────────────────────────────────────────────────────────────────
function generateDemandProfile(Pmax_kW, FC_planta, FP_potencia, n_shifts, plant_type, weekend_op_factor, summer_boost, noisePct = 0.04) {
  const rnd = mulberry32(42); // Semilla reproducible

  if (!PLANT_PROFILES[plant_type]) plant_type = 'manufactura_ligera';
  const profile_data = PLANT_PROFILES[plant_type];

  // Aplicar turnos de operación
  const applyShifts = (profile, shifts) => {
    const adj = [...profile];
    if (shifts === 1) {
      for (let h = 0; h < 24; h++) {
        if (!(h >= 6 && h < 14)) adj[h] = profile[h] * 0.20;
      }
    } else if (shifts === 2) {
      for (let h = 0; h < 24; h++) {
        if (!(h >= 6 && h < 22)) adj[h] = profile[h] * 0.25;
      }
    }
    return adj;
  };

  const profile_weekday = applyShifts(profile_data.weekday, n_shifts);
  const profile_weekend_base = applyShifts(profile_data.weekend, n_shifts);

  const N = 35040;
  const demand = new Float64Array(N);
  const days_in_month = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const summer_months = new Set([4, 5, 6, 7, 8]); // Mayo a Septiembre (0-indexed: May=4, Jun=5...)

  let idx = 0;
  for (let month_idx = 0; month_idx < 12; month_idx++) {
    const is_summer = summer_months.has(month_idx);
    const season_factor = is_summer ? summer_boost : 1.0;
    const n_days = days_in_month[month_idx];

    let days_before = 0;
    for (let m = 0; m < month_idx; m++) days_before += days_in_month[m];

    for (let day = 0; day < n_days; day++) {
      const day_of_year = days_before + day;
      const weekday = day_of_year % 7; // Día 0 = Lunes ficticio
      const is_weekend = weekday >= 5;

      let base_profile;
      if (is_weekend) {
        base_profile = profile_weekend_base.map(v => v * weekend_op_factor);
      } else {
        base_profile = profile_weekday;
      }

      for (let interval = 0; interval < 96; interval++) {
        const hour_of_day = Math.floor(interval / 4);
        const frac = (interval % 4) / 4.0;
        const next_h = (hour_of_day + 1) % 24;
        const base = (1 - frac) * base_profile[hour_of_day] + frac * base_profile[next_h];

        const p = Pmax_kW * base * FC_planta * season_factor;
        const noise = 1.0 + gaussianRandom(rnd) * noisePct;
        demand[idx] = Math.max(0.0, p * noise);
        idx++;
      }
    }
  }

  // Escalar demanda máxima real para que coincida exactamente con Pmax_kW * FP_potencia
  let max_val = 0;
  for (let i = 0; i < N; i++) {
    if (demand[i] > max_val) max_val = demand[i];
  }
  if (max_val > 0) {
    const factor = (Pmax_kW * FP_potencia) / max_val;
    for (let i = 0; i < N; i++) demand[i] *= factor;
  }

  // Agregaciones estadísticas
  let sum_demand = 0;
  let max_demand = 0;
  let min_demand = Infinity;
  for (let i = 0; i < N; i++) {
    sum_demand += demand[i];
    if (demand[i] > max_demand) max_demand = demand[i];
    if (demand[i] < min_demand) min_demand = demand[i];
  }

  const energy_kwh = sum_demand * 0.25;
  const p_media_kW = sum_demand / N;

  // Cálculos mensuales
  const monthly_avg = [];
  const monthly_max = [];
  const monthly_min = [];
  const monthly_kWh = [];
  idx = 0;
  for (let month_idx = 0; month_idx < 12; month_idx++) {
    const n_pts = days_in_month[month_idx] * 96;
    let m_sum = 0, m_max = 0, m_min = Infinity;
    for (let i = 0; i < n_pts; i++) {
      const val = demand[idx + i];
      m_sum += val;
      if (val > m_max) m_max = val;
      if (val < m_min) m_min = val;
    }
    monthly_avg.push(m_sum / n_pts);
    monthly_max.push(m_max);
    monthly_min.push(m_min);
    monthly_kWh.push(m_sum * 0.25);
    idx += n_pts;
  }

  // Perfil diario de 96 puntos (día laboral y fin de semana)
  const daily_weekday = new Float64Array(96);
  const daily_weekend = new Float64Array(96);
  let cnt_w = 0, cnt_we = 0;
  for (let d = 0; d < 365; d++) {
    const offset = d * 96;
    if (d % 7 < 5) {
      for (let i = 0; i < 96; i++) daily_weekday[i] += demand[offset + i];
      cnt_w++;
    } else {
      for (let i = 0; i < 96; i++) daily_weekend[i] += demand[offset + i];
      cnt_we++;
    }
  }
  for (let i = 0; i < 96; i++) {
    if (cnt_w > 0) daily_weekday[i] /= cnt_w;
    if (cnt_we > 0) daily_weekend[i] /= cnt_we;
  }

  const stats = {
    pmax_kW: Pmax_kW,
    p_media_kW: p_media_kW,
    p_min_kW: min_demand,
    p_max_real_kW: max_demand,
    energia_anual_kWh: energy_kwh,
    energia_anual_MWh: energy_kwh / 1000.0,
    factor_carga_real: max_demand > 0 ? p_media_kW / max_demand : 0,
    horas_punta_equiv: Pmax_kW > 0 ? energy_kwh / Pmax_kW : 0,
    FC_planta: FC_planta,
    FP_potencia: FP_potencia,
    n_shifts: n_shifts,
    plant_type: plant_type,
    plant_name: profile_data.name,
    weekend_op_factor: weekend_op_factor,
    summer_boost: summer_boost,
  };

  return {
    demand_kW: Array.from(demand),
    hours: Array.from({length: N}, (_, i) => i * 0.25),
    monthly_avg,
    monthly_max,
    monthly_min,
    monthly_kWh,
    daily_weekday: Array.from(daily_weekday),
    daily_weekend: Array.from(daily_weekend),
    stats
  };
}

async function runDemand() {
  const Pmax          = parseFloat($('pmax-input')?.value ?? 50);
  const FC            = parseFloat($('fc-planta').value);
  const FP            = parseFloat($('fp-potencia').value);
  const n_shifts      = parseInt($('n-shifts-select').value);
  const plant_type    = $('plant-type-select').value;
  const weekend_op    = parseFloat($('weekend-factor').value);
  const summer_boost  = parseFloat($('summer-boost').value);
  const noisePct      = parseFloat($('noise-pct')?.value ?? 0.04);

  showLoader('⚡ Generando perfil de demanda anual (35,040 puntos)...');

  // Pequeño retardo de UI para que pinte el loader antes del bloqueo por CPU
  setTimeout(() => {
    try {
      const data = generateDemandProfile(Pmax, FC, FP, n_shifts, plant_type, weekend_op, summer_boost, noisePct);

      state.demandData = data;
      renderDemandCharts(data);
      renderDemandStats(data.stats);
      const demRes = $('demand-results');
      demRes.classList.remove('hidden');
      // Activar animaciones fade-in dentro del contenedor de resultados
      setTimeout(() => {
        demRes.querySelectorAll('.fade-in').forEach(el => el.classList.add('visible'));
      }, 50);
      demRes.scrollIntoView({ behavior: 'smooth', block: 'start' });
      showAlert('demand-alert', 'success', `Perfil generado localmente — ${data.stats.plant_name} · ${n_shifts} turno(s) · Pmax ${Pmax} kW`);
    } catch (e) {
      showAlert('demand-alert', 'error', `Error: ${e.message}`);
      console.error(e);
    } finally {
      hideLoader();
    }
  }, 50);
}

function renderDemandCharts(data) {
  destroyChart('demandMonthly');
  state.charts.demandMonthly = new Chart($('chart-demand-monthly'), {
    type: 'bar',
    data: {
      labels: MONTHS,
      datasets: [
        {
          label: 'Promedio [kW]',
          data: data.monthly_avg,
          backgroundColor: 'rgba(249,115,22,0.75)',
          borderColor: '#f97316',
          borderWidth: 1,
          borderRadius: 4,
        },
        {
          label: 'Máximo [kW]',
          data: data.monthly_max,
          type: 'line',
          borderColor: '#fbbf24',
          backgroundColor: 'transparent',
          pointBackgroundColor: '#fbbf24',
          pointRadius: 3,
          borderWidth: 2,
          tension: 0.4,
        }
      ]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { labels: { boxWidth: 10, font: { size: 11 } } },
        tooltip: { callbacks: { label: c => ` ${formatNum(c.raw, 2)} kW` } }
      },
      scales: {
        y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { callback: v => `${v} kW` } }
      }
    }
  });

  destroyChart('demandDaily');
  state.charts.demandDaily = new Chart($('chart-demand-daily'), {
    type: 'line',
    data: {
      labels: HOURS_96,
      datasets: [{
        label: 'Demanda típica día laboral [kW]',
        data: data.daily_weekday,
        borderColor: '#f97316',
        backgroundColor: 'rgba(249,115,22,0.08)',
        fill: true,
        tension: 0.4,
        pointRadius: 0,
        borderWidth: 2,
      }]
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        x: {
          ticks: {
            maxTicksLimit: 12,
            callback: (v, i) => i % 8 === 0 ? HOURS_96[i] : ''
          },
          grid: { color: 'rgba(255,255,255,0.04)' }
        },
        y: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { callback: v => `${v.toFixed(0)} kW` } }
      }
    }
  });
}

function renderDemandStats(stats) {
  const el = $('demand-stats-box');
  if (!el) return;
  el.innerHTML = `
    <div class="stats-grid">
      <div class="stat-item">
        <div class="stat-icon-wrap stat-icon-orange">⚡</div>
        <div class="stat-info">
          <div class="stat-label">Energía anual consumida</div>
          <div class="stat-val">${formatNum(stats.energia_anual_MWh, 2)} <span>MWh/año</span></div>
        </div>
      </div>
      <div class="stat-item">
        <div class="stat-icon-wrap stat-icon-blue">📊</div>
        <div class="stat-info">
          <div class="stat-label">Demanda media</div>
          <div class="stat-val">${formatNum(stats.p_media_kW, 2)} <span>kW</span></div>
        </div>
      </div>
      <div class="stat-item">
        <div class="stat-icon-wrap stat-icon-gold">🏭</div>
        <div class="stat-info">
          <div class="stat-label">Factor de carga real</div>
          <div class="stat-val">${formatNum(stats.factor_carga_real * 100, 1)} <span>%</span></div>
        </div>
      </div>
      <div class="stat-item">
        <div class="stat-icon-wrap stat-icon-green">⏱️</div>
        <div class="stat-info">
          <div class="stat-label">Horas equiv. a plena carga</div>
          <div class="stat-val">${formatNum(stats.horas_punta_equiv, 0)} <span>hrs/año</span></div>
        </div>
      </div>
    </div>`;
  el.classList.add('visible');
}

// ─────────────────────────────────────────────────────────────────────────────
// CLIENT-SIDE: MOTOR SOLAR FOTOVOLTAICO (JENSEN) Y ESTOCÁSTICA
// ─────────────────────────────────────────────────────────────────────────────
function generateOutageMask(freq, durHours) {
  const mask = new Array(35040).fill(false);
  if (freq <= 0) return mask;
  const durIntervals = Math.max(1, Math.round(durHours * 4));

  for (let i = 0; i < freq; i++) {
    // Escoger un inicio aleatorio que no se desborde del año
    const startIdx = Math.floor(Math.random() * (35040 - durIntervals));
    for (let j = 0; j < durIntervals; j++) {
      mask[startIdx + j] = true;
    }
  }
  return mask;
}

function generateMermasMask(maintFreq, maintDur, dmgProb, dmgImpact, dmgDurDays, failProb, failDurDays) {
  const mask = new Array(35040).fill(1.0); // 1.0 = 100% capacidad

  // Mantenimiento
  if (maintFreq > 0) {
    const maintIntervals = Math.max(1, Math.round(maintDur * 4));
    for (let i = 0; i < maintFreq; i++) {
      const startIdx = Math.floor(Math.random() * (35040 - maintIntervals));
      // Durante mantenimiento se asume que el sistema está apagado (factor 0)
      for (let j = 0; j < maintIntervals; j++) { mask[startIdx + j] = 0.0; }
    }
  }

  // Daño parcial estocástico
  if (Math.random() < (dmgProb / 100.0)) {
    const dmgIntervals = dmgDurDays * 96;
    const startIdx = Math.floor(Math.random() * (35040 - dmgIntervals));
    const factor = Math.max(0, 1.0 - (dmgImpact / 100.0));
    for (let j = 0; j < dmgIntervals; j++) {
      mask[startIdx + j] *= factor;
    }
  }

  // Falla total crítica
  if (Math.random() < (failProb / 100.0)) {
    const failIntervals = failDurDays * 96;
    const startIdx = Math.floor(Math.random() * (35040 - failIntervals));
    for (let j = 0; j < failIntervals; j++) {
      mask[startIdx + j] = 0.0;
    }
  }

  return mask;
}

function runSolarEngine(lat, lon, alt, area_m2, n_panels, tilt, azimuth, p_nominal_w, rainDays = 0, rainLossPct = 0.40, soilingLossPct = 0.05, outages = null, outageInverter = 'grid-tied', mermas = null, thermalParams = null, chi = 0.40, noct = 45.0, eta_sys = 0.75, eta_stc = null, tamb_nasa_arr = null) {
  const eta_ref = (eta_stc !== null && !isNaN(eta_stc)) ? eta_stc : p_nominal_w / (1000.0 * area_m2);
  const chi_per_c = chi / 100.0;
  // Build a Set of day-of-year indices that are rainy (distributed in Jun-Sep: days 152-273)
  const rainyDaySet = new Set();
  if (rainDays > 0) {
    const rainStart = 151, rainEnd = 272; // 0-indexed day range Jun 1 – Sep 30
    const rainRange = rainEnd - rainStart + 1;
    const step = Math.max(1, Math.floor(rainRange / rainDays));
    for (let i = 0; i < rainDays && (rainStart + i * step) <= rainEnd; i++) {
      rainyDaySet.add(rainStart + i * step);
    }
  }
  const lat_r = lat * DEG;
  const lon_r = lon * DEG;
  const tilt_r = tilt * DEG;
  const azimuth_r = azimuth * DEG;

  const alt_factor = Math.exp(-alt / 8500.0);
  // Meridiano estándar de la zona horaria: redondear lon al múltiplo de 15° más cercano
  // Esto corrige el desfase horario solar: Monterrey lon=-100.31° → zona CST (UTC-6) → lon_ref=-90°
  const lon_ref_deg = Math.round(lon / 15.0) * 15.0;
  const lon_ref_rad = lon_ref_deg * DEG;

  const N = 35040;
  const Gtot_arr = new Float64Array(N);
  const Gb_h_arr = new Float64Array(N);
  const Gd_h_arr = new Float64Array(N);
  const P_kw_arr = new Float64Array(N);

  const days_in_month = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  const T_STC      = 25.0;
  const T_NOCT_AMB = 20.0;
  const G_NOCT     = 800.0;

  let idx = 0;
  for (let month_idx = 0; month_idx < 12; month_idx++) {
    const n_days = days_in_month[month_idx];
    for (let day = 1; day <= n_days; day++) {
      const n = _dayOfYear(month_idx + 1, day);
      for (let interval = 0; interval < 96; interval++) {
        const hour_std = interval * 0.25 + 0.125;

        // Posición solar real (usando meridiano de referencia de zona horaria para corregir hora solar)
        const pos = _solarPosition(lat_r, lon_r, n, hour_std, lon_ref_rad);

        // Corrección de masa de aire por altitud
        let alpha_eff = pos.alpha;
        if (pos.alpha > 5.0 * DEG) {
          alpha_eff = Math.asin(Math.max(-1.0, Math.min(1.0, Math.sin(pos.alpha) / alt_factor)));
        }

        // Irradiancias horizontales (Jensen)
        const horiz = _irradianceHorizontal(alpha_eff, n);

        // Irradiancia en Plano de Arreglo (POA transposición)
        const Gtot = _poaIrradiance(horiz.Gb_h, horiz.Gd_h, alpha_eff, pos.azimuth, tilt_r, azimuth_r);

        // Generación FV [kW] considerando pérdidas del sistema de 15% (Performance Ratio = 0.85)
        // Calcular día del año (0-indexed) para aplicar factor de lluvia
        let dayOfYear0 = 0;
        for (let mm = 0; mm < month_idx; mm++) dayOfYear0 += days_in_month[mm];
        dayOfYear0 += (day - 1);
        const rainFactor = rainyDaySet.has(dayOfYear0) ? (1.0 - rainLossPct) : 1.0;
        
        // ── Modelo Térmico Unificado ──
        let T_amb = 25.0;
        let RH = 0.0;
        let V_wind = 0.0;

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

        let T_cell = T_amb + (noct - 20.0) * (Gtot / 800.0);
        if (thermalParams && Gtot > 0) {
          // Faiman extendido (corrige T_cell por humedad y viento)
          T_cell = T_amb + (Gtot / 800.0) * (noct - 20.0) * (1.0 - 0.003 * RH) * Math.max(0.1, 1.0 - 0.1 * V_wind);
        }

        // Aplicamos una sola corrección de eficiencia basada en T_cell
        const eta_T = Math.max(0, eta_ref * (1.0 - chi_per_c * (T_cell - 25.0)));

        let P_kw = (eta_T * eta_sys * area_m2 * Gtot * n_panels * rainFactor * (1.0 - soilingLossPct)) / 1000.0;

        if (mermas && mermas.length > idx) {
          P_kw *= mermas[idx];
        }

        if (outages && outages[idx]) {
          if (outageInverter === 'grid-tied') {
            P_kw = 0.0;
          }
        }

        Gtot_arr[idx] = Gtot;
        Gb_h_arr[idx] = horiz.Gb_h;
        Gd_h_arr[idx] = horiz.Gd_h;
        P_kw_arr[idx] = P_kw;
        idx++;
      }
    }
  }

  // Agregaciones mensuales
  const monthly_gtot_avg = [];
  const monthly_gtot_max = [];
  const monthly_gen_kWh = [];
  idx = 0;
  for (let month_idx = 0; month_idx < 12; month_idx++) {
    const n_pts = days_in_month[month_idx] * 96;
    let sum_g = 0, max_g = 0, sum_p = 0;
    for (let i = 0; i < n_pts; i++) {
      const g = Gtot_arr[idx + i];
      const p = P_kw_arr[idx + i];
      sum_g += g;
      if (g > max_g) max_g = g;
      sum_p += p;
    }
    monthly_gtot_avg.push(sum_g / n_pts);
    monthly_gtot_max.push(max_g);
    monthly_gen_kWh.push(sum_p * 0.25);
    idx += n_pts;
  }

  // Perfiles horarios promedio en Verano (Mayo a Agosto)
  let summer_start_day = 0;
  for (let m = 0; m < 4; m++) summer_start_day += days_in_month[m];
  let summer_end_day = summer_start_day;
  for (let m = 4; m < 8; m++) summer_end_day += days_in_month[m];

  const summer_start_idx = summer_start_day * 96;
  const n_summer_days = summer_end_day - summer_start_day;

  const daily_gtot_summer = new Float64Array(96);
  const daily_p_summer = new Float64Array(96);
  for (let d = 0; d < n_summer_days; d++) {
    const offset = summer_start_idx + d * 96;
    for (let i = 0; i < 96; i++) {
      daily_gtot_summer[i] += Gtot_arr[offset + i];
      daily_p_summer[i] += P_kw_arr[offset + i];
    }
  }
  for (let i = 0; i < 96; i++) {
    daily_gtot_summer[i] /= n_summer_days;
    daily_p_summer[i] /= n_summer_days;
  }

  // Estadísticas globales
  let sum_P = 0, max_P = 0, active_hours = 0;
  let sum_GbGd = 0, sum_Gtot = 0, max_gtot = 0;
  for (let i = 0; i < N; i++) {
    sum_P += P_kw_arr[i];
    if (P_kw_arr[i] > max_P) max_P = P_kw_arr[i];
    if (P_kw_arr[i] > 0.001) active_hours += 0.25;

    const horiz_total = Gb_h_arr[i] + Gd_h_arr[i];
    sum_GbGd += horiz_total;
    sum_Gtot += Gtot_arr[i];
    if (Gtot_arr[i] > max_gtot) max_gtot = Gtot_arr[i];
  }

  const energia_anual_kwh = sum_P * 0.25;
  const p_nominal_total_kw = (p_nominal_w * n_panels) / 1000.0;
  const fc = p_nominal_total_kw > 0 ? energia_anual_kwh / (p_nominal_total_kw * 8760) : 0;
  const hpse = p_nominal_total_kw > 0 ? energia_anual_kwh / p_nominal_total_kw : 0;
  const irrad_horizontal_kwh_m2 = (sum_GbGd * 0.25) / 1000.0;
  const irrad_poa_kwh_m2 = (sum_Gtot * 0.25) / 1000.0;

  let sum_g_pos = 0, cnt_g_pos = 0;
  for (let i = 0; i < N; i++) {
    if (Gtot_arr[i] > 0) {
      sum_g_pos += Gtot_arr[i];
      cnt_g_pos++;
    }
  }
  const gtot_media_W_m2 = cnt_g_pos > 0 ? sum_g_pos / cnt_g_pos : 0;

  const stats = {
    energia_anual_kWh: energia_anual_kwh,
    energia_anual_MWh: energia_anual_kwh / 1000.0,
    p_max_kW: max_P,
    p_nominal_total_kW: p_nominal_total_kw,
    factor_capacity_pct: fc * 100, // compatibilidad
    factor_capacidad_pct: fc * 100,
    horas_pico_sol_equiv: hpse,
    irrad_horizontal_kWh_m2: irrad_horizontal_kwh_m2,
    irrad_poa_kWh_m2: irrad_poa_kwh_m2,
    gtot_max_W_m2: max_gtot,
    gtot_media_W_m2: gtot_media_W_m2,
    n_horas_generacion: active_hours,
    n_paneles: n_panels,
    potencia_nominal_W_panel: p_nominal_w,
    eta_ref          : eta_ref,
    eta_sys          : eta_sys,
    noct             : noct,
    chi_pct_por_c    : chi,
    area_m2: area_m2,
    tilt: tilt,
    azimuth: azimuth,
    lat: lat,
    lon: lon,
    alt: alt,
    rain_days: rainDays,
    rain_loss: rainLossPct,
    soiling_loss: soilingLossPct,
  };

  return {
    Gtot_arr: Array.from(Gtot_arr),
    P_kw_arr: Array.from(P_kw_arr),
    outages,
    hours: Array.from({length: N}, (_, i) => i * 0.25),
    monthly_gtot_avg,
    monthly_gtot_max,
    monthly_gen_kWh,
    daily_p_summer: Array.from(daily_p_summer),
    mermas,
    stats
  };
}

// ── Selector de Modo de Temperatura Ambiente ──
let currentTambMode = 'manual';

window.setTambMode = function(mode) {
  currentTambMode = mode;
  document.querySelectorAll('#tamb-mode-buttons .eta-btn').forEach(btn => btn.classList.remove('active'));
  document.getElementById(`tamb-mode-${mode}`).classList.add('active');
  
  if (mode === 'nasa') {
    document.getElementById('tamb-nasa-panel').style.display = 'block';
    document.getElementById('tamb-manual-panel').style.display = 'none';
  } else {
    document.getElementById('tamb-nasa-panel').style.display = 'none';
    document.getElementById('tamb-manual-panel').style.display = 'block';
  }
};

// ── Cliente NASA POWER API (Temperatura ambiente típica) ──
async function fetchTambienteNASA(lat, lon) {
  const url = `https://power.larc.nasa.gov/api/temporal/climatology/point?parameters=T2M,RH2M&community=RE&longitude=${lon}&latitude=${lat}&format=JSON`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`NASA POWER HTTP ${res.status}`);
  const data = await res.json();
  const t2m  = data.properties.parameter.T2M;
  if (!t2m) throw new Error('NASA POWER: T2M ausente en la respuesta');
  const rh2m = data.properties.parameter.RH2M ?? null;
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

async function runSolar() {
  const etaStcVal = parseFloat($('input-etastc')?.value);
  const payload = {
    lat:          parseFloat($('input-lat').value),
    lon:          parseFloat($('input-lon').value),
    alt:          parseFloat($('input-alt').value),
    chi:          parseFloat($('chi-panel').value),
    NOCT:         parseFloat($('input-NOCT').value),
    area_m2:      parseFloat($('input-area').value),
    n_panels:     parseInt($('input-npanels').value),
    eta_sys:      parseFloat($('input-etasys').value),
    eta_stc:      isNaN(etaStcVal) ? null : etaStcVal,
    tilt:         parseFloat($('tilt-angle').value),
    azimuth:      parseFloat($('input-azimuth').value),
    p_nominal_w:  parseFloat($('input-pnominal').value),
    rain_days:    parseFloat($('rain-days')?.value ?? 0),
    rain_loss:    parseFloat($('rain-loss-pct')?.value ?? 0.40),
    soiling_loss: parseFloat($('soiling-loss-pct')?.value ?? 0.05),
  };

  if (isNaN(payload.lat) || isNaN(payload.lon)) {
    showAlert('solar-alert', 'error', 'Por favor ingresa latitud y longitud válidas.');
    return;
  }

  showLoader('☀️ Ejecutando Motor de Jensen en el navegador (35,040 pasos)...');

  // Si usa NASA, lo traemos antes de bloquear el hilo
  let tamb_nasa_arr = null;
  const useThermal = $('toggle-thermal')?.checked;
  if (useThermal && currentTambMode === 'nasa') {
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
  }

  setTimeout(() => {
    try {
      const useOutages = $('toggle-outages')?.checked;
      const outagesMask = useOutages ? generateOutageMask(
        parseFloat($('outage-freq').value),
        parseFloat($('outage-dur').value)
      ) : null;
      const outageInverter = $('outage-inverter')?.value ?? 'grid-tied';

      const useMermas = $('toggle-mermas')?.checked;
      const mermasMask = useMermas ? generateMermasMask(
        parseFloat($('merma-maint-freq').value),
        parseFloat($('merma-maint-dur').value),
        parseFloat($('merma-dmg-prob').value),
        parseFloat($('merma-dmg-impact').value),
        parseFloat($('merma-dmg-dur').value),
        parseFloat($('merma-fail-prob').value),
        parseFloat($('merma-fail-dur').value)
      ) : null;

      // Parámetros térmicos
      const thermalParams = useThermal ? {
        temp_verano:  parseFloat($('temp-amb-verano').value),
        temp_invierno:parseFloat($('temp-amb-invierno').value),
        hum_verano:   parseFloat($('hum-verano').value),
        hum_invierno: parseFloat($('hum-invierno').value),
        viento:       parseFloat($('viento-vel').value),
        noct:         parseFloat($('input-NOCT').value),
      } : null;

      const data = runSolarEngine(
        payload.lat, payload.lon, payload.alt,
        payload.area_m2, payload.n_panels,
        payload.tilt, payload.azimuth, payload.p_nominal_w,
        payload.rain_days, payload.rain_loss, payload.soiling_loss,
        outagesMask, outageInverter, mermasMask, thermalParams,
        payload.chi, payload.NOCT, payload.eta_sys, payload.eta_stc, tamb_nasa_arr
      );

      // Calcular balance si hay demanda guardada
      let balance = null;
      if (state.demandData) {
        const dem_arr = state.demandData.demand_kW;
        const gen_arr = data.P_kw_arr;

        let exceso_sum = 0, deficit_sum = 0, e_dem = 0, e_gen = 0;
        let ens_sum = 0; // Energía No Suministrada por apagones
        const days_in_month = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

        const monthly_balance = [];
        const monthly_cobertura = [];

        let idx_m = 0;
        for (let m = 0; m < 12; m++) {
          const n_pts = days_in_month[m] * 96;
          let m_eg = 0, m_ed = 0;
          for (let i = 0; i < n_pts; i++) {
            const gen = gen_arr[idx_m + i];
            const dem = dem_arr[idx_m + i];

            m_eg += gen;

            if (data.outages && data.outages[idx_m + i]) {
              const ens = Math.max(0, dem - gen);
              ens_sum += ens;
              // Durante apagón no se inyecta exceso a red ni se compra de CFE
              // El déficit a CFE en ese instante es 0, y el exceso a CFE es 0.
            } else {
              m_ed += dem;
              const diff = gen - dem;
              if (diff > 0) exceso_sum += diff;
              else deficit_sum += Math.abs(diff);
            }
          }
          const eg_kwh = m_eg * 0.25;
          const ed_kwh = m_ed * 0.25;

          monthly_balance.push(Number((eg_kwh - ed_kwh).toFixed(2)));
          monthly_cobertura.push(Number((ed_kwh > 0 ? Math.min(eg_kwh / ed_kwh * 100, 100) : 0).toFixed(2)));

          e_gen += m_eg;
          e_dem += m_ed; // e_dem here is total demand served (from grid + solar, excluding ENS)
          idx_m += n_pts;
        }

        e_dem *= 0.25;
        e_gen *= 0.25;
        const cob = e_dem > 0 ? Math.min(e_gen / e_dem * 100, 100) : 0;

        balance = {
          energia_demanda_kWh: Number(e_dem.toFixed(2)),
          energia_generada_kWh: Number(e_gen.toFixed(2)),
          exceso_kWh: Number((exceso_sum * 0.25).toFixed(2)),
          deficit_kWh: Number((deficit_sum * 0.25).toFixed(2)),
          ens_kWh: Number((ens_sum * 0.25).toFixed(2)),
          cobertura_pct: Number(cob.toFixed(2)),
          monthly_balance,
          monthly_cobertura
        };

        // ── Simulación de Baterías (BESS) ──────────────────────────────────
        const useBat = $('toggle-baterias')?.checked;
        const batCapKwh = parseFloat($('bat-capacidad')?.value ?? 200);
        const batDod    = parseFloat($('bat-dod')?.value ?? 80) / 100.0;
        const batEff    = parseFloat($('bat-eficiencia')?.value ?? 95) / 100.0;
        const bat_usable = batCapKwh * batDod;
        let soc = bat_usable; // SOC inicial: llena
        let bat_energy_from_bat = 0; // kWh provistos por bateria
        let bat_ens_con_bat = 0;     // ENS que sobrevive con batería
        let bat_max_deficit = 0;     // Peor déficit continuo para sizing
        let cur_deficit_run = 0;     // Acumulador de déficit en apagón activo
        const soc_arr = useBat ? new Float32Array(35040) : null;

        if (useBat && data.outages) {
          for (let i = 0; i < 35040; i++) {
            const gen = data.P_kw_arr[i];
            const dem = dem_arr[i] || 0;
            const in_outage = data.outages[i];

            if (!in_outage) {
              // En operación normal: cargar batería con excedente solar
              const exceso = Math.max(0, gen - dem);
              const carga = exceso * batEff * 0.25; // kWh
              soc = Math.min(bat_usable, soc + carga);
              cur_deficit_run = 0;
            } else {
              // En apagón: batería descarga para suplir déficit
              const deficit = Math.max(0, dem - gen) * 0.25; // kWh en este intervalo
              cur_deficit_run += deficit;
              bat_max_deficit = Math.max(bat_max_deficit, cur_deficit_run);

              const provisto = Math.min(soc, deficit);
              soc -= provisto;
              bat_energy_from_bat += provisto;
              const restante = deficit - provisto;
              bat_ens_con_bat += restante;
            }
            if (soc_arr) soc_arr[i] = soc;
          }
        } else if (!useBat && data.outages) {
          // Sin batería: calcular sizing mínimo recomendado
          for (let i = 0; i < 35040; i++) {
            const gen = data.P_kw_arr[i];
            const dem = dem_arr[i] || 0;
            if (data.outages[i]) {
              cur_deficit_run += Math.max(0, dem - gen) * 0.25;
              bat_max_deficit = Math.max(bat_max_deficit, cur_deficit_run);
            } else {
              cur_deficit_run = 0;
            }
          }
        }

        if (useBat) {
          balance.bat_energy_kwh = Number(bat_energy_from_bat.toFixed(2));
          balance.bat_ens_residual_kwh = Number(bat_ens_con_bat.toFixed(2));
          data.soc_arr = soc_arr;
        }
        balance.bat_sizing_min_kwh = Number(bat_max_deficit.toFixed(1));
        balance.bat_sizing_dod = batDod;
      }

      data.balance = balance;
      state.solarData = data;

      // Mostrar estimación de pérdidas térmicas
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

      // Mostrar calculadora de sizing de baterías
      if (balance && balance.bat_sizing_min_kwh !== undefined) {
        renderBatterySizing(balance);
      }

      renderSolarCharts(data);
      renderSolarKPIs(data.stats, data.balance);
      renderSolarStats(data.stats, data.balance);

      // Análisis económico (CFE GDMTO + ROI/VPN/TIR + gráfica inversión)
      if (typeof runEconomics === 'function') runEconomics();

      const solRes = $('solar-results');
      solRes.classList.remove('hidden');
      // Activar animaciones fade-in dentro del contenedor de resultados
      setTimeout(() => {
        solRes.querySelectorAll('.fade-in').forEach(el => el.classList.add('visible'));
      }, 50);
      solRes.scrollIntoView({ behavior: 'smooth', block: 'start' });
      showAlert('solar-alert', 'success', 'Cálculo completado — Motor Jensen · Análisis CFE GDMTO · ROI calculado.');
    } catch (e) {
      showAlert('solar-alert', 'error', `Error en el cálculo: ${e.message}`);
      console.error(e);
    } finally {
      hideLoader();
    }
  }, 50);
}

// ─────────────────────────────────────────────────────────────────────────────
// CALCULADORA DE SIZING DE BATERÍAS
// ─────────────────────────────────────────────────────────────────────────────
function renderBatterySizing(balance) {
  const box = $('bat-sizing-box');
  const content = $('bat-sizing-content');
  if (!box || !content) return;

  const minKwh = balance.bat_sizing_min_kwh ?? 0;
  const usd_mxn = parseFloat($('usd-mxn')?.value ?? 17.50);
  const cost_usd_kwh = parseFloat($('bat-costo-kwh')?.value ?? 350);
  const dod = parseFloat($('bat-dod')?.value ?? 80) / 100;
  // Capacidad nominal (kWh) = usable / DoD
  const cap_nominal = dod > 0 ? minKwh / dod : minKwh;
  const costo_usd = cap_nominal * cost_usd_kwh;
  const costo_mxn = costo_usd * usd_mxn;

  const useBat = $('toggle-baterias')?.checked;
  const ens_residual = balance.bat_ens_residual_kwh;
  const bat_provided  = balance.bat_energy_kwh;

  const fmt = (n, d=0) => n == null ? '—' : Number(n).toFixed(d).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  const cards = [
    { label: 'Capacidad Útil Mínima', val: `${fmt(minKwh, 1)} kWh`, color: '#10b981', desc: 'Para mitigar el peor apagón simulado' },
    { label: 'Capacidad Nominal Recomendada', val: `${fmt(cap_nominal, 0)} kWh`, color: '#10b981', desc: `Considerando DoD = ${(dod*100).toFixed(0)}%` },
    { label: 'Costo Estimado del Banco', val: `$${fmt(costo_mxn, 0)} MXN`, color: '#fbbf24', desc: `≈ $${fmt(costo_usd, 0)} USD` },
  ];

  if (useBat && bat_provided != null) {
    cards.push({ label: 'Energía Provista por Batería', val: `${fmt(bat_provided, 1)} kWh/año`, color: '#3b82f6', desc: 'Durante apagones' });
    cards.push({ label: 'ENS Residual (con Batería)', val: `${fmt(ens_residual, 1)} kWh/año`, color: ens_residual > 0 ? '#ef4444' : '#10b981', desc: ens_residual > 0 ? 'Batería insuficiente' : '✅ Sin déficit' });
  }

  content.innerHTML = cards.map(c => `
    <div style="background:rgba(16,185,129,0.05);border:1px solid rgba(16,185,129,0.15);border-radius:10px;padding:1rem;text-align:center;">
      <div style="font-size:0.72rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:.4rem;">${c.label}</div>
      <div style="font-size:1.05rem;font-weight:700;color:${c.color};margin-bottom:.3rem;">${c.val}</div>
      <div style="font-size:0.72rem;color:var(--text-muted);">${c.desc}</div>
    </div>`).join('');

  box.style.display = '';
}


function renderSolarKPIs(stats, balance) {
const kpis = [
{ val: formatNum(stats.energia_anual_MWh, 2),        unit: 'MWh/año',  label: 'Energía generada',           color: '#f97316' },
{ val: formatNum(stats.factor_capacidad_pct, 1),     unit: '%',        label: 'Factor de capacidad',         color: '#fbbf24' },
{ val: formatNum(stats.p_max_kW, 2),                 unit: 'kW',       label: 'Pico de generación',          color: '#3b82f6' },
{ val: formatNum(stats.irrad_poa_kWh_m2, 0),         unit: 'kWh/m²',  label: 'Irradiación POA anual',       color: '#f97316' },
{ val: formatNum(stats.horas_pico_sol_equiv, 0),     unit: 'hrs',      label: 'Horas pico solar equiv.',     color: '#10b981' },
{ val: balance ? formatNum(balance.cobertura_pct, 1) : '—', unit: '%', label: 'Cobertura de demanda',        color: '#10b981' },
];

const container = $('kpi-container');
if (!container) return;
container.innerHTML = kpis.map(k => `
<div class="kpi-card" style="--kpi-color:${k.color}">
  <div class="kpi-value">${k.val}<span class="kpi-unit"> ${k.unit}</span></div>
  <div class="kpi-label">${k.label}</div>
</div>`).join('');
}


function renderSolarCharts(data) {
  const { stats, balance } = data;

  destroyChart('gtotMonthly');
  state.charts.gtotMonthly = new Chart($('chart-gtot-monthly'), {
    type: 'bar',
    data: {
      labels: MONTHS,
      datasets: [{
        label: 'Irradiancia POA media [W/m²]',
        data: data.monthly_gtot_avg,
        backgroundColor: ctx => {
          const g = ctx.chart.ctx.createLinearGradient(0, 0, 0, 300);
          g.addColorStop(0, 'rgba(251,191,36,0.9)');
          g.addColorStop(1, 'rgba(249,115,22,0.5)');
          return g;
        },
        borderRadius: 5,
        borderSkipped: false,
      }]
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ` ${formatNum(c.raw, 1)} W/m²` } } },
      scales: {
        y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { callback: v => `${v} W/m²` } }
      }
    }
  });

  destroyChart('genMonthly');
  state.charts.genMonthly = new Chart($('chart-gen-monthly'), {
    type: 'bar',
    data: {
      labels: MONTHS,
      datasets: [{
        label: 'Generación [kWh/mes]',
        data: data.monthly_gen_kWh,
        backgroundColor: 'rgba(16,185,129,0.7)',
        borderColor: '#10b981',
        borderWidth: 1,
        borderRadius: 4,
      }]
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ` ${formatNum(c.raw, 0)} kWh` } } },
      scales: {
        y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { callback: v => `${(v/1000).toFixed(1)} MWh` } }
      }
    }
  });

  // Re-dibujar comparación diaria
  destroyChart('dailyComp');
  const datasets = [{
    label: 'Generación FV (verano promedio) [kW]',
    data: data.daily_p_summer,
    borderColor: '#fbbf24',
    backgroundColor: 'rgba(251,191,36,0.1)',
    fill: true,
    tension: 0.4,
    pointRadius: 0,
    borderWidth: 2,
  }];
  if (state.demandData) {
    datasets.push({
      label: 'Demanda industrial [kW]',
      data: state.demandData.daily_weekday,
      borderColor: '#f97316',
      backgroundColor: 'rgba(249,115,22,0.05)',
      fill: true,
      tension: 0.4,
      pointRadius: 0,
      borderWidth: 2,
      borderDash: [5, 3],
    });
  }
  state.charts.dailyComp = new Chart($('chart-daily-comp'), {
    type: 'line',
    data: {
      labels: HOURS_96,
      datasets
    },
    options: {
      responsive: true,
      interaction: { intersect: false, mode: 'index' },
      plugins: { legend: { labels: { boxWidth: 10, font: { size: 11 } } } },
      scales: {
        x: { ticks: { maxTicksLimit: 12, callback: (v, i) => i % 8 === 0 ? HOURS_96[i] : '' }, grid: { color: 'rgba(255,255,255,0.04)' } },
        y: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { callback: v => `${v.toFixed(0)} kW` } }
      }
    }
  });

  // Balance mensual
  if (balance) {
    destroyChart('balanceMonthly');
    state.charts.balanceMonthly = new Chart($('chart-balance'), {
      type: 'bar',
      data: {
        labels: MONTHS,
        datasets: [
          {
            label: 'Generación [kWh]',
            data: data.monthly_gen_kWh,
            backgroundColor: 'rgba(16,185,129,0.6)',
            borderRadius: 3,
            stack: 'stack0',
          },
          {
            label: 'Demanda [kWh]',
            data: state.demandData.monthly_kWh,
            backgroundColor: 'rgba(249,115,22,0.5)',
            borderRadius: 3,
            stack: 'stack1',
          }
        ]
      },
      options: {
        responsive: true,
        plugins: {
          legend: { labels: { boxWidth: 10, font: { size: 11 } } },
          tooltip: { callbacks: { label: c => ` ${formatNum(c.raw/1000, 2)} MWh` } }
        },
        scales: {
          y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { callback: v => `${(v/1000).toFixed(1)} MWh` } }
        }
      }
    });
  }
}

function renderSolarStats(stats, balance) {
  const el = $('solar-stats-box');
  if (!el) return;

  const covPct = balance ? balance.cobertura_pct : null;
  const coverageBar = covPct !== null
    ? `<div class="balance-bar-wrap">
        <div class="balance-bar-label">
          <span>🌞 Cobertura de Demanda por Generación Solar</span>
          <strong style="color:var(--accent-green)">${formatNum(covPct, 1)}%</strong>
        </div>
        <div class="balance-bar-track">
          <div class="balance-bar-fill" style="width:${Math.min(covPct,100)}%"></div>
        </div>
      </div>` : '';

  el.innerHTML = `
    ${coverageBar}
    <div class="stats-grid">
      <div class="stat-item">
        <div class="stat-icon-wrap stat-icon-gold">☀️</div>
        <div class="stat-info">
          <div class="stat-label">Irradiación horizontal anual</div>
          <div class="stat-val">${formatNum(stats.irrad_horizontal_kWh_m2, 0)} <span>kWh/m²</span></div>
        </div>
      </div>
      <div class="stat-item">
        <div class="stat-icon-wrap stat-icon-orange">📐</div>
        <div class="stat-info">
          <div class="stat-label">Irradiación POA anual</div>
          <div class="stat-val">${formatNum(stats.irrad_poa_kWh_m2, 0)} <span>kWh/m²</span></div>
        </div>
      </div>
      <div class="stat-item">
        <div class="stat-icon-wrap stat-icon-orange">⚡</div>
        <div class="stat-info">
          <div class="stat-label">Energía generada</div>
          <div class="stat-val">${formatNum(stats.energia_anual_kWh, 0)} <span>kWh/año</span></div>
        </div>
      </div>
      <div class="stat-item">
        <div class="stat-icon-wrap stat-icon-blue">🔋</div>
        <div class="stat-info">
          <div class="stat-label">Potencia pico del sistema</div>
          <div class="stat-val">${formatNum(stats.p_nominal_total_kW, 2)} <span>kWp</span></div>
        </div>
      </div>
      <div class="stat-item">
        <div class="stat-icon-wrap stat-icon-green">📈</div>
        <div class="stat-info">
          <div class="stat-label">Factor de capacidad</div>
          <div class="stat-val">${formatNum(stats.factor_capacidad_pct, 2)} <span>%</span></div>
        </div>
      </div>
      <div class="stat-item">
        <div class="stat-icon-wrap stat-icon-gold">🕐</div>
        <div class="stat-info">
          <div class="stat-label">Horas de generación/año</div>
          <div class="stat-val">${formatNum(stats.n_horas_generacion, 0)} <span>hrs</span></div>
        </div>
      </div>
      ${balance ? `
      <div class="stat-item">
        <div class="stat-icon-wrap stat-icon-green">✅</div>
        <div class="stat-info">
          <div class="stat-label">Energía cubierta por solar</div>
          <div class="stat-val">${formatNum(Math.min(balance.energia_generada_kWh, balance.energia_demanda_kWh) / 1000, 2)} <span>MWh/año</span></div>
        </div>
      </div>
      <div class="stat-item">
        <div class="stat-icon-wrap stat-icon-blue">🔌</div>
        <div class="stat-info">
          <div class="stat-label">Déficit de red eléctrica</div>
          <div class="stat-val">${formatNum(balance.deficit_kWh / 1000, 2)} <span>MWh/año</span></div>
        </div>
      </div>` : ''}
    </div>`;
  el.classList.add('visible');
}

// ─────────────────────────────────────────────────────────────────────────────
// CLIENT-SIDE EXCEL EXPORT CON EXCELJS (TEMA EN NARANJA PASTEL)
// ─────────────────────────────────────────────────────────────────────────────
function downloadExcel() {
  if (!state.solarData) {
    alert('Ejecuta primero el Motor Solar para generar los datos.');
    return;
  }

  showLoader('📊 Generando reporte Excel en Naranja Pastel (35,040 filas)...');

  setTimeout(() => {
    try {
      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'Jensen Solar Engine';
      workbook.created = new Date();

      const s = state.solarData.stats;
      const b = state.solarData.balance;

      // Paleta de Colores Naranja Pastel (Pastel Orange Theme)
      const colors = {
        titleText: '7C2D12',     // Marrón/Naranja óxido para títulos (alta legibilidad)
        catFill: 'FED7AA',       // Naranja pastel medio (Orange 200) para secciones principales
        catText: '7C2D12',
        hdrFill: 'FFEDD5',       // Naranja pastel suave (Orange 100) para subencabezados de columnas
        hdrText: '9A3412',       // Naranja óxido medio para texto de columnas
        evenRow: 'FFFBF7',       // Crema/Naranja extremadamente tenue para filas pares
        oddRow: 'FFFFFF',        // Blanco puro para filas impares
        borderThin: 'FED7AA',    // Borde naranja pastel fino
        borderThick: 'F97316'    // Borde naranja principal
      };

      const styleTitle = (cell, text, size = 14) => {
        cell.value = text;
        cell.font = { name: 'Calibri', size, bold: true, color: { argb: colors.titleText } };
        cell.alignment = { vertical: 'middle' };
      };

      const styleCategoryHeader = (row, startCol, endCol, text) => {
        row.getCell(startCol).value = text;
        for (let i = startCol; i <= endCol; i++) {
          const cell = row.getCell(i);
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colors.catFill } };
          cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: colors.catText } };
          cell.alignment = { horizontal: 'left', vertical: 'middle' };
          cell.border = {
            top: { style: 'thin', color: { argb: colors.borderThin } },
            bottom: { style: 'thin', color: { argb: colors.borderThin } }
          };
        }
      };

      const styleTableHeader = (row, columns) => {
        columns.forEach((val, idx) => {
          const cell = row.getCell(idx + 1);
          cell.value = val;
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colors.hdrFill } };
          cell.font = { name: 'Calibri', size: 9, bold: true, color: { argb: colors.hdrText } };
          cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
          cell.border = {
            top: { style: 'thin', color: { argb: colors.borderThin } },
            bottom: { style: 'medium', color: { argb: colors.borderThick } },
            left: { style: 'thin', color: { argb: colors.borderThin } },
            right: { style: 'thin', color: { argb: colors.borderThin } }
          };
        });
      };

      const addDataRow = (sheet, vals, isEven, aligns = [], numFmts = []) => {
        const row = sheet.addRow(vals);
        row.height = 18;
        vals.forEach((_, idx) => {
          const cell = row.getCell(idx + 1);
          const align = aligns[idx] || 'center';
          const numFmt = numFmts[idx] || null;

          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: isEven ? colors.evenRow : colors.oddRow } };
          cell.font = { name: 'Calibri', size: 9, color: { argb: '1F2937' } };
          cell.alignment = { horizontal: align, vertical: 'middle' };
          cell.border = {
            top: { style: 'thin', color: { argb: colors.borderThin } },
            bottom: { style: 'thin', color: { argb: colors.borderThin } },
            left: { style: 'thin', color: { argb: colors.borderThin } },
            right: { style: 'thin', color: { argb: colors.borderThin } }
          };
          if (numFmt) {
            cell.numFmt = numFmt;
          }
        });
        return row;
      };

      const autofitColumns = (sheet) => {
        sheet.columns.forEach((column) => {
          let maxLength = 0;
          column.eachCell({ includeEmpty: true }, (cell) => {
            const val = cell.value;
            let len = 0;
            if (val !== null && val !== undefined) {
              if (typeof val === 'object' && val.richText) {
                len = val.richText.reduce((acc, curr) => acc + curr.text.length, 0);
              } else {
                len = val.toString().length;
              }
            }
            if (len > maxLength) maxLength = len;
          });
          column.width = Math.max(maxLength + 4, 12);
        });
      };

      // ══════════════════════════════════════════════════════════════════════════
      // HOJA 1: Parámetros
      // ══════════════════════════════════════════════════════════════════════════
      const ws1 = workbook.addWorksheet('1. Parámetros');
      ws1.views = [{ showGridLines: true }];

      const t1 = ws1.addRow([]);
      t1.height = 30;
      styleTitle(t1.getCell(1), 'Motor Solar Fotovoltaico — Parámetros de Simulación', 13);
      ws1.addRow([]); // Espacio

      // Categoría: Sistema FV
      const c1 = ws1.addRow([]);
      c1.height = 20;
      styleCategoryHeader(c1, 1, 3, ' ── SISTEMA FOTOVOLTAICO');

      const h1 = ws1.addRow([]);
      h1.height = 20;
      styleTableHeader(h1, ['PARÁMETRO', 'VALOR DE ENTRADA', 'UNIDAD']);

      const pvParams = [
        ['Latitud del Emplazamiento', s.lat, '° (Positivo = Norte)'],
        ['Longitud del Emplazamiento', s.lon, '° (Positivo = Este)'],
        ['Altitud sobre el nivel del mar', s.alt, 'm s.n.m.'],
        ['Eficiencia del Módulo Fotovoltaico (η)', s.eta, 'fracción decimal'],
        ['Área Superficial Frontal de un Panel', s.area_m2, 'm²'],
        ['Potencia Nominal de Placa Unitario', s.potencia_nominal_W_panel, 'W'],
        ['Cantidad Total de Módulos (N)', s.n_paneles, 'paneles'],
        ['Potencia Pico Total Instalada', s.p_nominal_total_kW, 'kWp'],
        ['Inclinación de los Módulos (Tilt)', s.tilt, '° (Respecto a horizontal)'],
        ['Orientación Azimutal de los Módulos', s.azimuth, '° (Norte = 0°, Sur = 180°)'],
        ['Días de Lluvia Activa Anuales (Pérdidas)', s.rain_days ?? 0, 'días/año'],
        ['Pérdida de Eficiencia por Lluvia', (s.rain_loss ?? 0.40) * 100, '% de caída temporal'],
        ['Pérdida de Eficiencia por Suciedad (Soiling)', (s.soiling_loss ?? 0.05) * 100, '% anual']
      ];

      pvParams.forEach((p, idx) => {
        const isEven = idx % 2 === 0;
        const fmts = [null, typeof p[1] === 'number' ? '0.00' : null, null];
        if (p[0].includes('Cantidad') || p[0].includes('Días')) fmts[1] = '#,##0';
        addDataRow(ws1, p, isEven, ['left', 'right', 'left'], fmts);
      });

      ws1.addRow([]); // Espacio

      if (state.demandData) {
        const ds = state.demandData.stats;

        // Categoría: Demanda Industrial
        const c2 = ws1.addRow([]);
        c2.height = 20;
        styleCategoryHeader(c2, 1, 3, ' ── DEMANDA INDUSTRIAL DE PLANTA');

        const h2 = ws1.addRow([]);
        h2.height = 20;
        styleTableHeader(h2, ['PARÁMETRO', 'VALOR DE ENTRADA', 'UNIDAD']);

        const demParams = [
          ['Tipo de Industria / Curva Base', ds.plant_name, '—'],
          ['Demanda Máxima Configurada (Pmax)', ds.pmax_kW, 'kW'],
          ['Turnos Diarios de Operación', ds.n_shifts, 'turnos'],
          ['Factor de Carga Teórico (FC)', ds.FC_planta, 'fracción decimal'],
          ['Factor de Potencia de Planta (FP)', ds.FP_potencia, '—'],
          ['Factor de Ajuste de Fin de Semana', ds.weekend_op_factor, 'fracción decimal'],
          ['Multiplicador Estacional de Verano', ds.summer_boost, 'multiplicador']
        ];

        demParams.forEach((p, idx) => {
          const isEven = idx % 2 === 0;
          const fmts = [null, typeof p[1] === 'number' ? '0.00' : null, null];
          addDataRow(ws1, p, isEven, ['left', 'right', 'left'], fmts);
        });

        ws1.addRow([]); // Espacio
      }

      if (state.economicData) {
        const ec = state.economicData.params;

        // Categoría: Parámetros Económicos y Tarifas CFE
        const c3 = ws1.addRow([]);
        c3.height = 20;
        styleCategoryHeader(c3, 1, 3, ' ── PARÁMETROS ECONÓMICOS Y TARIFARIOS');

        const h3 = ws1.addRow([]);
        h3.height = 20;
        styleTableHeader(h3, ['PARÁMETRO', 'VALOR DE ENTRADA', 'UNIDAD']);

        const econParams = [
          ['CAPEX (Inversión Inicial Total)', ec.capex, 'MXN'],
          ['OPEX Anual (% del CAPEX)', ec.opex_pct * 100, '%/año'],
          ['Vida Útil del Proyecto', ec.vida_util, 'años'],
          ['Tasa de Descuento (WACC)', ec.wacc * 100, '% nominal'],
          ['Tasa de Inflación Tarifaria', ec.inflacion * 100, '% anual'],
          ['Tipo de Cambio Utilizado', ec.usd_mxn, 'MXN/USD'],
          ['CFE Cargo Fijo Mensual', ec.cargo_fijo_mensual, 'MXN/mes'],
          ['CFE Demanda de Punta', ec.cargo_demanda_punta, 'MXN/kW-mes'],
          ['CFE Cargo por Respaldo', ec.cargo_respaldo, 'MXN/kW-mes'],
          ['CFE Factor de Respaldo Contratado', ec.factor_respaldo * 100, '% de la demanda contratada'],
          ['CFE Precio Base Estándar', ec.precio_base, 'MXN/kWh'],
          ['CFE Precio Intermedio Estándar', ec.precio_intermedio, 'MXN/kWh'],
          ['CFE Precio Punta Estándar', ec.precio_punta, 'MXN/kWh'],
          ['CFE Precio Base Verano', ec.precio_base_v, 'MXN/kWh'],
          ['CFE Precio Intermedio Verano', ec.precio_intermedio_v, 'MXN/kWh'],
          ['CFE Precio Punta Verano', ec.precio_punta_v, 'MXN/kWh'],
          ['Aplicar Tarifas Estacionales de Verano', ec.use_summer_tariff ? 'Sí' : 'No', '—'],
          ['Costo Energía No Suministrada (ENS)', ec.outage_cost_ens, 'MXN/kWh'],
          ['Costo Fijo por Apagón', ec.outage_cost_fix, 'MXN/evento'],
          ['Costo por Mantenimiento', ec.merma_maint_cost, 'MXN/evento'],
          ['Costo de Reemplazo (Falla Total)', ec.merma_fail_cost, 'MXN']
        ];

        econParams.forEach((p, idx) => {
          const isEven = idx % 2 === 0;
          const fmts = [null, typeof p[1] === 'number' ? '0.00' : null, null];
          if (p[0].includes('CAPEX')) fmts[1] = '$#,##0';
          addDataRow(ws1, p, isEven, ['left', 'right', 'left'], fmts);
        });

        // ── Baterías (BESS) ────────────────────────────────────────────────────────
        const useBatExcel = $('toggle-baterias')?.checked;
        if (useBatExcel) {
          ws1.addRow([]);
          const cBat = ws1.addRow([]);
          cBat.height = 20;
          styleCategoryHeader(cBat, 1, 3, ' ── SISTEMA DE ALMACENAMIENTO DE ENERGÍA (BESS)');
          const hBat = ws1.addRow([]);
          hBat.height = 20;
          styleTableHeader(hBat, ['PARÁMETRO', 'VALOR DE ENTRADA', 'UNIDAD']);
          const batKwh = parseFloat($('bat-capacidad').value);
          const batDod = parseFloat($('bat-dod').value);
          const batEff = parseFloat($('bat-eficiencia').value);
          const batVida = parseInt($('bat-vida-util').value);
          const batCostUSD = parseFloat($('bat-costo-kwh').value);
          const batParams = [
            ['Capacidad Total Instalada', batKwh, 'kWh'],
            ['Profundidad de Descarga (DoD)', batDod, '%'],
            ['Eficiencia Round-Trip', batEff, '%'],
            ['Vida Útil del Banco', batVida, 'años'],
            ['Costo del Banco', batCostUSD, 'USD/kWh'],
            ['CAPEX Baterías (MXN)', batKwh * batCostUSD * (ec.usd_mxn || 17.5), 'MXN'],
          ];
          batParams.forEach((p, idx) => {
            const isEven = idx % 2 === 0;
            const fmts = [null, '#,##0.00', null];
            if (p[2] === 'MXN') fmts[1] = '$#,##0';
            addDataRow(ws1, p, isEven, ['left', 'right', 'left'], fmts);
          });
        }

        // ── Parámetros Clímatico-Térmicos ───────────────────────────────────────────
        const useThermalExcel = $('toggle-thermal')?.checked;
        if (useThermalExcel) {
          ws1.addRow([]);
          const cThm = ws1.addRow([]);
          cThm.height = 20;
          styleCategoryHeader(cThm, 1, 3, ' ── INGENIERÍA CLIMÁTICA Y PÉRDIDAS TÉRMICAS');
          const hThm = ws1.addRow([]);
          hThm.height = 20;
          styleTableHeader(hThm, ['PARÁMETRO', 'VALOR DE ENTRADA', 'UNIDAD']);
          const thermParams = [
            ['Temperatura Ambiente Verano (May–Oct)', parseFloat($('temp-amb-verano').value), '°C'],
            ['Temperatura Ambiente Invierno (Nov–Abr)', parseFloat($('temp-amb-invierno').value), '°C'],
            ['Humedad Relativa Verano', parseFloat($('hum-verano').value), '%'],
            ['Humedad Relativa Invierno', parseFloat($('hum-invierno').value), '%'],
            ['Velocidad del Viento', parseFloat($('viento-vel').value), 'm/s'],
            ['Coeficiente de Temperatura del Panel (γ)', parseFloat($('coef-temp-panel').value), '%/°C'],
            ['Temperatura Nominal de Operación (NOCT)', parseFloat($('noct-panel').value), '°C'],
          ];
          thermParams.forEach((p, idx) => {
            const isEven = idx % 2 === 0;
            addDataRow(ws1, p, isEven, ['left', 'right', 'left'], [null, '0.00', null]);
          });
        }
      }

      autofitColumns(ws1);

      // ══════════════════════════════════════════════════════════════════════════
      // HOJA 2: KPIs de Rendimiento
      // ══════════════════════════════════════════════════════════════════════════
      const ws2 = workbook.addWorksheet('2. KPIs');
      ws2.views = [{ showGridLines: true }];

      const t2 = ws2.addRow([]);
      t2.height = 30;
      styleTitle(t2.getCell(1), 'Métricas e Indicadores Clave de Rendimiento (KPIs)', 13);
      ws2.addRow([]); // Espacio

      const c2_1 = ws2.addRow([]);
      c2_1.height = 20;
      styleCategoryHeader(c2_1, 1, 4, ' ── INDICADORES GENERALES DEL SISTEMA SOLAR');

      const h2_1 = ws2.addRow([]);
      h2_1.height = 20;
      styleTableHeader(h2_1, ['MÉTRICA / INDICADOR', 'VALOR', 'UNIDAD', 'DESCRIPCIÓN OPERATIVA']);

      const kpisSolar = [
        ['Energía Anual Generada', s.energia_anual_kWh, 'kWh/año', 'Generación eléctrica acumulada integrable durante los 365 días.'],
        ['Factor de Capacidad Solar', s.factor_capacidad_pct / 100, '%', 'Aprovechamiento real del arreglo respecto a operar 24/7 a máxima capacidad.'],
        ['Potencia Máxima Instantánea Generada', s.p_max_kW, 'kW', 'Pico absoluto registrado en el inversor durante el año.'],
        ['Irradiación Horizontal Anual', s.irrad_horizontal_kWh_m2, 'kWh/m²/año', 'Recurso de irradiancia global acumulado sobre superficie horizontal.'],
        ['Irradiación POA Anual (Jensen)', s.irrad_poa_kWh_m2, 'kWh/m²/año', 'Recurso de irradiancia POA captado por la inclinación de los módulos.'],
        ['Horas Pico Solar Equivalentes (HPSE)', s.horas_pico_sol_equiv, 'horas/año', 'Horas de sol teóricas a irradiancia constante de 1,000 W/m².'],
        ['Horas con Generación Activa', s.n_horas_generacion, 'horas/año', 'Horas anuales efectivas de inyección eléctrica (generación > 0).']
      ];

      kpisSolar.forEach((p, idx) => {
        const isEven = idx % 2 === 0;
        const fmt = p[0].includes('Factor') ? '0.0%' : '#,##0.0';
        addDataRow(ws2, p, isEven, ['left', 'right', 'center', 'left'], [null, fmt, null, null]);
      });

      if (b) {
        ws2.addRow([]); // Espacio

        const c2_2 = ws2.addRow([]);
        c2_2.height = 20;
        styleCategoryHeader(c2_2, 1, 4, ' ── BALANCE DE ACOPLAMIENTO CON LA PLANTA');

        const h2_2 = ws2.addRow([]);
        h2_2.height = 20;
        styleTableHeader(h2_2, ['MÉTRICA / INDICADOR', 'VALOR', 'UNIDAD', 'DESCRIPCIÓN OPERATIVA']);

        const kpisBalance = [
          ['Consumo Total de Planta Industrial', b.energia_demanda_kWh, 'kWh/año', 'Consumo energético anual calculado de la planta.'],
          ['Porcentaje de Cobertura Solar Anual', b.cobertura_pct / 100, '%', 'Fracción de la demanda total cubierta de forma neta por generación solar.'],
          ['Exceso Solar Exportable', b.exceso_kWh, 'kWh/año', 'Excedentes que superan la demanda instantánea y se inyectan a red.'],
          ['Déficit Neto de Red', b.deficit_kWh, 'kWh/año', 'Energía faltante de CFE requerida para suplir los consumos industriales.']
        ];

        kpisBalance.forEach((p, idx) => {
          const isEven = idx % 2 === 0;
          const fmt = p[0].includes('Cobertura') ? '0.0%' : '#,##0.0';
          addDataRow(ws2, p, isEven, ['left', 'right', 'center', 'left'], [null, fmt, null, null]);
        });

        if (state.economicData && state.economicData.riesgos) {
          const r = state.economicData.riesgos;
          ws2.addRow([]); // Espacio

          const c2_r = ws2.addRow([]);
          c2_r.height = 20;
          styleCategoryHeader(c2_r, 1, 4, ' ── IMPACTO DE RIESGOS Y RESILIENCIA');

          const h2_r = ws2.addRow([]);
          h2_r.height = 20;
          styleTableHeader(h2_r, ['MÉTRICA / INDICADOR', 'VALOR', 'UNIDAD', 'DESCRIPCIÓN OPERATIVA']);

          const kpisRiesgos = [
            ['Energía No Suministrada (ENS)', b.ens_kWh, 'kWh/año', 'Demanda industrial perdida durante apagones de red.'],
            ['Pérdida Económica por ENS', r.costo_ens, 'MXN/año', 'Costo asociado a la energía que la planta no pudo consumir.'],
            ['Pérdida Económica Fija por Apagones', r.costo_eventos_apagon, 'MXN/año', 'Costo operativo fijo incurrido en cada evento de apagón.'],
            ['Costo Esperado por Mermas y Mantenimiento', r.costo_eventos_mermas, 'MXN/año', 'Costos anualizados por mantenimientos programados y fallas.'],
            ['Total Pérdidas por Riesgos', r.perdidas_riesgos, 'MXN/año', 'Suma total de pérdidas económicas descontadas del ahorro real.']
          ];

          kpisRiesgos.forEach((p, idx) => {
            const isEven = idx % 2 === 0;
            const fmt = p[0].includes('Energía') ? '#,##0.0' : '$#,##0';
            addDataRow(ws2, p, isEven, ['left', 'right', 'center', 'left'], [null, fmt, null, null]);
          });

          // Baterías: impacto en ENS
          const useBatExcel2 = $('toggle-baterias')?.checked;
          if (useBatExcel2 && b.bat_energy_kwh != null) {
            ws2.addRow([]);
            const c2_bat = ws2.addRow([]);
            c2_bat.height = 20;
            styleCategoryHeader(c2_bat, 1, 4, ' ── DESEMPEÑO DEL SISTEMA DE BATERÍAS (BESS)');
            const h2_bat = ws2.addRow([]);
            h2_bat.height = 20;
            styleTableHeader(h2_bat, ['MÉTRICA / INDICADOR', 'VALOR', 'UNIDAD', 'DESCRIPCIÓN OPERATIVA']);
            const kpisBat = [
              ['Energía Provista por Baterías (Respaldo)', b.bat_energy_kwh, 'kWh/año', 'Energía inyectada por el BESS durante los apagones simulados.'],
              ['ENS Residual con Baterías', b.bat_ens_residual_kwh, 'kWh/año', 'Déficit que permanece después de agotar la capacidad del banco.'],
              ['Capacidad Mínima Recomendada', b.bat_sizing_min_kwh / (b.bat_sizing_dod || 0.8), 'kWh', 'Tamaño nominal sugerido para lograr 0 kWh de ENS.'],
            ];
            kpisBat.forEach((p, idx) => {
              const isEven = idx % 2 === 0;
              addDataRow(ws2, p, isEven, ['left', 'right', 'center', 'left'], [null, '#,##0.0', null, null]);
            });
          }
        }
      }

      if (state.economicData) {
        const { factura, roi } = state.economicData;

        ws2.addRow([]); // Espacio

        const c2_3 = ws2.addRow([]);
        c2_3.height = 20;
        styleCategoryHeader(c2_3, 1, 4, ' ── ANÁLISIS ECONÓMICO Y DE RETORNO DE INVERSIÓN (ROI)');

        const h2_3 = ws2.addRow([]);
        h2_3.height = 20;
        styleTableHeader(h2_3, ['MÉTRICA / INDICADOR', 'VALOR', 'UNIDAD', 'DESCRIPCIÓN OPERATIVA']);

        const kpisEcon = [
          ['Factura CFE Anual Sin Solar', factura.factura_sin, 'MXN/año', 'Costo total estimado del consumo eléctrico sin la planta solar.'],
          ['Factura CFE Anual Con Solar', factura.factura_con, 'MXN/año', 'Costo residual del consumo de red más el cargo por respaldo y cargo fijo.'],
          ['Ahorro Económico Neto Anual', factura.ahorro, 'MXN/año', 'Diferencia neta a favor generada por la inyección de energía solar.'],
          ['CAPEX Total del Proyecto (Solar + BESS)', roi.capex, 'MXN', 'Inversión inicial total incluyendo baterías si están activas.'],
          ['CAPEX Baterías (BESS)', roi.bat_capex_mxn || 0, 'MXN', 'Costo del banco de baterías incluido en el CAPEX total.'],
          ['Valor Presente Neto (VPN)', roi.vpn, 'MXN', 'Rentabilidad neta descontada del proyecto a la tasa de descuento WACC.'],
          ['Tasa Interna de Retorno (TIR)', roi.tir, '%', 'Tasa efectiva anualizada de retorno financiero del capital invertido.'],
          ['Retorno de Inversión Simple', roi.payback_simple ?? 'N/A', 'años', 'Tiempo requerido para recuperar el CAPEX sin descontar flujos.'],
          ['Retorno de Inversión Descontado', roi.payback_desc ?? 'N/A', 'años', 'Tiempo de recuperación real considerando el valor del dinero en el tiempo.'],
          ['Costo Nivelado de la Energía (LCOE)', roi.lcoe, 'MXN/kWh', 'Costo unitario promedio de cada kWh generado a lo largo de la vida útil.']
        ];

        kpisEcon.forEach((p, idx) => {
          const isEven = idx % 2 === 0;
          let fmt = null;
          if (p[0].includes('Factura') || p[0].includes('Ahorro') || p[0].includes('Neto (VPN)')) {
            fmt = '$#,##0';
          } else if (p[0].includes('Tasa')) {
            fmt = '0.0%';
          } else if (p[0].includes('Costo Nivelado')) {
            fmt = '$0.000';
          } else if (p[0].includes('Retorno') && typeof p[1] === 'number') {
            fmt = '#,##0';
          }
          addDataRow(ws2, p, isEven, ['left', 'right', 'center', 'left'], [null, fmt, null, null]);
        });
      }

      autofitColumns(ws2);

      // ══════════════════════════════════════════════════════════════════════════
      // HOJA 3: Resumen Mensual
      // ══════════════════════════════════════════════════════════════════════════
      const ws3 = workbook.addWorksheet('3. Resumen Mensual');
      ws3.views = [{ showGridLines: true }];

      const t3 = ws3.addRow([]);
      t3.height = 30;
      styleTitle(t3.getCell(1), 'Resumen Mensualizado de Generación y Recurso', 13);
      ws3.addRow([]); // Espacio

      const headers3 = ['MES', 'IRRAD. POA MEDIA [W/m²]', 'IRRAD. POA MÁX [W/m²]', 'GENERACIÓN FV [kWh]'];
      if (state.demandData) {
        headers3.push('CONSUMO PLANTA [kWh]', 'BALANCE EXCEDENTE [kWh]', 'COBERTURA SOLAR [%]');
      }

      const h3 = ws3.addRow([]);
      h3.height = 20;
      styleTableHeader(h3, headers3);

      const MONTH_NAMES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
      const aligns3 = ['left', 'right', 'right', 'right', 'right', 'right', 'right'];
      const fmts3 = [null, '#,##0.0', '#,##0.0', '#,##0', '#,##0', '#,##0', '0.0%'];

      for (let m = 0; m < 12; m++) {
        const rowVals = [
          MONTH_NAMES[m],
          state.solarData.monthly_gtot_avg[m],
          state.solarData.monthly_gtot_max[m],
          state.solarData.monthly_gen_kWh[m]
        ];
        if (state.demandData) {
          rowVals.push(
            state.demandData.monthly_kWh[m],
            b.monthly_balance[m],
            b.monthly_cobertura[m] / 100.0
          );
        }
        addDataRow(ws3, rowVals, m % 2 === 0, aligns3, fmts3);
      }

      autofitColumns(ws3);

      // ══════════════════════════════════════════════════════════════════════════
      // HOJA 4: Perfil Diario Promedio en Verano
      // ══════════════════════════════════════════════════════════════════════════
      const ws4 = workbook.addWorksheet('4. Perfil Diario Verano');
      ws4.views = [{ showGridLines: true }];

      const t4 = ws4.addRow([]);
      t4.height = 30;
      styleTitle(t4.getCell(1), 'Perfil de Carga y Generación Diario (Promedio Mayo–Agosto)', 13);
      ws4.addRow([]);

      const headers4 = ['INTERVALO', 'HORA', 'IRRAD. POA PROMEDIO [W/m²]', 'POTENCIA FV PROMEDIO [kW]'];
      if (state.demandData) headers4.push('DEMANDA PLANTA [kW]');

      const h4 = ws4.addRow([]);
      h4.height = 20;
      styleTableHeader(h4, headers4);

      const aligns4 = ['center', 'center', 'right', 'right', 'right'];
      const fmts4   = [null, null, '#,##0.0', '#,##0.00', '#,##0.00'];

      for (let i = 0; i < 96; i++) {
        const rowVals4 = [
          i + 1,
          HOURS_96[i],
          state.solarData.daily_gtot_summer[i],
          state.solarData.daily_p_summer[i]
        ];
        if (state.demandData) rowVals4.push(state.demandData.daily_weekday[i]);
        addDataRow(ws4, rowVals4, i % 2 === 0, aligns4, fmts4);
      }

      autofitColumns(ws4);

      // ══════════════════════════════════════════════════════════════════════════
      // HOJA 5: Datos Crudos Anuales (35,040 filas)
      // ══════════════════════════════════════════════════════════════════════════
      const ws5 = workbook.addWorksheet('5. Datos Crudos Anuales');
      ws5.views = [{ showGridLines: true }];

      const t5 = ws5.addRow([]);
      t5.height = 30;
      styleTitle(t5.getCell(1), 'Simulación Completa Anual — Resolución Quinceminutal (15 min)', 13);
      ws5.addRow([]);

      const headers5 = ['PUNTO', 'FECHA Y HORA', 'DÍA DEL AÑO', 'IRRAD. POA [W/m²]', 'POTENCIA FV [kW]'];
      if (state.demandData) headers5.push('DEMANDA PLANTA [kW]', 'BALANCE NETO [kW]');
      if (state.solarData.outages || state.solarData.mermas) {
        headers5.push('ESTADO RED', 'FACTOR MERMAS');
      }
      if (state.solarData.soc_arr) {
        headers5.push('SOC BATERÍA [kWh]');
      }

      const h5 = ws5.addRow([]);
      h5.height = 20;
      styleTableHeader(h5, headers5);

      const aligns5 = ['center', 'center', 'center', 'right', 'right', 'right', 'right', 'center', 'right', 'right'];
      const fmts5   = [null, null, null, '#,##0.0', '#,##0.00', '#,##0.00', '#,##0.00', null, '0.0%', '#,##0.00'];

      const days_in_month = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
      let dataIdx = 0;
      const base_dt = new Date(2024, 0, 1, 0, 0, 0);

      for (let m = 0; m < 12; m++) {
        const n_days = days_in_month[m];
        for (let d = 1; d <= n_days; d++) {
          const doy = _dayOfYear(m + 1, d);
          for (let interval = 0; interval < 96; interval++) {
            const ts = new Date(base_dt.getTime() + dataIdx * 15 * 60 * 1000);
            const formatStr =
              ts.getFullYear() + '-' +
              String(ts.getMonth() + 1).padStart(2, '0') + '-' +
              String(ts.getDate()).padStart(2, '0') + ' ' +
              String(ts.getHours()).padStart(2, '0') + ':' +
              String(ts.getMinutes()).padStart(2, '0');

            const gtot  = state.solarData.Gtot_arr[dataIdx];
            const p_pv  = state.solarData.P_kw_arr[dataIdx];
            const rowVals5 = [dataIdx + 1, formatStr, doy, gtot, p_pv];

            if (state.demandData) {
              const p_dem = state.demandData.demand_kW[dataIdx];
              rowVals5.push(p_dem, p_pv - p_dem);
            }

            if (state.solarData.outages || state.solarData.mermas) {
              const outState = (state.solarData.outages && state.solarData.outages[dataIdx]) ? 'APAGÓN' : 'ACTIVA';
              const mermaF = (state.solarData.mermas && state.solarData.mermas[dataIdx] !== undefined) ? state.solarData.mermas[dataIdx] : 1.0;
              rowVals5.push(outState, mermaF);
            }

            if (state.solarData.soc_arr) {
              const socVal = state.solarData.soc_arr[dataIdx];
              rowVals5.push(socVal); // kWh
            }

            addDataRow(ws5, rowVals5, dataIdx % 2 === 0, aligns5, fmts5);
            dataIdx++;
          }
        }
      }

      autofitColumns(ws5);

      // ── Guardar el libro con formato profesional ──
      workbook.xlsx.writeBuffer().then((buffer) => {
        saveAs(
          new Blob([buffer], { type: 'application/octet-stream' }),
          'Reporte_Simulacion_FV_Jensen_GDMTO.xlsx'
        );
      }).catch((err) => {
        alert(`Error al escribir Excel: ${err.message}`);
        console.error(err);
      }).finally(() => {
        hideLoader();
      });

    } catch (e) {
      alert(`Error al generar Excel: ${e.message}`);
      console.error(e);
      hideLoader();
    }
  }, 100);
}


// ─────────────────────────────────────────────────────────────────────────────
// ANIMACIONES DE SCROLL
// ─────────────────────────────────────────────────────────────────────────────
function initScrollAnimations() {
  const obs = new IntersectionObserver(entries => {
    entries.forEach(e => { if (e.isIntersecting) e.target.classList.add('visible'); });
  }, { threshold: 0.05, rootMargin: '0px 0px -30px 0px' });
  document.querySelectorAll('.fade-in').forEach(el => {
    // Si ya está en el viewport al cargar (sin scroll), marcar visible inmediatamente
    const rect = el.getBoundingClientRect();
    const inViewport = rect.top < window.innerHeight && rect.bottom > 0;
    if (inViewport && !el.closest('#demand-results') && !el.closest('#solar-results')) {
      el.classList.add('visible');
    } else {
      obs.observe(el);
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SCROLL SUAVE AL ANCLA
// ─────────────────────────────────────────────────────────────────────────────
function scrollTo(id) {
  const el = document.getElementById(id);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── η_sys selector ────────────────────────────────────────────────────────
function setEtaSys(btn, value) {
  document.querySelectorAll('.eta-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const input   = document.getElementById('input-etasys');
  const display = document.getElementById('etasys-display');
  if (value === 'custom') {
    input.style.display = 'block';
    display.textContent = 'Valor actual: ' + parseFloat(input.value).toFixed(2);
    input.oninput = () => {
      display.textContent = 'Valor actual: ' + parseFloat(input.value).toFixed(2);
    };
  } else {
    input.style.display = 'none';
    input.value         = value;
    display.textContent = 'Valor actual: ' + Number(value).toFixed(2);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// INICIO DE LA APLICACIÓN
// ─────────────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initSliders();
  initScrollAnimations();

  // Botones de ejecución local
  $('btn-demand')?.addEventListener('click', runDemand);
  $('btn-solar')?.addEventListener('click', runSolar);
  $('btn-download')?.addEventListener('click', downloadExcel);

  // Ocultar las secciones de resultados hasta que haya cómputos hechos
  ['demand-results', 'solar-results'].forEach(id => {
    const el = $(id);
    if (el) el.classList.add('hidden');
  });

  // Toggles de paneles de riesgo
  $('toggle-outages')?.addEventListener('change', (e) => {
    const pnl = $('outages-panel');
    if (pnl) pnl.style.display = e.target.checked ? 'block' : 'none';
  });
  $('toggle-mermas')?.addEventListener('change', (e) => {
    const pnl = $('mermas-panel');
    if (pnl) pnl.style.display = e.target.checked ? 'block' : 'none';
  });
});
