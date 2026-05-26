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
    { slider: 'eta-panel',        display: 'eta-panel-val',        suffix: '%',     multiplier: 100, decimals: 0 },
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
      $('demand-results').classList.remove('hidden');
      $('demand-results').scrollIntoView({ behavior: 'smooth', block: 'start' });
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
// CLIENT-SIDE: MOTOR SOLAR FOTOVOLTAICO (JENSEN)
// ─────────────────────────────────────────────────────────────────────────────
function runSolarEngine(lat, lon, alt, eta, area_m2, n_panels, tilt, azimuth, p_nominal_w, rainDays = 0, rainLossPct = 0.40, soilingLossPct = 0.05) {
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

        // Generación PV [kW] considerando pérdidas del sistema de 15% (Performance Ratio = 0.85)
        // Calcular día del año (0-indexed) para aplicar factor de lluvia
        let dayOfYear0 = 0;
        for (let mm = 0; mm < month_idx; mm++) dayOfYear0 += days_in_month[mm];
        dayOfYear0 += (day - 1);
        const rainFactor = rainyDaySet.has(dayOfYear0) ? (1.0 - rainLossPct) : 1.0;
        // Aplicar eficiencia del módulo, pérdidas del sistema de 15% (PR = 0.85), factor de lluvias, y pérdidas por polvo acumulado (soiling)
        const P_kw = (eta * area_m2 * Gtot * n_panels * 0.85 * rainFactor * (1.0 - soilingLossPct)) / 1000.0;

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
    eta: eta,
    area_m2: area_m2,
    tilt: tilt,
    azimuth: azimuth,
    lat: lat,
    lon: lon,
    alt: alt,
  };

  return {
    Gtot_arr: Array.from(Gtot_arr),
    P_kw_arr: Array.from(P_kw_arr),
    hours: Array.from({length: N}, (_, i) => i * 0.25),
    monthly_gtot_avg,
    monthly_gtot_max,
    monthly_gen_kWh,
    daily_gtot_summer: Array.from(daily_gtot_summer),
    daily_p_summer: Array.from(daily_p_summer),
    stats
  };
}

async function runSolar() {
  const payload = {
    lat:          parseFloat($('input-lat').value),
    lon:          parseFloat($('input-lon').value),
    alt:          parseFloat($('input-alt').value),
    eta:          parseFloat($('eta-panel').value),
    area_m2:      parseFloat($('input-area').value),
    n_panels:     parseInt($('input-npanels').value),
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
  
  setTimeout(() => {
    try {
      const data = runSolarEngine(
        payload.lat, payload.lon, payload.alt,
        payload.eta, payload.area_m2, payload.n_panels,
        payload.tilt, payload.azimuth, payload.p_nominal_w,
        payload.rain_days, payload.rain_loss, payload.soiling_loss
      );

      // Calcular balance si hay demanda guardada
      let balance = null;
      if (state.demandData) {
        const dem_arr = state.demandData.demand_kW;
        const gen_arr = data.P_kw_arr;
        
        let exceso_sum = 0, deficit_sum = 0, e_dem = 0, e_gen = 0;
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
            m_ed += dem;
            
            const diff = gen - dem;
            if (diff > 0) exceso_sum += diff;
            else deficit_sum += Math.abs(diff);
          }
          const eg_kwh = m_eg * 0.25;
          const ed_kwh = m_ed * 0.25;
          
          monthly_balance.push(Number((eg_kwh - ed_kwh).toFixed(2)));
          monthly_cobertura.push(Number((ed_kwh > 0 ? Math.min(eg_kwh / ed_kwh * 100, 100) : 0).toFixed(2)));
          
          e_gen += m_eg;
          e_dem += m_ed;
          idx_m += n_pts;
        }

        e_dem *= 0.25;
        e_gen *= 0.25;
        const cob = e_dem > 0 ? Math.min(e_gen / e_dem * 100, 100) : 0;

        balance = {
          energia_demanda_kWh: Number(e_dem.toFixed(2)),
          energia_generada_kWh: Number(e_gen.toFixed(2)),
          cobertura_pct: Number(cob.toFixed(2)),
          exceso_kWh: Number((exceso_sum * 0.25).toFixed(2)),
          deficit_kWh: Number((deficit_sum * 0.25).toFixed(2)),
          monthly_balance,
          monthly_cobertura
        };
      }

      data.balance = balance;
      state.solarData = data;
      
      renderSolarCharts(data);
      renderSolarKPIs(data.stats, data.balance);
      renderSolarStats(data.stats, data.balance);

      // Análisis económico (CFE GDMTH + ROI/VPN/TIR + gráfica inversión)
      if (typeof runEconomics === 'function') runEconomics();

      $('solar-results').classList.remove('hidden');
      $('solar-results').scrollIntoView({ behavior: 'smooth', block: 'start' });
      showAlert('solar-alert', 'success', 'Cálculo completado — Motor Jensen · Análisis CFE GDMTH · ROI calculado.');
    } catch (e) {
      showAlert('solar-alert', 'error', `Error en el cálculo: ${e.message}`);
      console.error(e);
    } finally {
      hideLoader();
    }
  }, 50);
}

