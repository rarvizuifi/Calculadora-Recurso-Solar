"""
demand_profile.py
=================
Generador de perfil de demanda industrial quinceminutal (15 min).
Genera 35,040 puntos = 365 días × 24 hrs × 4 intervalos.

═══════════════════════════════════════════════════════════════════════════════
GLOSARIO DE PARÁMETROS DE ENTRADA — generate_demand_profile()
───────────────────────────────────────────────────────────────────────────────
Pmax_kW           [kW]       Potencia máxima de la instalación.
                              Define la escala absoluta del perfil generado.
                              Valor libre; sin límite superior.

FC_planta         [frac.]    Factor de Carga de planta: relación entre la potencia
                              media consumida y la potencia máxima contratada.
                              FC = P_media / P_max. Rango típico: 0.40–0.90.
                              Un FC alto indica operación continua y eficiente.

FP_potencia       [frac.]    Factor de Potencia: relación entre potencia activa
                              (kW) y potencia aparente (kVA). Relevante para
                              dimensionar el transformador y cargos en la tarifa
                              eléctrica. Rango: 0.60–1.00. Típico: 0.85–0.95.

n_shifts          [ud.]      Número de turnos de operación diaria.
                              1 = turno diurno  (06:00–14:00)
                              2 = dos turnos    (06:00–22:00)
                              3 = tres turnos   (operación continua 24 h)
                              Fuera del horario de turno la carga base se reduce
                              al 20–25 % de la nominal.

plant_type        [texto]    Tipo de perfil de consumo industrial:
                              'manufactura_ligera' — Turnos bien definidos, picos
                                                     marcados en horas punta.
                              'manufactura_pesada' — Alta carga base (≥70 %), poco
                                                     apagado nocturno, hornos y
                                                     procesos continuos.
                              'oficinas'           — HVAC dominante, consumo bajo
                                                     en noches y fines de semana.
                              'almacen'            — Horario diurno con poca carga
                                                     nocturna.
                              'data_center'        — Carga casi constante 24/7
                                                     (≥85 % todo el tiempo).

weekend_op_factor [frac.]    Factor multiplicativo de operación en fin de semana
                              respecto al perfil base de fin de semana.
                              0.0 = planta cerrada sábados y domingos.
                              1.0 = operación completa igual que entre semana.
                              Típico: 0.30–0.60.

summer_boost      [frac.]    Factor de incremento de demanda en meses de verano
                              (mayo–septiembre). Modela la mayor carga de HVAC,
                              refrigeración de proceso, etc.
                              1.0 = sin incremento. Típico: 1.05–1.20.

═══════════════════════════════════════════════════════════════════════════════
GLOSARIO DE RESULTADOS — dict de retorno
───────────────────────────────────────────────────────────────────────────────
demand_kW         [kW, 35040 pts]   Potencia demandada en cada intervalo de 15 min.
hours             [h,  35040 pts]   Eje de tiempo (0 … 8759.75 h).
monthly_avg       [kW, 12 vals]     Potencia media mensual [kW].
monthly_max       [kW, 12 vals]     Potencia máxima mensual [kW].
monthly_min       [kW, 12 vals]     Potencia mínima mensual [kW].
monthly_kWh       [kWh, 12 vals]    Energía consumida por mes [kWh/mes].
daily_weekday     [kW, 96 vals]     Perfil diario promedio de día laboral (96 intervalos).
daily_weekend     [kW, 96 vals]     Perfil diario promedio de fin de semana.
stats.pmax_kW                       Potencia máxima ingresada [kW].
stats.p_media_kW                    Potencia media real calculada [kW].
stats.p_max_real_kW                 Potencia máxima real del perfil (≈ Pmax × FP) [kW].
stats.energia_anual_kWh             Energía total anual consumida [kWh/año].
stats.factor_carga_real             Factor de carga real = P_media / P_max_real [-].
stats.horas_punta_equiv             Horas equivalentes de plena carga = E_anual / Pmax [h/año].
"""

import numpy as np

