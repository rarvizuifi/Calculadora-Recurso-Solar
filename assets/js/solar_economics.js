/**
 * solar_economics.js
 * Módulo de análisis económico: Tarifas CFE GDMTH, ROI, VPN, TIR, LCOE
 * y gráfica de recuperación de inversión con barra móvil.
 */

// ─────────────────────────────────────────────────────────────────────────────
// HORARIO CFE GDMTH
// Base    : 00:00–06:00 (intervals 0–23) y 22:00–24:00 (intervals 88–95)
// Intermedio: 06:00–20:00 (intervals 24–79)
// Punta   : 20:00–22:00 (intervals 80–87) — SOLO lunes a viernes
// ─────────────────────────────────────────────────────────────────────────────
function getHorarioCFE(intervalOfDay, isWeekend) {
  if (intervalOfDay < 24 || intervalOfDay >= 88) return 'base';
  if (intervalOfDay >= 80 && intervalOfDay < 88) return isWeekend ? 'intermedio' : 'punta';
  return 'intermedio';
}

// ─────────────────────────────────────────────────────────────────────────────
// CALCULADORA DE FACTURA CFE
// ─────────────────────────────────────────────────────────────────────────────
function calcularFacturaCFE(demandArr, genArr, solarStats, params) {
  const {
    precio_base, precio_intermedio, precio_punta,
    precio_base_v, precio_intermedio_v, precio_punta_v,
    use_summer_tariff,
    cargo_fijo_mensual, cargo_demanda_punta,
    cargo_respaldo, factor_respaldo
  } = params;

  const days_in_month = [31,28,31,30,31,30,31,31,30,31,30,31];
  const summer_months = new Set([4,5,6,7,8,9]); // Mayo–Oct (0-indexed)

  const h = { base:{ks:0,kc:0,cs:0,cc:0}, intermedio:{ks:0,kc:0,cs:0,cc:0}, punta:{ks:0,kc:0,cs:0,cc:0} };
  const monthly_max_punta_sin = new Array(12).fill(0);
  const monthly_max_punta_con = new Array(12).fill(0);

  let gi = 0;
  for (let m = 0; m < 12; m++) {
    const is_summer = summer_months.has(m);
    const pb = (use_summer_tariff && is_summer) ? precio_base_v      : precio_base;
    const pi = (use_summer_tariff && is_summer) ? precio_intermedio_v : precio_intermedio;
    const pp = (use_summer_tariff && is_summer) ? precio_punta_v      : precio_punta;

    let dBefore = 0;
    for (let mm = 0; mm < m; mm++) dBefore += days_in_month[mm];

    for (let d = 0; d < days_in_month[m]; d++) {
      const isWeekend = (dBefore + d) % 7 >= 5;
      for (let iv = 0; iv < 96; iv++) {
        const hr = getHorarioCFE(iv, isWeekend);
        const price = hr === 'base' ? pb : (hr === 'punta' ? pp : pi);
        const dem = demandArr[gi] || 0;
        const gen = genArr[gi] || 0;
        const net = Math.max(0, dem - gen);
        h[hr].ks += dem * 0.25;
        h[hr].kc += net * 0.25;
        h[hr].cs += dem * 0.25 * price;
        h[hr].cc += net * 0.25 * price;
        if (hr === 'punta') {
          if (dem > monthly_max_punta_sin[m]) monthly_max_punta_sin[m] = dem;
          if (net > monthly_max_punta_con[m]) monthly_max_punta_con[m] = net;
        }
        gi++;
      }
    }
  }

  const energy_cost_sin = h.base.cs + h.intermedio.cs + h.punta.cs;
  const energy_cost_con = h.base.cc + h.intermedio.cc + h.punta.cc;
  const fixed_annual    = cargo_fijo_mensual * 12;

  let dem_charge_sin = 0, dem_charge_con = 0;
  for (let m = 0; m < 12; m++) {
    dem_charge_sin += monthly_max_punta_sin[m] * cargo_demanda_punta;
    dem_charge_con += monthly_max_punta_con[m] * cargo_demanda_punta;
  }

  const p_kw = solarStats ? solarStats.p_nominal_total_kW : 0;
  const backup_annual = p_kw * factor_respaldo * cargo_respaldo * 12;

  const factura_sin = energy_cost_sin + fixed_annual + dem_charge_sin;
  const factura_con = energy_cost_con + fixed_annual + dem_charge_con + backup_annual;
  const ahorro      = factura_sin - factura_con;

  return {
    factura_sin, factura_con, ahorro,
    energy_cost_sin, energy_cost_con,
    dem_charge_sin, dem_charge_con,
    fixed_annual, backup_annual,
    horarios: {
      base:       { kwh_sin: h.base.ks,       kwh_con: h.base.kc,       costo_sin: h.base.cs,       costo_con: h.base.cc       },
      intermedio: { kwh_sin: h.intermedio.ks,  kwh_con: h.intermedio.kc,  costo_sin: h.intermedio.cs,  costo_con: h.intermedio.cc  },
      punta:      { kwh_sin: h.punta.ks,       kwh_con: h.punta.kc,       costo_sin: h.punta.cs,       costo_con: h.punta.cc       }
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CALCULADORA ROI / VPN / TIR / LCOE / PAYBACK
// ─────────────────────────────────────────────────────────────────────────────
function calcularROI(params, ahorroBase_mxn) {
  const { capex, opex_pct, vida_util, degradacion, wacc, inflacion } = params;
  const opex_anual = capex * opex_pct;

  // CAPEX total (solar + baterías si están activas)
  const useBat = document.getElementById('toggle-baterias')?.checked;
  const batCapKwh = parseFloat(document.getElementById('bat-capacidad')?.value ?? 200);
  const batCostUSD = parseFloat(document.getElementById('bat-costo-kwh')?.value ?? 350);
  const batVidaUtil = parseInt(document.getElementById('bat-vida-util')?.value ?? 10);
  const usd_mxn = params.usd_mxn;
  const bat_capex_mxn = useBat ? batCapKwh * batCostUSD * usd_mxn : 0;
  const total_capex = capex + bat_capex_mxn;

  const cashflows = [-total_capex];
  const energias  = [];
  const energia_anual_base = state.solarData ? state.solarData.stats.energia_anual_kWh : 0;

  for (let y = 1; y <= vida_util; y++) {
    const deg_factor   = Math.pow(1 - degradacion, y - 1);
    const tarif_factor = Math.pow(1 + inflacion, y - 1);
    let ahorro_y = ahorroBase_mxn * deg_factor * tarif_factor - opex_anual;
    // Costo de reemplazo de baterías (cada batVidaUtil años, excepto el primero)
    if (useBat && batVidaUtil > 0 && y % batVidaUtil === 0 && y < vida_util) {
      ahorro_y -= bat_capex_mxn; // pago de reemplazo
    }
    cashflows.push(ahorro_y);
    energias.push(energia_anual_base * deg_factor);
  }

  // VPN
  let vpn = 0;
  cashflows.forEach((cf, y) => { vpn += cf / Math.pow(1 + wacc, y); });

  // TIR — Newton-Raphson
  let tir = 0.15;
  for (let iter = 0; iter < 100; iter++) {
    let f = 0, df = 0;
    cashflows.forEach((cf, y) => {
      const denom = Math.pow(1 + tir, y);
      f  += cf / denom;
      df -= y * cf / (denom * (1 + tir));
    });
    if (Math.abs(df) < 1e-12) break;
    const step = f / df;
    tir -= step;
    if (Math.abs(step) < 1e-8) break;
  }
  if (tir < -0.99 || tir > 10) tir = null;

  // Payback simple
  let payback_simple = null;
  let cum = -capex;
  for (let y = 1; y < cashflows.length; y++) {
    cum += cashflows[y];
    if (cum >= 0 && payback_simple === null) payback_simple = y;
  }

  // Payback descontado
  let payback_desc = null;
  let cum_disc = -capex;
  for (let y = 1; y < cashflows.length; y++) {
    cum_disc += cashflows[y] / Math.pow(1 + wacc, y);
    if (cum_disc >= 0 && payback_desc === null) payback_desc = y;
  }

  // LCOE [$/kWh]
  const sum_disc_energy = energias.reduce((s, e, i) => s + e / Math.pow(1 + wacc, i + 1), 0);
  const sum_disc_cost   = cashflows.slice(1).reduce((s, cf, i) => {
    const opex_y = opex_anual;
    return s + opex_y / Math.pow(1 + wacc, i + 1);
  }, 0);
  const lcoe = sum_disc_energy > 0 ? (capex + sum_disc_cost) / sum_disc_energy : null;

  // Series acumuladas año a año (para la gráfica)
  const cum_simple    = [];
  const cum_discounted= [];
  let cs = -capex, cd = -capex;
  for (let y = 1; y < cashflows.length; y++) {
    cs += cashflows[y];
    cd += cashflows[y] / Math.pow(1 + wacc, y);
    cum_simple.push(cs);
    cum_discounted.push(cd);
  }

  return { vpn, tir, payback_simple, payback_desc, lcoe, cashflows, cum_simple, cum_discounted, capex: total_capex, vida_util, bat_capex_mxn };
}

// ─────────────────────────────────────────────────────────────────────────────
// LEER PARÁMETROS ECONÓMICOS DEL FORMULARIO
// ─────────────────────────────────────────────────────────────────────────────
function readEconomicParams() {
  const g = id => { const el = document.getElementById(id); return el ? parseFloat(el.value) : 0; };
  const gb = id => { const el = document.getElementById(id); return el ? el.checked : false; };
  
  const panelPriceUSD = g('panel-price-usd') || 180;
  const usd_mxn       = g('usd-mxn') || 17.50;
  const nPanels       = parseInt(document.getElementById('input-npanels')?.value ?? 50);
  const bosCost       = g('bos-cost') || 240000;
  
  // Calcular CAPEX Dinámico
  const capex = (panelPriceUSD * usd_mxn * nPanels) + bosCost;
  
  // Actualizar el valor del input en pantalla
  const capexInput = document.getElementById('capex-total');
  if (capexInput) {
    capexInput.value = Math.round(capex);
  }

  return {
    precio_base:          g('precio-base')          || 1.034,
    precio_intermedio:    g('precio-intermedio')     || 1.379,
    precio_punta:         g('precio-punta')          || 3.166,
    precio_base_v:        g('precio-base-v')         || 1.034,
    precio_intermedio_v:  g('precio-intermedio-v')   || 1.661,
    precio_punta_v:       g('precio-punta-v')        || 4.126,
    use_summer_tariff:    gb('toggle-verano'),
    cargo_fijo_mensual:   g('cargo-fijo')            || 58.24,
    cargo_demanda_punta:  g('cargo-demanda-punta')   || 105.48,
    cargo_respaldo:       g('cargo-respaldo')        || 67.23,
    factor_respaldo:      g('factor-respaldo')       || 0.5,
    capex:                capex,
    opex_pct:             g('opex-pct')              || 0.015,
    vida_util:            Math.round(g('vida-util')) || 25,
    degradacion:          g('degradacion-pct')       || 0.005,
    wacc:                 g('wacc')                  || 0.10,
    inflacion:            g('inflacion-tarifa')      || 0.05,
    usd_mxn:              usd_mxn,
    // Riesgos y Mermas
    outage_cost_ens:      g('outage-cost-ens')       || 8.50,
    outage_cost_fix:      g('outage-cost-fix')       || 5000,
    merma_maint_cost:     g('merma-maint-cost')      || 3500,
    merma_fail_cost:      g('merma-fail-cost')       || 85000
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// RENDERIZAR RESULTADOS ECONÓMICOS
// ─────────────────────────────────────────────────────────────────────────────
function renderEconomicResults(factura, roi, params) {
  const usd = params.usd_mxn;
  const fm  = (n, d=0) => n == null ? '—' : Number(n).toFixed(d).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fmMXN = (n, d=0) => `$${fm(n,d)} MXN`;
  const fmDual = (n, d=0) => `$${fm(n,d)} MXN <small style="color:var(--text-muted)">/ $${fm(n/usd,d)} USD</small>`;

  // KPIs Económicos
  const eKPIs = document.getElementById('economic-kpis-box');
  const riesgos = state.economicData?.riesgos || { perdidas_riesgos: 0 };
  const ahorro_real = factura.ahorro - riesgos.perdidas_riesgos;
  
  if (eKPIs) {
    const batKpis = [];
    if (roi.bat_capex_mxn > 0) {
      batKpis.push({ val: fmDual(roi.bat_capex_mxn, 0), unit: '', label: 'CAPEX Baterías (BESS)', color: '#10b981' });
    }
    eKPIs.innerHTML = [
      { val: fmDual(ahorro_real, 0),            unit: '/año',   label: 'Ahorro real anual estimado', color: '#10b981' },
      { val: fmDual(riesgos.perdidas_riesgos,0),unit: '/año',   label: 'Pérdidas por riesgos (Apagones/Mermas)', color: '#ef4444' },
      ...batKpis,
      { val: fmDual(roi.vpn, 0),                unit: '',       label: 'VPN (Valor Pte. Neto)',  color: roi.vpn >= 0 ? '#10b981' : '#ef4444' },
      { val: roi.tir != null ? `${(roi.tir*100).toFixed(1)}%` : '—', unit: '', label: 'TIR',   color: '#f97316' },
      { val: roi.payback_simple ? `${roi.payback_simple} años` : '>vida', unit: '', label: 'Payback simple', color: '#fbbf24' },
      { val: roi.payback_desc   ? `${roi.payback_desc} años`   : '>vida', unit: '', label: 'Payback descontado', color: '#3b82f6' },
      { val: roi.lcoe != null   ? `$${fm(roi.lcoe,3)}/kWh`    : '—',     unit: 'MXN', label: 'LCOE', color: '#a78bfa' },
    ].map(k => `
      <div class="kpi-card" style="--kpi-color:${k.color}">
        <div class="kpi-value" style="font-size:.95rem">${k.val}<span class="kpi-unit"> ${k.unit}</span></div>
        <div class="kpi-label">${k.label}</div>
      </div>`).join('');
    eKPIs.classList.add('visible');
  }

  // Tabla desglose CFE por horario
  const cfeBox = document.getElementById('cfe-breakdown-box');
  if (cfeBox && factura) {
    const h = factura.horarios;
    const rows = ['base','intermedio','punta'].map(name => {
      const d = h[name];
      const label = { base:'🟡 Base (00–06h / 22–24h)', intermedio:'🟠 Intermedio (06–20h)', punta:'🔴 Punta (20–22h L–V)'}[name];
      const ahorro_h = d.costo_sin - d.costo_con;
      return `<tr>
        <td>${label}</td>
        <td>${fm(d.kwh_sin,0)} kWh</td>
        <td>${fm(d.kwh_con,0)} kWh</td>
        <td>${fmMXN(d.costo_sin,0)}</td>
        <td>${fmMXN(d.costo_con,0)}</td>
        <td style="color:#10b981;font-weight:700">${fmMXN(ahorro_h,0)}</td>
      </tr>`;
    }).join('');

    cfeBox.innerHTML = `
      <div style="font-size:.85rem;color:var(--accent-orange);text-transform:uppercase;letter-spacing:.06em;margin-bottom:1rem;">
        💡 Desglose de Factura CFE GDMTH — Con Solar vs. Sin Solar
      </div>
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:.82rem">
          <thead>
            <tr style="background:rgba(249,115,22,0.12)">
              <th style="padding:.6rem .9rem;text-align:left;color:#f97316;border-bottom:1px solid rgba(249,115,22,0.3)">Horario</th>
              <th style="padding:.6rem .9rem;color:#f97316;border-bottom:1px solid rgba(249,115,22,0.3)">kWh/año Sin Solar</th>
              <th style="padding:.6rem .9rem;color:#f97316;border-bottom:1px solid rgba(249,115,22,0.3)">kWh/año Con Solar</th>
              <th style="padding:.6rem .9rem;color:#f97316;border-bottom:1px solid rgba(249,115,22,0.3)">Costo Sin Solar</th>
              <th style="padding:.6rem .9rem;color:#f97316;border-bottom:1px solid rgba(249,115,22,0.3)">Costo Con Solar</th>
              <th style="padding:.6rem .9rem;color:#10b981;border-bottom:1px solid rgba(249,115,22,0.3)">Ahorro</th>
            </tr>
          </thead>
          <tbody style="color:#cbd5e1">${rows}</tbody>
          <tfoot>
            <tr style="background:rgba(249,115,22,0.08);color:#f97316;font-weight:700">
              <td style="padding:.6rem .9rem;border-top:1px solid rgba(249,115,22,0.3)">TOTAL ANUAL</td>
              <td style="padding:.6rem .9rem;text-align:right"></td>
              <td style="padding:.6rem .9rem;text-align:right"></td>
              <td style="padding:.6rem .9rem;text-align:right">${fmMXN(factura.factura_sin,0)}</td>
              <td style="padding:.6rem .9rem;text-align:right">${fmMXN(factura.factura_con,0)}</td>
              <td style="padding:.6rem .9rem;text-align:right;color:#10b981">${fmMXN(factura.ahorro,0)}<br><small>/ $${fm(factura.ahorro/usd,0)} USD</small></td>
            </tr>
            <tr style="color:#94a3b8;font-size:.75rem">
              <td colspan="6" style="padding:.4rem .9rem">
                Cargo fijo: ${fmMXN(factura.fixed_annual,0)}/año · Cargo demanda punta sin solar: ${fmMXN(factura.dem_charge_sin,0)}/año · Cargo respaldo: ${fmMXN(factura.backup_annual,0)}/año
              </td>
            </tr>
          </tfoot>
        </table>
      </div>`;
    cfeBox.classList.add('visible');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GRÁFICA DE RECUPERACIÓN DE INVERSIÓN CON BARRA MÓVIL
// ─────────────────────────────────────────────────────────────────────────────
// Plugin Chart.js para línea vertical móvil
const verticalLinePlugin = {
  id: 'verticalLine',
  beforeDraw(chart) {
    const xVal = chart._vLineX;
    if (xVal == null) return;
    const { ctx, chartArea, scales } = chart;
    const x = scales.x.getPixelForValue(xVal);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x, chartArea.top);
    ctx.lineTo(x, chartArea.bottom);
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#f97316';
    ctx.setLineDash([6, 3]);
    ctx.stroke();
    ctx.restore();
  }
};
Chart.register(verticalLinePlugin);

function renderInvestmentChart(roi, params) {
  const usd = params.usd_mxn;
  const years = Array.from({ length: roi.vida_util }, (_, i) => `Año ${i + 1}`);

  destroyChart('investment');
  const ctx = document.getElementById('chart-investment');
  if (!ctx) return;

  const capexLine = new Array(roi.vida_util).fill(-roi.capex);

  state.charts.investment = new Chart(ctx, {
    type: 'line',
    data: {
      labels: years,
      datasets: [
        {
          label: 'Flujo acumulado simple [MXN]',
          data: roi.cum_simple,
          borderColor: '#10b981',
          backgroundColor: 'rgba(16,185,129,0.08)',
          fill: true,
          tension: 0.35,
          pointRadius: 0,
          borderWidth: 2.5,
        },
        {
          label: 'VPN acumulado descontado [MXN]',
          data: roi.cum_discounted,
          borderColor: '#3b82f6',
          backgroundColor: 'transparent',
          tension: 0.35,
          pointRadius: 0,
          borderWidth: 2,
          borderDash: [5, 3],
        },
        {
          label: 'Inversión inicial (CAPEX)',
          data: capexLine,
          borderColor: 'rgba(239,68,68,0.6)',
          backgroundColor: 'transparent',
          pointRadius: 0,
          borderWidth: 1.5,
          borderDash: [3, 3],
        },
        {
          label: 'Punto de equilibrio (0)',
          data: new Array(roi.vida_util).fill(0),
          borderColor: 'rgba(255,255,255,0.15)',
          backgroundColor: 'transparent',
          pointRadius: 0,
          borderWidth: 1,
        }
      ]
    },
    options: {
      responsive: true,
      interaction: { intersect: false, mode: 'index' },
      plugins: {
        legend: { labels: { boxWidth: 12, font: { size: 11 } } },
        tooltip: {
          callbacks: {
            label: c => {
              const v = c.raw;
              return ` ${c.dataset.label}: $${Number(v).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} MXN / $${(v/usd).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} USD`;
            }
          }
        }
      },
      scales: {
        x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { maxTicksLimit: 10 } },
        y: {
          title: {
            display: true,
            text: 'Monto [Pesos MXN]',
            color: '#94a3b8',
            font: { size: 12, weight: 'bold' }
          },
          grid: { color: 'rgba(255,255,255,0.05)' },
          ticks: {
            callback: v => {
              const abs = Math.abs(v);
              if (abs >= 1e6) return `${(v/1e6).toFixed(1)}M`;
              if (abs >= 1e3) return `${(v/1e3).toFixed(0)}k`;
              return v;
            }
          }
        }
      }
    }
  });
  state.charts.investment._vLineX = 0;

  // Slider de año
  const slider = document.getElementById('year-slider');
  if (slider) {
    slider.max = roi.vida_util;
    slider.value = 1;
    const updateSlider = () => {
      const yr = parseInt(slider.value);
      state.charts.investment._vLineX = yr - 1;
      state.charts.investment.update('none');

      const badge = document.getElementById('year-slider-badge');
      if (badge) badge.textContent = `Año ${yr}`;

      const cs  = roi.cum_simple[yr - 1]    ?? 0;
      const cd  = roi.cum_discounted[yr - 1] ?? 0;
      const cf  = roi.cashflows[yr]           ?? 0;
      const cards = document.getElementById('year-cards');
      const fmt = n => `$${Number(n).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
      const fmtUSD = n => `/ $${(n/usd).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} USD`;
      const cls = n => n >= 0 ? 'positive' : 'negative';
      if (cards) cards.innerHTML = [
        { label: 'Flujo acumulado (simple)',    val: `${fmt(cs)} MXN<br><small style="color:var(--text-muted)">${fmtUSD(cs)}</small>`,  c: cls(cs) },
        { label: 'VPN acumulado (descontado)',  val: `${fmt(cd)} MXN<br><small style="color:var(--text-muted)">${fmtUSD(cd)}</small>`,  c: cls(cd) },
        { label: 'Ahorro en año ' + yr,         val: `${fmt(cf)} MXN<br><small style="color:var(--text-muted)">${fmtUSD(cf)}</small>`,  c: cls(cf) },
        { label: 'ROI acumulado simple',         val: `${((cs + roi.capex)/roi.capex*100).toFixed(1)}%`, c: cs >= 0 ? 'positive' : 'negative' },
      ].map(k => `
        <div style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:.75rem 1rem;text-align:center">
          <div style="font-size:.7rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:.3rem">${k.label}</div>
          <div class="year-card-val ${k.c}" style="font-size:.9rem;font-weight:700">${k.val}</div>
        </div>`).join('');
    };
    slider.addEventListener('input', updateSlider);
    updateSlider();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUNTO DE ENTRADA: calcular y renderizar todo lo económico
// ─────────────────────────────────────────────────────────────────────────────
function runEconomics() {
  if (!state.solarData || !state.demandData) return;
  const params  = readEconomicParams();
  const factura = calcularFacturaCFE(
    state.demandData.demand_kW,
    state.solarData.P_kw_arr,
    state.solarData.stats,
    params
  );

  // Calcular impacto de riesgos (Mermas y Apagones)
  let costo_ens = 0;
  let costo_eventos_apagon = 0;
  let costo_eventos_mermas = 0;

  if (state.solarData.balance && state.solarData.balance.ens_kWh > 0) {
    // Si hay baterías activas, usar el ENS residual (mitigado por baterías)
    const useBat = document.getElementById('toggle-baterias')?.checked;
    const ens_efectivo = useBat && state.solarData.balance.bat_ens_residual_kwh != null
      ? state.solarData.balance.bat_ens_residual_kwh
      : state.solarData.balance.ens_kWh;
    costo_ens = ens_efectivo * params.outage_cost_ens;
    if (ens_efectivo > 0) {
      const freq_outages = parseFloat(document.getElementById('outage-freq')?.value ?? 0);
      costo_eventos_apagon = freq_outages * params.outage_cost_fix;
    }
  }

  if (document.getElementById('toggle-mermas')?.checked) {
    const maint_freq = parseFloat(document.getElementById('merma-maint-freq')?.value ?? 0);
    const fail_prob = parseFloat(document.getElementById('merma-fail-prob')?.value ?? 0);
    costo_eventos_mermas += maint_freq * params.merma_maint_cost;
    costo_eventos_mermas += (fail_prob / 100.0) * params.merma_fail_cost;
  }

  const perdidas_riesgos = costo_ens + costo_eventos_apagon + costo_eventos_mermas;
  const ahorro_real = factura.ahorro - perdidas_riesgos;

  const roi = calcularROI(params, ahorro_real);

  state.economicData = { factura, roi, params, riesgos: { costo_ens, costo_eventos_apagon, costo_eventos_mermas, perdidas_riesgos } };

  renderEconomicResults(factura, roi, params);
  renderInvestmentChart(roi, params);
}