function renderSolarKPIs(stats, balance) {
  const kpis = [
    { id: 'kpi-energia', val: formatNum(stats.energia_anual_MWh, 2), unit: 'MWh/año', label: 'Energía generada', color: '#f97316' },
    { id: 'kpi-fc',      val: formatNum(stats.factor_capacidad_pct, 1), unit: '%', label: 'Factor de capacidad', color: '#fbbf24' },
    { id: 'kpi-pmax',    val: formatNum(stats.p_max_kW, 2), unit: 'kW', label: 'Pico de generación', color: '#3b82f6' },
    { id: 'kpi-irrad',   val: formatNum(stats.irrad_poa_kWh_m2, 0), unit: 'kWh/m²', label: 'Irradiación POA anual', color: '#f97316' },
    { id: 'kpi-hpse',    val: formatNum(stats.horas_pico_sol_equiv, 0), unit: 'hrs', label: 'Horas pico solar equiv.', color: '#10b981' },
    { id: 'kpi-cob',     val: balance ? formatNum(balance.cobertura_pct, 1) : '—', unit: '%', label: 'Cobertura de demanda', color: '#10b981' },
  ];

  const container = $('kpi-container');
  if (container) {
    container.innerHTML = kpis.map(k => `
      <div class="kpi-card" style="--kpi-color:${k.color}">
        <div class="kpi-value">${k.val}<span class="kpi-unit"> ${k.unit}</span></div>
        <div class="kpi-label">${k.label}</div>
      </div>`).join('');
  }
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
    label: 'Generación PV (verano promedio) [kW]',
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

      // Categoría: Sistema PV
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
        ['Orientación Azimutal de los Módulos', s.azimuth, '° (Norte = 0°, Sur = 180°)']
      ];
      
      pvParams.forEach((p, idx) => {
        const isEven = idx % 2 === 0;
        const fmts = [null, typeof p[1] === 'number' ? '0.00' : null, null];
        if (p[0].includes('Cantidad')) fmts[1] = '#,##0';
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
      
      const headers3 = ['MES', 'IRRAD. POA MEDIA [W/m²]', 'IRRAD. POA MÁX [W/m²]', 'GENERACIÓN PV [kWh]'];
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

      const headers4 = ['INTERVALO', 'HORA', 'IRRAD. POA PROMEDIO [W/m²]', 'POTENCIA PV PROMEDIO [kW]'];
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

      const headers5 = ['PUNTO', 'FECHA Y HORA', 'DÍA DEL AÑO', 'IRRAD. POA [W/m²]', 'POTENCIA PV [kW]'];
      if (state.demandData) headers5.push('DEMANDA PLANTA [kW]', 'BALANCE NETO [kW]');

      const h5 = ws5.addRow([]);
      h5.height = 20;
      styleTableHeader(h5, headers5);

      const aligns5 = ['center', 'center', 'center', 'right', 'right', 'right', 'right'];
      const fmts5   = [null, null, null, '#,##0.0', '#,##0.00', '#,##0.00', '#,##0.00'];

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
          'Reporte_Simulacion_PV_Jensen_GDMTH.xlsx'
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
  }, { threshold: 0.1 });
  document.querySelectorAll('.fade-in').forEach(el => obs.observe(el));
}

// ─────────────────────────────────────────────────────────────────────────────
// SCROLL SUAVE AL ANCLA
// ─────────────────────────────────────────────────────────────────────────────
function scrollTo(id) {
  const el = document.getElementById(id);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
});