PLANT_PROFILES = {
    'manufactura_ligera': {
        'name': 'Manufactura Ligera', 'desc': 'Turnos bien definidos.',
        'weekday': [
            0.35, 0.33, 0.32, 0.32, 0.34, 0.60, 0.82, 0.95, 1.00, 1.00, 0.98, 0.72,
            0.72, 0.96, 1.00, 1.00, 0.95, 0.78, 0.68, 0.65, 0.60, 0.55, 0.45, 0.38,
        ],
        'weekend': [
            0.15, 0.14, 0.13, 0.13, 0.14, 0.20, 0.30, 0.42, 0.48, 0.48, 0.46, 0.40,
            0.38, 0.42, 0.46, 0.44, 0.40, 0.35, 0.30, 0.25, 0.22, 0.20, 0.17, 0.15,
        ],
    },
    'manufactura_pesada': {
        'name': 'Manufactura Pesada', 'desc': 'Alta carga base nocturna.',
        'weekday': [
            0.70, 0.68, 0.67, 0.66, 0.68, 0.75, 0.85, 0.95, 1.00, 1.00, 0.98, 0.95,
            0.88, 0.95, 1.00, 1.00, 0.98, 0.95, 0.90, 0.85, 0.82, 0.80, 0.75, 0.72,
        ],
        'weekend': [
            0.60, 0.58, 0.56, 0.55, 0.56, 0.60, 0.65, 0.70, 0.75, 0.75, 0.73, 0.70,
            0.68, 0.70, 0.72, 0.70, 0.68, 0.65, 0.63, 0.62, 0.61, 0.60, 0.59, 0.60,
        ],
    },
    'oficinas': {
        'name': 'Edificio de Oficinas', 'desc': 'HVAC dominante.',
        'weekday': [
            0.12, 0.11, 0.11, 0.11, 0.12, 0.20, 0.45, 0.72, 0.90, 0.98, 1.00, 1.00,
            0.90, 0.98, 1.00, 0.98, 0.90, 0.70, 0.45, 0.30, 0.22, 0.18, 0.15, 0.12,
        ],
        'weekend': [
            0.10, 0.10, 0.10, 0.10, 0.10, 0.12, 0.15, 0.18, 0.20, 0.22, 0.22, 0.20,
            0.18, 0.18, 0.18, 0.15, 0.14, 0.12, 0.11, 0.10, 0.10, 0.10, 0.10, 0.10,
        ],
    },
    'almacen': {
        'name': 'Almacén', 'desc': 'Horario diurno.',
        'weekday': [
            0.20, 0.18, 0.18, 0.18, 0.20, 0.40, 0.65, 0.85, 0.95, 1.00, 1.00, 0.95,
            0.88, 0.95, 1.00, 0.98, 0.92, 0.80, 0.60, 0.40, 0.32, 0.28, 0.24, 0.20,
        ],
        'weekend': [
            0.18, 0.17, 0.17, 0.17, 0.18, 0.25, 0.35, 0.50, 0.60, 0.65, 0.65, 0.62,
            0.58, 0.62, 0.65, 0.62, 0.55, 0.45, 0.35, 0.28, 0.24, 0.22, 0.20, 0.18,
        ],
    },
    'data_center': {
        'name': 'Centro de Datos', 'desc': 'Carga casi constante 24/7.',
        'weekday': [
            0.88, 0.87, 0.86, 0.86, 0.87, 0.89, 0.92, 0.96, 1.00, 1.00, 0.99, 0.98,
            0.97, 0.98, 1.00, 1.00, 0.99, 0.98, 0.96, 0.94, 0.92, 0.91, 0.90, 0.89,
        ],
        'weekend': [
            0.86, 0.85, 0.84, 0.84, 0.85, 0.86, 0.88, 0.90, 0.92, 0.93, 0.93, 0.92,
            0.91, 0.91, 0.92, 0.91, 0.90, 0.89, 0.88, 0.87, 0.87, 0.86, 0.86, 0.86,
        ],
    },
}

def _apply_shifts(profile_24h: list, n_shifts: int) -> list:
    adjusted = list(profile_24h)
    if n_shifts == 1:
        for h in range(24):
            if not (6 <= h < 14): adjusted[h] = profile_24h[h] * 0.20
    elif n_shifts == 2:
        for h in range(24):
            if not (6 <= h < 22): adjusted[h] = profile_24h[h] * 0.25
    return adjusted

