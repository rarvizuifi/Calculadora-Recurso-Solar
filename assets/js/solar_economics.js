/**
 * solar_economics.js
 * Módulo de análisis económico: Tarifas CFE GDMTO, ROI, VPN, TIR, LCOE
 * y gráfica de recuperación de inversión con barra móvil.
 */

// ─────────────────────────────────────────────────────────────────────────────
// CALCULADORA DE FACTURA CFE GDMTO (tarifa plana — sin distinción horaria)
// ─────────────────────────────────────────────────────────────────────────────
function calcularFacturaCFEGDMTO(demandArr, genArr, solarStats, params) {
  const { precio_kwh, cargo_fijo_mensual, cargo_demanda } = params;
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
    dem_charge_sin += monthly_max_sin[m] * cargo_demanda;
    dem_charge_con += monthly_max_con[m] * cargo_demanda;
  }

  const factura_sin = energy_cost_sin + dem_charge_sin + fixed_annual;
  const factura_con = energy_cost_con + dem_charge_con + fixed_annual;
  const ahorro      = factura_sin - factura_con;

  return {
    factura_sin, factura_con, ahorro,
    energy_cost_sin, energy_cost_con,
    dem_charge_sin, dem_charge_con,
    fixed_annual,
    total_e_sin, total_e_con,
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
  let cum = -total_capex;
  for (let y = 1; y < cashflows.length; y++) {
    cum += cashflows[y];
    if (cum >= 0 && payback_simple === null) payback_simple = y;
  }

  // Payback descontado
  let payback_desc = null;
  let cum_disc = -total_capex;
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
  const lcoe = sum_disc_energy > 0 ? (total_capex + sum_disc_cost) / sum_disc_energy : null;

  // Series acumuladas año a año (para la gráfica)
  const cum_simple    = [];
  const cum_discounted= [];
  let cs = -total_capex, cd = -total_capex;
  for (let y = 1; y < cashflows.length; y++) {
    cs += cashflows[y];
    cd += cashflows[y] / Math.pow(1 + wacc, y);
    cum_simple.push(cs);
    cum_discounted.push(cd);
  }

  return { vpn, tir, payback_simple, payback_desc, lcoe, cashflows, cum_simple, cum_discounted, capex: total_capex, vida_util, bat_capex_mxn };
}

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
    precio_kwh:         g('precio-kwh')           || 1.699,
    cargo_fijo_mensual: g('cargo-fijo')            || 466.83,
    cargo_demanda:      (g('cargo-distribucion') || 57.74) +
                        (g('cargo-capacidad')    || 334.65) +
                        (g('cargo-transmision')  || 89.12),
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
      ['📈 Cargo por Demanda (Dist+Cap+Trans)',
        '—', '—',
        fmMXN(factura.dem_charge_sin,0), fmMXN(factura.dem_charge_con,0),
        fmMXN(factura.dem_charge_sin - factura.dem_charge_con, 0), '#10b981'],
      ['🧾 Cargo Fijo',
        '—', '—',
        fmMXN(factura.fixed_annual,0), fmMXN(factura.fixed_annual,0),
        '$0 MXN', '#64748b'],
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
  const factura = calcularFacturaCFEGDMTO(
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

// ─────────────────────────────────────────────────────────────────────────────
// FETCH TARIFAS GDMTO EN VIVO DESDE CFE (vía backend Flask)
// ─────────────────────────────────────────────────────────────────────────────
let _cfeDivisiones = null;

async function fetchCFETariff() {
  const btn     = document.getElementById('cfe-sync-btn');
  const badge   = document.getElementById('cfe-tariff-source');
  const divWrap = document.getElementById('cfe-division-wrap');

  if (btn) { btn.disabled = true; btn.textContent = '⏳ Consultando CFE...'; }
  if (badge) badge.textContent = '⏳ Obteniendo tarifas desde CFE...';

  try {
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
      : `✅ Tarifas CFE en vivo · ${data.division ? data.division + ' · ' : ''}${data.fecha}`;

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
  set('precio-kwh',       div.precio_kwh.toFixed(4));
  set('cargo-fijo',       div.cargo_fijo.toFixed(2));
  if (div.cargo_dist != null) set('cargo-distribucion', div.cargo_dist.toFixed(2));
  if (div.cargo_cap  != null) set('cargo-capacidad',    div.cargo_cap.toFixed(2));
  if (div.cargo_trans != null) set('cargo-transmision', div.cargo_trans.toFixed(2));
}