def generate_demand_profile(
    Pmax_kW: float, FC_planta: float, FP_potencia: float,
    n_shifts: int = 2, plant_type: str = 'manufactura_ligera',
    weekend_op_factor: float = 0.50, summer_boost: float = 1.10,
) -> dict:
    np.random.seed(42)
    if plant_type not in PLANT_PROFILES: plant_type = 'manufactura_ligera'
    profile_data = PLANT_PROFILES[plant_type]

    profile_weekday = _apply_shifts(profile_data['weekday'], n_shifts)
    profile_weekend_base = _apply_shifts(profile_data['weekend'], n_shifts)

    N = 35040
    demand = np.zeros(N)
    days_in_month = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    summer_months = {4, 5, 6, 7, 8}

    idx = 0
    for month_idx, n_days in enumerate(days_in_month):
        is_summer = month_idx in summer_months
        season_factor = summer_boost if is_summer else 1.0

        for day in range(n_days):
            weekday = (sum(days_in_month[:month_idx]) + day) % 7
            is_weekend = weekday >= 5

            if is_weekend:
                base_profile = [v * weekend_op_factor for v in profile_weekend_base]
            else:
                base_profile = profile_weekday

            for interval in range(96):
                hour_of_day = int(interval / 4)
                frac = (interval % 4) / 4.0
                next_h = (hour_of_day + 1) % 24
                base = (1 - frac) * base_profile[hour_of_day] + frac * base_profile[next_h]

                p = Pmax_kW * base * FC_planta * season_factor
                noise = np.random.normal(1.0, 0.04)
                demand[idx] = max(0.0, p * noise)
                idx += 1

    if demand.max() > 0:
        demand = demand * (Pmax_kW * FP_potencia / demand.max())

    hours = np.arange(N) * 0.25

    monthly_avg, monthly_max, monthly_min, monthly_kwh = [], [], [], []
    idx = 0
    for n_days in days_in_month:
        n_pts = n_days * 96
        seg = demand[idx: idx + n_pts]
        monthly_avg.append(float(np.mean(seg)))
        monthly_max.append(float(np.max(seg)))
        monthly_min.append(float(np.min(seg)))
        monthly_kwh.append(float(np.sum(seg) * 0.25))
        idx += n_pts

    daily_weekday = np.zeros(96)
    daily_weekend = np.zeros(96)
    cnt_w, cnt_we = 0, 0
    for d in range(365):
        seg = demand[d * 96: (d + 1) * 96]
        if d % 7 < 5:
            daily_weekday += seg; cnt_w += 1
        else:
            daily_weekend += seg; cnt_we += 1
    if cnt_w  > 0: daily_weekday /= cnt_w
    if cnt_we > 0: daily_weekend /= cnt_we

    energy_kwh = float(np.sum(demand) * 0.25)
    stats = {
        'pmax_kW': float(Pmax_kW),
        'p_media_kW': float(np.mean(demand)),
        'p_min_kW': float(np.min(demand)),
        'p_max_real_kW': float(np.max(demand)),
        'energia_anual_kWh': energy_kwh,
        'energia_anual_MWh': energy_kwh / 1000,
        'factor_carga_real': float(np.mean(demand) / np.max(demand)) if demand.max() > 0 else 0,
        'horas_punta_equiv': energy_kwh / Pmax_kW if Pmax_kW > 0 else 0,
        'FC_planta': FC_planta,
        'FP_potencia': FP_potencia,
        'n_shifts': n_shifts,
        'plant_type': plant_type,
        'plant_name': profile_data['name'],
        'weekend_op_factor': weekend_op_factor,
        'summer_boost': summer_boost,
    }

    return {
        'demand_kW': demand.tolist(),
        'hours': hours.tolist(),
        'monthly_avg': monthly_avg,
        'monthly_max': monthly_max,
        'monthly_min': monthly_min,
        'monthly_kWh': monthly_kwh,
        'daily_weekday': daily_weekday.tolist(),
        'daily_weekend': daily_weekend.tolist(),
        'daily_profile': daily_weekday.tolist(), # compatibilidad
        'stats': stats,
    }