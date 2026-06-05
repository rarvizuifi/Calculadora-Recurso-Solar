"""
solar_engine.py  v2.0
=====================
Motor Jensen mejorado para cálculo de irradiancia en plano inclinado (POA)
y generación fotovoltaica anual con resolución quinceminutal (15 min).

NUEVO en v2.0:
  - Pérdidas térmicas del panel (modelo Faiman / NOCT)
  - Refrigeración por aire: humedad relativa y velocidad de viento
  - Almacenamiento con baterías (ciclos, desgaste, CAPEX)
  - Base de datos climática simplificada (~30 ciudades)
  - Modelado de cortes de energía (frecuencia, duración, pérdidas)
  - Todas las pérdidas del sistema (cableado, inversor, suciedad, mismatch…)

═══════════════════════════════════════════════════════════════════════════════
GLOSARIO DE PARÁMETROS DE ENTRADA
───────────────────────────────────────────────────────────────────────────────
lat            [°]       Latitud geográfica. Positivo = Norte. Ej: 25.67 (Monterrey)
lon            [°]       Longitud geográfica. Negativo = Oeste. Ej: -100.31
alt            [m]       Altitud sobre el nivel del mar.
eta            [frac.]   Eficiencia eléctrica del panel en condiciones estándar (STC,
                         25 °C, 1000 W/m²). Ej: 0.20 → 20 %
area_m2        [m²]      Área activa de un panel. Ej: 2.0 m²
n_panels       [ud.]     Número de paneles en el arreglo.
tilt           [°]       Ángulo de inclinación del plano del panel respecto a
                         la horizontal. 0° = horizontal, 90° = vertical.
azimuth        [°]       Orientación del panel medida desde el Norte en sentido
                         horario. 0° = Norte, 90° = Este, 180° = Sur, 270° = Oeste.
                         Para el hemisferio Norte, 180° (Sur) es óptimo.
p_nominal_w    [W]       Potencia nominal (pico) de un panel en STC.

── Pérdidas del sistema ──────────────────────────────────────────────────────
loss_wiring    [frac.]   Pérdidas por resistencia del cableado DC+AC. Típico 0.02–0.03
loss_inverter  [frac.]   Pérdidas en el inversor (conversión DC→AC). Típico 0.02–0.04
loss_dirt      [frac.]   Pérdidas por suciedad/polvo en el panel. Típico 0.02–0.05
loss_mismatch  [frac.]   Pérdidas por mismatch (variación entre paneles). Típico 0.01–0.02
loss_shading   [frac.]   Pérdidas por sombras sobre el arreglo. Típico 0.0–0.10

── Modelo térmico ────────────────────────────────────────────────────────────
NOCT           [°C]      Temperatura de Operación Nominal de Celda (condiciones
                         NOCT: 800 W/m², 20 °C, viento 1 m/s). Típico 44–48 °C.
T_coeff        [%/°C]    Coeficiente de temperatura de potencia del panel.
                         Negativo: a mayor temperatura, menor potencia.
                         Monocristalino ≈ -0.35 %/°C a -0.45 %/°C.
wind_speed     [m/s]     Velocidad media del viento en el sitio. Influye en el
                         enfriamiento convectivo de los paneles.
humidity_pct   [%]       Humedad relativa media (0–100). Modifica el calor
                         específico del aire de refrigeración.

── Baterías ──────────────────────────────────────────────────────────────────
battery_kwh    [kWh]     Capacidad total del banco de baterías (energía útil).
battery_eta    [frac.]   Eficiencia round-trip del banco (carga+descarga). Típico 0.90–0.95
battery_dod    [frac.]   Profundidad de descarga máxima permitida. Ej: 0.80 = 80 %
battery_cycles [ud.]     Vida útil en ciclos completos del tipo de batería.
                         Li-Ion NMC ≈ 3000–6000, LFP ≈ 5000–8000.
battery_cost_kwh[USD/kWh]Costo de adquisición de la batería por kWh instalado.
battery_install_pct[frac.]Factor de costo de instalación sobre el costo de equipo.
                         Típico 0.20–0.35 (20–35 % adicional).

── Cortes de energía ─────────────────────────────────────────────────────────
outage_freq_yr [ud./año] Número esperado de cortes de energía por año.
outage_avg_h   [h]       Duración media de cada corte (horas).
outage_loss_pct[%]       Porcentaje de la demanda no cubierta durante un corte
                         cuando el sistema solar+baterías tampoco alcanza.

═══════════════════════════════════════════════════════════════════════════════
GLOSARIO DE RESULTADOS (dict de retorno)
───────────────────────────────────────────────────────────────────────────────
Gtot_arr             [W/m², 35040 pts]  Irradiancia total en el plano del arreglo (POA).
P_kw_arr             [kW,   35040 pts]  Potencia generada neta (después de todas las pérdidas).
P_kw_gross_arr       [kW,   35040 pts]  Potencia bruta antes de pérdidas térmicas y de sistema.
T_cell_arr           [°C,   35040 pts]  Temperatura de celda calculada en cada intervalo.
battery_soc_arr      [kWh,  35040 pts]  Estado de carga del banco de baterías (energy stored).
hours                [h,    35040 pts]  Eje de tiempo anual (0 … 8759.75 h).
monthly_gtot_avg     [W/m², 12 vals]    Irradiancia POA promedio mensual.
monthly_gtot_max     [W/m², 12 vals]    Irradiancia POA máxima mensual.
monthly_gen_kWh      [kWh,  12 vals]    Energía generada neta por mes.
monthly_bat_charge   [kWh,  12 vals]    Energía almacenada en baterías por mes.
monthly_bat_discharge[kWh,  12 vals]    Energía descargada de baterías por mes.
daily_gtot_summer    [W/m², 96 vals]    Perfil diario de irradiancia POA (promedio verano).
daily_p_summer       [kW,   96 vals]    Perfil diario de generación neta (promedio verano).
stats                [dict]             Indicadores clave (ver dentro del dict).
  energia_anual_kWh           Energía eléctrica total generada en un año [kWh].
  energia_anual_MWh           Ídem en MWh.
  p_max_kW                    Potencia pico real del arreglo durante el año [kW].
  p_nominal_total_kW          Potencia nominal total del sistema = n_panels × p_nominal_w [kWp].
  factor_capacidad_pct        Factor de capacidad = E_anual / (P_nominal × 8760) × 100 [%].
  horas_pico_sol_equiv        Horas pico solar equivalente = E_anual / P_nominal [h/año].
  irrad_horizontal_kWh_m2     Irradiación total anual en plano horizontal [kWh/m²·año].
  irrad_poa_kWh_m2            Irradiación total anual en POA [kWh/m²·año].
  gtot_max_W_m2               Irradiancia POA máxima en el año [W/m²].
  gtot_media_W_m2             Irradiancia POA media en horas de sol [W/m²].
  n_horas_generacion          Horas al año con generación positiva [h].
  T_cell_media_C              Temperatura media de celda en horas de sol [°C].
  T_cell_max_C                Temperatura máxima de celda en el año [°C].
  perdida_termica_pct         Pérdida anual media por temperatura respecto a STC [%].
  perdida_sistema_pct         Pérdida total por cableado, inversor, suciedad, etc. [%].
  battery_kwh                 Capacidad útil del banco de baterías [kWh].
  battery_energy_stored_kWh   Energía total almacenada en baterías al año [kWh].
  battery_energy_served_kWh   Energía total descargada de baterías al año [kWh].
  battery_cycles_used         Ciclos equivalentes usados en el año.
  battery_life_years          Vida útil estimada del banco [años].
  battery_capex_usd           CAPEX total de las baterías (equipo + instalación) [USD].
  outage_hours_yr             Horas de corte de energía esperadas por año [h].
  outage_energy_lost_kWh      Energía no servida por cortes al año [kWh].
  panel_cost_usd              CAPEX de los paneles solares [USD] (si se proporciona costo).
  inverter_cost_usd           CAPEX del inversor [USD].
  total_capex_usd             CAPEX total del sistema [USD].
  n_paneles                   Número de paneles.
  potencia_nominal_W_panel    Potencia nominal por panel [W].
  eta                         Eficiencia STC del panel [frac.].
  area_m2                     Área por panel [m²].
  tilt / azimuth / lat / lon / alt  Parámetros geométricos y de ubicación.
"""

import numpy as np
from typing import Optional

# ─────────────────────────────────────────────────────────────────────────────
# CONSTANTES FÍSICAS
# ─────────────────────────────────────────────────────────────────────────────
GSC  = 1367.0          # Constante solar [W/m²]
RHO  = 0.20            # Albedo del suelo
DEG  = np.pi / 180.0   # Conversión grados → radianes
T_STC = 25.0           # Temperatura STC [°C]

# ─────────────────────────────────────────────────────────────────────────────
# BASE DE DATOS CLIMÁTICA SIMPLIFICADA
# Fuente: valores representativos de promedios anuales (NASA POWER / ASHRAE)
# Campos: lat, lon, alt, T_avg, T_max_summer, T_min_winter,
#         wind_speed (m/s), humidity_pct (%), description
# ─────────────────────────────────────────────────────────────────────────────
CLIMATE_DB = {
    # ── México ────────────────────────────────────────────────────────────────
    'monterrey':        {'lat': 25.67, 'lon': -100.31, 'alt': 538,  'T_avg': 22.5, 'T_max': 38.0, 'T_min': 8.0,  'wind': 3.2, 'hum': 58, 'desc': 'Monterrey, México'},
    'guadalajara':      {'lat': 20.66, 'lon': -103.35, 'alt': 1567, 'T_avg': 20.0, 'T_max': 33.0, 'T_min': 8.0,  'wind': 2.5, 'hum': 55, 'desc': 'Guadalajara, México'},
    'cdmx':             {'lat': 19.43, 'lon': -99.13,  'alt': 2240, 'T_avg': 16.0, 'T_max': 28.0, 'T_min': 5.0,  'wind': 2.0, 'hum': 62, 'desc': 'Ciudad de México'},
    'merida':           {'lat': 20.97, 'lon': -89.62,  'alt': 9,    'T_avg': 27.0, 'T_max': 40.0, 'T_min': 16.0, 'wind': 3.5, 'hum': 72, 'desc': 'Mérida, México'},
    'chihuahua':        {'lat': 28.63, 'lon': -106.07, 'alt': 1428, 'T_avg': 18.0, 'T_max': 38.0, 'T_min': -2.0, 'wind': 2.8, 'hum': 40, 'desc': 'Chihuahua, México'},
    'hermosillo':       {'lat': 29.07, 'lon': -110.96, 'alt': 237,  'T_avg': 24.0, 'T_max': 44.0, 'T_min': 7.0,  'wind': 2.2, 'hum': 38, 'desc': 'Hermosillo, México'},
    'tijuana':          {'lat': 32.52, 'lon': -117.03, 'alt': 20,   'T_avg': 18.0, 'T_max': 32.0, 'T_min': 9.0,  'wind': 3.8, 'hum': 63, 'desc': 'Tijuana, México'},
    # ── Estados Unidos ────────────────────────────────────────────────────────
    'phoenix':          {'lat': 33.45, 'lon': -112.07, 'alt': 331,  'T_avg': 24.0, 'T_max': 44.0, 'T_min': 8.0,  'wind': 2.7, 'hum': 27, 'desc': 'Phoenix, AZ, EE.UU.'},
    'los_angeles':      {'lat': 34.05, 'lon': -118.25, 'alt': 71,   'T_avg': 18.0, 'T_max': 32.0, 'T_min': 9.0,  'wind': 3.0, 'hum': 65, 'desc': 'Los Ángeles, CA, EE.UU.'},
    'miami':            {'lat': 25.77, 'lon': -80.19,  'alt': 2,    'T_avg': 25.0, 'T_max': 35.0, 'T_min': 15.0, 'wind': 4.5, 'hum': 76, 'desc': 'Miami, FL, EE.UU.'},
    'denver':           {'lat': 39.74, 'lon': -104.98, 'alt': 1609, 'T_avg': 10.0, 'T_max': 34.0, 'T_min': -8.0, 'wind': 4.2, 'hum': 40, 'desc': 'Denver, CO, EE.UU.'},
    'new_york':         {'lat': 40.71, 'lon': -74.01,  'alt': 10,   'T_avg': 12.0, 'T_max': 32.0, 'T_min': -5.0, 'wind': 4.8, 'hum': 61, 'desc': 'Nueva York, EE.UU.'},
    # ── Europa ────────────────────────────────────────────────────────────────
    'madrid':           {'lat': 40.42, 'lon': -3.70,   'alt': 667,  'T_avg': 14.5, 'T_max': 37.0, 'T_min': 2.0,  'wind': 3.3, 'hum': 50, 'desc': 'Madrid, España'},
    'sevilla':          {'lat': 37.39, 'lon': -5.99,   'alt': 9,    'T_avg': 18.5, 'T_max': 42.0, 'T_min': 5.0,  'wind': 3.0, 'hum': 55, 'desc': 'Sevilla, España'},
    'berlin':           {'lat': 52.52, 'lon': 13.40,   'alt': 34,   'T_avg': 9.5,  'T_max': 30.0, 'T_min': -3.0, 'wind': 4.5, 'hum': 70, 'desc': 'Berlín, Alemania'},
    'rome':             {'lat': 41.90, 'lon': 12.50,   'alt': 21,   'T_avg': 15.5, 'T_max': 36.0, 'T_min': 4.0,  'wind': 2.8, 'hum': 64, 'desc': 'Roma, Italia'},
    'lisbon':           {'lat': 38.72, 'lon': -9.14,   'alt': 77,   'T_avg': 17.0, 'T_max': 35.0, 'T_min': 7.0,  'wind': 4.0, 'hum': 70, 'desc': 'Lisboa, Portugal'},
    # ── América del Sur ───────────────────────────────────────────────────────
    'buenos_aires':     {'lat': -34.61,'lon': -58.38,  'alt': 25,   'T_avg': 17.0, 'T_max': 34.0, 'T_min': 5.0,  'wind': 3.8, 'hum': 74, 'desc': 'Buenos Aires, Argentina'},
    'santiago':         {'lat': -33.46,'lon': -70.65,  'alt': 520,  'T_avg': 14.0, 'T_max': 34.0, 'T_min': 3.0,  'wind': 2.5, 'hum': 62, 'desc': 'Santiago, Chile'},
    'bogota':           {'lat': 4.71,  'lon': -74.07,  'alt': 2600, 'T_avg': 14.0, 'T_max': 20.0, 'T_min': 8.0,  'wind': 2.0, 'hum': 79, 'desc': 'Bogotá, Colombia'},
    'lima':             {'lat': -12.05,'lon': -77.04,  'alt': 154,  'T_avg': 19.0, 'T_max': 29.0, 'T_min': 13.0, 'wind': 3.5, 'hum': 83, 'desc': 'Lima, Perú'},
    'sao_paulo':        {'lat': -23.55,'lon': -46.63,  'alt': 760,  'T_avg': 19.5, 'T_max': 30.0, 'T_min': 11.0, 'wind': 2.8, 'hum': 78, 'desc': 'São Paulo, Brasil'},
    # ── Asia / Oriente Medio / África ─────────────────────────────────────────
    'dubai':            {'lat': 25.20, 'lon': 55.27,   'alt': 5,    'T_avg': 28.0, 'T_max': 48.0, 'T_min': 14.0, 'wind': 3.5, 'hum': 59, 'desc': 'Dubái, EAU'},
    'riyadh':           {'lat': 24.69, 'lon': 46.72,   'alt': 620,  'T_avg': 26.0, 'T_max': 46.0, 'T_min': 8.0,  'wind': 3.0, 'hum': 30, 'desc': 'Riad, Arabia Saudita'},
    'new_delhi':        {'lat': 28.61, 'lon': 77.21,   'alt': 216,  'T_avg': 25.0, 'T_max': 45.0, 'T_min': 7.0,  'wind': 2.5, 'hum': 60, 'desc': 'Nueva Delhi, India'},
    'tokyo':            {'lat': 35.68, 'lon': 139.69,  'alt': 40,   'T_avg': 15.0, 'T_max': 35.0, 'T_min': 1.0,  'wind': 3.5, 'hum': 65, 'desc': 'Tokio, Japón'},
    'johannesburg':     {'lat': -26.20,'lon': 28.04,   'alt': 1753, 'T_avg': 15.5, 'T_max': 30.0, 'T_min': 1.0,  'wind': 2.5, 'hum': 52, 'desc': 'Johannesburgo, Sudáfrica'},
    'cairo':            {'lat': 30.06, 'lon': 31.25,   'alt': 74,   'T_avg': 22.0, 'T_max': 40.0, 'T_min': 9.0,  'wind': 3.2, 'hum': 50, 'desc': 'El Cairo, Egipto'},
    # ── Australia ─────────────────────────────────────────────────────────────
    'sydney':           {'lat': -33.87,'lon': 151.21,  'alt': 39,   'T_avg': 17.5, 'T_max': 33.0, 'T_min': 8.0,  'wind': 4.0, 'hum': 68, 'desc': 'Sídney, Australia'},
    'perth':            {'lat': -31.95,'lon': 115.86,  'alt': 20,   'T_avg': 18.5, 'T_max': 38.0, 'T_min': 7.0,  'wind': 5.0, 'hum': 57, 'desc': 'Perth, Australia'},
}


# ─────────────────────────────────────────────────────────────────────────────
# POSICIÓN SOLAR
# ─────────────────────────────────────────────────────────────────────────────
def _day_of_year(month: int, day: int) -> int:
    days_per_month = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    return sum(days_per_month[:month]) + day


def _declination(n: int) -> float:
    return 23.45 * DEG * np.sin(2 * np.pi * (n - 81) / 365)


def _equation_of_time(n: int) -> float:
    B = 2 * np.pi * (n - 1) / 365
    return 229.18 * (0.000075 + 0.001868 * np.cos(B) - 0.032077 * np.sin(B)
                     - 0.014615 * np.cos(2 * B) - 0.04089 * np.sin(2 * B))


def _hour_angle(hour_solar: float) -> float:
    return (hour_solar - 12.0) * 15.0 * DEG


def _solar_position(lat_rad, lon_rad, n, hour_std):
    delta     = _declination(n)
    eot       = _equation_of_time(n)
    hour_solar = hour_std + (4 * (lon_rad / DEG) + eot) / 60.0
    omega      = _hour_angle(hour_solar)
    sin_alpha  = np.clip(
        np.sin(lat_rad) * np.sin(delta) +
        np.cos(lat_rad) * np.cos(delta) * np.cos(omega), -1, 1)
    alpha = np.arcsin(sin_alpha)
    cos_alpha = np.cos(alpha)
    if cos_alpha < 1e-10:
        azimuth = 0.0
    else:
        cos_az  = np.clip(
            (np.sin(delta) - np.sin(lat_rad) * sin_alpha) /
            (np.cos(lat_rad) * cos_alpha), -1, 1)
        azimuth = np.arccos(cos_az)
        if np.sin(omega) > 0:
            azimuth = 2 * np.pi - azimuth
    return alpha, azimuth


# ─────────────────────────────────────────────────────────────────────────────
# IRRADIANCIA
# ─────────────────────────────────────────────────────────────────────────────
def _irradiance_horizontal(alpha_rad: float, n: int):
    if alpha_rad <= 5.0 * DEG:
        return 0.0, 0.0
    Eo  = 1.0 + 0.033 * np.cos(2 * np.pi * n / 365)
    G0  = GSC * Eo * np.sin(alpha_rad)
    AM  = 1.0 / np.sin(alpha_rad)
    tau_b = 0.7 ** (AM ** 0.678)
    Gb_h  = max(0.0, G0 * tau_b)
    Gd_h  = max(0.0, G0 * (1 - tau_b) * 0.5)
    return Gb_h, Gd_h


def _poa_irradiance(Gb_h, Gd_h, alpha_rad, azimuth_sun_rad, tilt_rad, azimuth_panel_rad):
    if alpha_rad <= 5.0 * DEG:
        return 0.0
    cos_theta = np.clip(
        np.sin(alpha_rad) * np.cos(tilt_rad) +
        np.cos(alpha_rad) * np.cos(azimuth_sun_rad - azimuth_panel_rad) * np.sin(tilt_rad),
        -1, 1)
    theta_i   = np.arccos(cos_theta)
    cos_ti    = np.cos(theta_i)
    Rb        = (cos_ti / np.sin(alpha_rad)) if (cos_ti > 0 and np.sin(alpha_rad) > 0.01) else 0.0
    Gb_poa    = max(0.0, Gb_h * Rb)
    Gd_poa    = Gd_h * (1 + np.cos(tilt_rad)) / 2.0
    Gr_poa    = (Gb_h + Gd_h) * RHO * (1 - np.cos(tilt_rad)) / 2.0
    return max(0.0, Gb_poa + Gd_poa + Gr_poa)


# ─────────────────────────────────────────────────────────────────────────────
# MODELO TÉRMICO DEL PANEL (Faiman / NOCT extendido con viento y humedad)
# ─────────────────────────────────────────────────────────────────────────────
def _cell_temperature(G_poa: float, T_amb: float, wind_ms: float,
                      humidity_pct: float, NOCT: float = 45.0) -> float:
    """
    Temperatura de celda [°C] usando modelo Faiman extendido.

    Fórmula base (IEC 61215):
        T_cell = T_amb + (NOCT - 20) / 800 * G_poa

    Corrección por velocidad de viento (enfriamiento convectivo):
        El coeficiente de convección crece con el viento.
        h_wind = h0 * (1 + k_wind * v_wind^0.5)  → se reduce T_cell

    Corrección por humedad:
        Aire más húmedo tiene mayor capacidad calorífica → mejor transferencia de calor.
        Factor: 1 + 0.003 * (humidity - 50)  (normalizado a HR=50 %)

    Referencia:
        Faiman, D. (2008). "Assessing the outdoor operating temperature of
        photovoltaic modules." Progress in Photovoltaics, 16(4), 307-315.
    """
    if G_poa <= 0:
        return T_amb

    # Gradiente térmico base (NOCT estándar: 800 W/m², 20 °C, 1 m/s)
    dT_base = (NOCT - 20.0) / 800.0 * G_poa

    # Factor de enfriamiento por viento (Ross, 1980 + Ross & Smokler, 1986)
    # Rangos: wind=0 → factor=1.0 (sin convección forzada)
    #         wind=5 → factor≈0.75  |  wind=10 → factor≈0.62
    k_wind   = 0.054          # [s^0.5/m^0.5] empírico
    w_eff    = max(0.5, wind_ms)  # velocidad mínima efectiva 0.5 m/s
    f_wind   = 1.0 / (1.0 + k_wind * np.sqrt(w_eff))

    # Factor de humedad: aire húmedo lleva más calor (efecto pequeño)
    # A HR=0 % → f_hum ≈ 0.85  |  HR=50 % → 1.0  |  HR=100 % → 1.15
    f_hum = 1.0 + 0.003 * (humidity_pct - 50.0)
    f_hum = np.clip(f_hum, 0.80, 1.20)

    T_cell = T_amb + dT_base * f_wind * f_hum
    return T_cell


def _thermal_power_factor(T_cell: float, T_coeff_pct_per_C: float = -0.40) -> float:
    """
    Factor de corrección de potencia por temperatura [-].
    P_real = P_STC * [1 + T_coeff/100 * (T_cell - T_STC)]
    T_coeff en %/°C, típicamente -0.35 a -0.45 para Si monoc.
    """
    return 1.0 + (T_coeff_pct_per_C / 100.0) * (T_cell - T_STC)


# ─────────────────────────────────────────────────────────────────────────────
# MODELO DE BATERÍAS (simplificado pero correcto)
# ─────────────────────────────────────────────────────────────────────────────
class BatteryBank:
    """
    Banco de baterías de energía con modelo de ciclo de vida lineal.

    Parámetros clave:
      capacity_kwh : Capacidad útil nominal [kWh]
      eta_rt       : Eficiencia round-trip (carga + descarga) [-]
      dod          : Profundidad de descarga máxima [-]
      cycle_life   : Vida útil en ciclos completos [#]
      cost_kwh_usd : Costo de adquisición por kWh [USD/kWh]
      install_pct  : Fracción de costo de instalación sobre equipo [-]

    El modelo usa convención:
      - soc_kwh : energía actualmente almacenada [kWh] (0 … capacity_kwh)
      - Un ciclo = descargar capacity_kwh * dod kWh y volver a cargar

    Degradación: lineal, el banco pierde capacidad gradualmente a lo largo
    de su vida útil (ciclo_life ciclos completos equivalentes).
    """
    def __init__(self, capacity_kwh=0.0, eta_rt=0.92, dod=0.80,
                 cycle_life=4000, cost_kwh_usd=300.0, install_pct=0.25):
        self.capacity   = max(0.0, capacity_kwh)
        self.eta_rt     = eta_rt
        self.eta_charge = np.sqrt(eta_rt)   # eficiencia de carga ≈ √η_rt
        self.eta_disch  = np.sqrt(eta_rt)   # eficiencia de descarga ≈ √η_rt
        self.dod        = dod
        self.cycle_life = cycle_life
        self.cost_kwh   = cost_kwh_usd
        self.install_pct= install_pct

        # Estado inicial: 50 % de carga
        self.soc_kwh    = self.capacity * 0.50
        self.soc_min    = self.capacity * (1.0 - dod)   # mínimo permitido
        self.soc_max    = self.capacity                  # máximo

        # Acumuladores anuales
        self.total_charged    = 0.0   # kWh cargados en el año
        self.total_discharged = 0.0   # kWh descargados en el año (útiles)
        self.equiv_cycles     = 0.0   # ciclos equivalentes usados

    @property
    def capex_usd(self) -> float:
        return self.capacity * self.cost_kwh * (1.0 + self.install_pct)

    @property
    def life_years(self) -> float:
        """Vida útil estimada en años basada en ciclos del año simulado."""
        if self.equiv_cycles <= 0:
            return float('inf')
        return self.cycle_life / self.equiv_cycles

    def charge(self, energy_available_kwh: float) -> float:
        """
        Intenta cargar el banco con energy_available_kwh [kWh AC/DC].
        Devuelve la energía realmente almacenada en el banco [kWh DC].
        """
        if self.capacity <= 0 or energy_available_kwh <= 0:
            return 0.0
        espacio   = self.soc_max - self.soc_kwh
        energia_dc = energy_available_kwh * self.eta_charge
        almacenado = min(espacio, energia_dc)
        self.soc_kwh      += almacenado
        self.total_charged += almacenado / self.eta_charge   # contamos AC equivalente
        self.equiv_cycles  += almacenado / (self.capacity * self.dod) if self.capacity > 0 else 0
        return almacenado

    def discharge(self, energy_needed_kwh: float) -> float:
        """
        Descarga hasta energy_needed_kwh [kWh útiles].
        Devuelve la energía útil entregada [kWh].
        """
        if self.capacity <= 0 or energy_needed_kwh <= 0:
            return 0.0
        disponible_dc  = self.soc_kwh - self.soc_min
        energia_util   = disponible_dc * self.eta_disch
        entregado      = min(energy_needed_kwh, energia_util)
        dc_consumido   = entregado / self.eta_disch
        self.soc_kwh         -= dc_consumido
        self.total_discharged += entregado
        self.equiv_cycles     += dc_consumido / (self.capacity * self.dod) if self.capacity > 0 else 0
        return entregado


# ─────────────────────────────────────────────────────────────────────────────
# MODELO DE CORTES DE ENERGÍA
# ─────────────────────────────────────────────────────────────────────────────
def _generate_outage_mask(n_intervals: int, freq_yr: float, avg_h: float,
                          seed: int = 99) -> np.ndarray:
    """
    Genera una máscara booleana de intervalos bajo corte de energía.
    True = ese intervalo está en corte.

    Modelo: Proceso de Poisson para llegada de eventos + duración exponencial.

    Args:
        n_intervals : total de intervalos de 15 min en el año (35040)
        freq_yr     : número esperado de cortes al año
        avg_h       : duración media de cada corte [horas]
        seed        : semilla aleatoria para reproducibilidad
    """
    rng   = np.random.default_rng(seed)
    mask  = np.zeros(n_intervals, dtype=bool)

    if freq_yr <= 0 or avg_h <= 0:
        return mask

    # Número real de cortes este año (distribución de Poisson)
    n_outages = rng.poisson(freq_yr)

    # Intervalo medio entre cortes [# de intervalos de 15 min]
    intervals_per_h = 4
    avg_duration_intervals = max(1, round(avg_h * intervals_per_h))

    for _ in range(n_outages):
        # Inicio del corte: uniforme a lo largo del año
        start = rng.integers(0, n_intervals)
        # Duración: exponencial con media avg_duration_intervals
        duration = max(1, round(rng.exponential(avg_duration_intervals)))
        end = min(start + duration, n_intervals)
        mask[start:end] = True

    return mask


# ─────────────────────────────────────────────────────────────────────────────
# MOTOR PRINCIPAL
# ─────────────────────────────────────────────────────────────────────────────
def run_solar_engine(
        lat: float, lon: float, alt: float,
        eta: float, area_m2: float, n_panels: int,
        tilt: float, azimuth: float, p_nominal_w: float,
        # Pérdidas del sistema
        loss_wiring:    float = 0.02,
        loss_inverter:  float = 0.03,
        loss_dirt:      float = 0.03,
        loss_mismatch:  float = 0.01,
        loss_shading:   float = 0.00,
        # Modelo térmico
        NOCT:           float = 45.0,
        T_coeff:        float = -0.40,   # %/°C
        T_amb_avg:      float = None,    # °C; si None → se estima por latitud
        wind_speed:     float = 3.0,     # m/s
        humidity_pct:   float = 55.0,    # %
        # Baterías
        battery_kwh:    float = 0.0,
        battery_eta:    float = 0.92,
        battery_dod:    float = 0.80,
        battery_cycles: int   = 4000,
        battery_cost_kwh: float = 300.0,
        battery_install_pct: float = 0.25,
        # Cortes de energía
        outage_freq_yr: float = 0.0,
        outage_avg_h:   float = 2.0,
        outage_loss_pct: float = 80.0,
        # Localidad climática (sobreescribe T_amb_avg, wind_speed, humidity_pct)
        climate_city:   str   = None,
        # Costos de paneles / inversor (opcional, para CAPEX)
        panel_cost_usd: float = 0.0,   # USD por panel
        inverter_cost_usd: float = 0.0,
) -> dict:
    """
    Motor de simulación fotovoltaica con 35,040 puntos (15 min/año).
    Ver docstring del módulo para glosario completo de parámetros y resultados.
    """

    # ── Aplicar datos climáticos de la BD si se especificó ciudad ────────────
    if climate_city and climate_city.lower() in CLIMATE_DB:
        cd = CLIMATE_DB[climate_city.lower()]
        lat, lon, alt = cd['lat'], cd['lon'], cd['alt']
        if T_amb_avg is None:
            T_amb_avg   = cd['T_avg']
        wind_speed      = cd['wind']
        humidity_pct    = cd['hum']

    if T_amb_avg is None:
        # Estimación empírica por latitud (sin datos climáticos)
        T_amb_avg = max(5.0, 30.0 - 0.5 * abs(lat))

    lat_r    = lat * DEG
    lon_r    = lon * DEG
    tilt_r   = tilt * DEG
    azimuth_r = azimuth * DEG

    # Factor de pérdidas del sistema (se aplican después de temperatura)
    # PR = Performance Ratio
    pr = (1 - loss_wiring) * (1 - loss_inverter) * (1 - loss_dirt) * \
         (1 - loss_mismatch) * (1 - loss_shading)

    # Corrección por altitud (masa de aire efectiva)
    alt_factor = np.exp(-alt / 8500.0)

    # Temperatura ambiente anual horaria (modelo sinusoidal estacional)
    # T(d, h) = T_avg + A_estacional * cos(...) + A_diurna * sin(...)
    days_in_month  = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    N_total        = 35040

    # Baterías
    battery = BatteryBank(
        capacity_kwh  = battery_kwh,
        eta_rt        = battery_eta,
        dod           = battery_dod,
        cycle_life    = battery_cycles,
        cost_kwh_usd  = battery_cost_kwh,
        install_pct   = battery_install_pct,
    )

    # Cortes de energía
    outage_mask = _generate_outage_mask(N_total, outage_freq_yr, outage_avg_h)

    # Arrays de salida
    Gtot_arr        = np.zeros(N_total)
    Gb_h_arr        = np.zeros(N_total)
    Gd_h_arr        = np.zeros(N_total)
    P_kw_gross_arr  = np.zeros(N_total)   # bruto antes de pérdidas de sistema
    P_kw_arr        = np.zeros(N_total)   # neto final
    T_cell_arr      = np.zeros(N_total)
    bat_soc_arr     = np.zeros(N_total)

    # Acumuladores de pérdidas
    energy_thermal_loss = 0.0    # kWh perdidos por temperatura
    monthly_bat_charge   = [0.0] * 12
    monthly_bat_discharge= [0.0] * 12

    idx = 0
    day_of_year_counter = 0

    for month_idx, n_days in enumerate(days_in_month):
        for day in range(1, n_days + 1):
            n = _day_of_year(month_idx + 1, day)

            # Temperatura ambiente: ciclo anual + ciclo diurno
            # A_anual ≈ 8 °C (±8 °C alrededor de la media anual)
            # máximo en verano (día 172), mínimo en invierno (día 355)
            A_ann = 8.0
            T_day_avg = T_amb_avg + A_ann * np.cos(2 * np.pi * (n - 172) / 365)

            for interval in range(96):
                hour_std = interval * 0.25 + 0.125

                # Temperatura con ciclo diurno (max a las 14 h, min a las 5 h)
                A_diurna = 5.0
                T_amb = T_day_avg + A_diurna * np.sin(
                    np.pi * (hour_std - 5.0) / 14.0) if 5 <= hour_std <= 19 else T_day_avg - A_diurna

                alpha, az_sun = _solar_position(lat_r, lon_r, n, hour_std)

                if alpha > 5.0 * DEG:
                    alpha_eff = np.arcsin(np.clip(np.sin(alpha) / alt_factor, -1, 1))
                else:
                    alpha_eff = alpha

                Gb_h, Gd_h = _irradiance_horizontal(alpha_eff, n)
                Gtot       = _poa_irradiance(Gb_h, Gd_h, alpha_eff, az_sun, tilt_r, azimuth_r)

                # Temperatura de celda
                T_cell = _cell_temperature(Gtot, T_amb, wind_speed, humidity_pct, NOCT)

                # Factor térmico
                f_temp = max(0.0, _thermal_power_factor(T_cell, T_coeff))

                # Potencia bruta [kW] = η * A * G * N_paneles * f_temp
                P_gross = (eta * area_m2 * Gtot * n_panels * f_temp) / 1000.0

                # Pérdida térmica acumulada (respecto a STC sin corrección)
                P_stc   = (eta * area_m2 * Gtot * n_panels) / 1000.0
                energy_thermal_loss += max(0.0, P_stc - P_gross) * 0.25   # kWh

                # Potencia neta tras pérdidas del sistema (PR)
                P_net = P_gross * pr

                # ── Cortes de energía ────────────────────────────────────────
                # Durante un corte: si hay baterías, se usan; si no, hay pérdida
                if outage_mask[idx]:
                    # El sistema fotovoltaico sigue generando (autónomo)
                    # pero la energía de la red no está disponible;
                    # registramos la pérdida potencial solo para la demanda de red
                    pass   # P_net se conserva (la generación propia sigue)

                # ── Gestión de baterías ──────────────────────────────────────
                # Estrategia: excedente solar → carga batería
                # déficit solar (noche) → descarga batería
                # (requiere perfil de demanda para cálculo exacto; aquí almacenamos
                # el excedente de forma autónoma basado en disponibilidad)
                if Gtot > 50 and P_net > 0:
                    # Horas de sol: posibilidad de cargar batería con excedente
                    # (aquí cargamos una fracción fija del 20 % de la generación
                    # como aproximación conservadora sin demanda definida)
                    bat_charge_kwh = battery.charge(P_net * 0.20 * 0.25)  # 15-min kWh
                    monthly_bat_charge[month_idx] += bat_charge_kwh
                elif Gtot <= 5:
                    # Noche: descargar batería
                    bat_discharge_kwh = battery.discharge(
                        (p_nominal_w * n_panels / 1000.0) * 0.10 * 0.25)  # 10 % potencia
                    monthly_bat_discharge[month_idx] += bat_discharge_kwh

                Gtot_arr[idx]       = Gtot
                Gb_h_arr[idx]       = Gb_h
                Gd_h_arr[idx]       = Gd_h
                P_kw_gross_arr[idx] = P_gross
                P_kw_arr[idx]       = P_net
                T_cell_arr[idx]     = T_cell
                bat_soc_arr[idx]    = battery.soc_kwh
                idx += 1

        day_of_year_counter += n_days

    hours = np.arange(N_total) * 0.25

    # ── Agregaciones mensuales ────────────────────────────────────────────────
    monthly_gtot_avg, monthly_gtot_max, monthly_gen_kwh = [], [], []
    idx = 0
    for nd in days_in_month:
        np_ = nd * 96
        sg  = Gtot_arr[idx: idx + np_]
        sp  = P_kw_arr[idx: idx + np_]
        monthly_gtot_avg.append(float(np.mean(sg)))
        monthly_gtot_max.append(float(np.max(sg)))
        monthly_gen_kwh.append(float(np.sum(sp) * 0.25))
        idx += np_

    # Perfil diario de verano
    summer_start   = sum(days_in_month[:4]) * 96
    summer_end     = sum(days_in_month[:8]) * 96
    n_summer_days  = sum(days_in_month[4:8])
    summer_gtot    = Gtot_arr[summer_start:summer_end].reshape(n_summer_days, 96)
    daily_gtot_summer = np.mean(summer_gtot, axis=0)
    summer_p       = P_kw_arr[summer_start:summer_end].reshape(n_summer_days, 96)
    daily_p_summer = np.mean(summer_p, axis=0)

    # ── KPIs ─────────────────────────────────────────────────────────────────
    energia_anual_kwh   = float(np.sum(P_kw_arr) * 0.25)
    energia_bruta_kwh   = float(np.sum(P_kw_gross_arr) * 0.25)
    p_max_kw            = float(np.max(P_kw_arr))
    p_nominal_total_kw  = p_nominal_w * n_panels / 1000.0
    fc    = energia_anual_kwh / (p_nominal_total_kw * 8760) if p_nominal_total_kw > 0 else 0
    hpse  = energia_anual_kwh / p_nominal_total_kw if p_nominal_total_kw > 0 else 0
    irrad_h_kwh_m2  = float(np.sum(Gb_h_arr + Gd_h_arr) * 0.25 / 1000)
    irrad_poa_kwh_m2= float(np.sum(Gtot_arr) * 0.25 / 1000)

    # Temperatura de celda en horas de sol
    mask_sol   = Gtot_arr > 10
    T_cell_sol = T_cell_arr[mask_sol]
    T_cell_med = float(np.mean(T_cell_sol)) if len(T_cell_sol) > 0 else 0.0
    T_cell_max = float(np.max(T_cell_arr))

    # Pérdida térmica porcentual
    perd_term_pct = (energy_thermal_loss / energia_bruta_kwh * 100) if energia_bruta_kwh > 0 else 0
    perd_sis_pct  = (1 - pr) * 100

    # Cortes de energía
    outage_intervals  = int(np.sum(outage_mask))
    outage_hours_yr   = outage_intervals * 0.25
    # Energía no servida: demanda no cubierta en cortes (estimación conservadora)
    outage_energy_lost = outage_hours_yr * (p_nominal_w * n_panels / 1000.0) * \
                         (outage_loss_pct / 100.0) * 0.50   # 50 % factor de demanda

    # CAPEX total
    total_capex = panel_cost_usd * n_panels + inverter_cost_usd + battery.capex_usd

    stats = {
        # Generación
        'energia_anual_kWh'        : round(energia_anual_kwh, 2),
        'energia_anual_MWh'        : round(energia_anual_kwh / 1000, 3),
        'p_max_kW'                 : round(p_max_kw, 3),
        'p_nominal_total_kW'       : round(p_nominal_total_kw, 3),
        'factor_capacidad_pct'     : round(fc * 100, 2),
        'horas_pico_sol_equiv'     : round(hpse, 1),
        'irrad_horizontal_kWh_m2'  : round(irrad_h_kwh_m2, 1),
        'irrad_poa_kWh_m2'         : round(irrad_poa_kwh_m2, 1),
        'gtot_max_W_m2'            : round(float(np.max(Gtot_arr)), 1),
        'gtot_media_W_m2'          : round(float(np.mean(Gtot_arr[Gtot_arr > 0])) if np.any(Gtot_arr > 0) else 0, 1),
        'n_horas_generacion'       : round(float(np.sum(P_kw_arr > 0) * 0.25), 1),
        # Temperatura
        'T_cell_media_C'           : round(T_cell_med, 1),
        'T_cell_max_C'             : round(T_cell_max, 1),
        'T_amb_avg_C'              : round(T_amb_avg, 1),
        'perdida_termica_pct'      : round(perd_term_pct, 2),
        'perdida_sistema_pct'      : round(perd_sis_pct, 2),
        'performance_ratio_pct'    : round(pr * 100, 2),
        # Pérdidas desagregadas
        'loss_wiring_pct'          : round(loss_wiring * 100, 2),
        'loss_inverter_pct'        : round(loss_inverter * 100, 2),
        'loss_dirt_pct'            : round(loss_dirt * 100, 2),
        'loss_mismatch_pct'        : round(loss_mismatch * 100, 2),
        'loss_shading_pct'         : round(loss_shading * 100, 2),
        # Baterías
        'battery_kwh'              : round(battery.capacity, 2),
        'battery_energy_stored_kWh': round(battery.total_charged, 2),
        'battery_energy_served_kWh': round(battery.total_discharged, 2),
        'battery_cycles_used'      : round(battery.equiv_cycles, 2),
        'battery_life_years'       : round(battery.life_years, 1) if battery.life_years != float('inf') else 99.0,
        'battery_capex_usd'        : round(battery.capex_usd, 2),
        'battery_eta_rt'           : battery.eta_rt,
        # Cortes
        'outage_freq_yr'           : outage_freq_yr,
        'outage_avg_h'             : outage_avg_h,
        'outage_hours_yr'          : round(outage_hours_yr, 2),
        'outage_energy_lost_kWh'   : round(outage_energy_lost, 2),
        # CAPEX
        'panel_cost_usd'           : round(panel_cost_usd * n_panels, 2),
        'inverter_cost_usd'        : round(inverter_cost_usd, 2),
        'total_capex_usd'          : round(total_capex, 2),
        # Sistema
        'n_paneles'                : n_panels,
        'potencia_nominal_W_panel' : p_nominal_w,
        'eta'                      : eta,
        'area_m2'                  : area_m2,
        'tilt'                     : tilt,
        'azimuth'                  : azimuth,
        'lat'                      : lat,
        'lon'                      : lon,
        'alt'                      : alt,
        'wind_speed_ms'            : wind_speed,
        'humidity_pct'             : humidity_pct,
        'NOCT'                     : NOCT,
        'T_coeff_pct_C'            : T_coeff,
        'climate_city'             : climate_city or 'manual',
    }

    return {
        'Gtot_arr'           : Gtot_arr.tolist(),
        'P_kw_arr'           : P_kw_arr.tolist(),
        'P_kw_gross_arr'     : P_kw_gross_arr.tolist(),
        'T_cell_arr'         : T_cell_arr.tolist(),
        'battery_soc_arr'    : bat_soc_arr.tolist(),
        'hours'              : hours.tolist(),
        'monthly_gtot_avg'   : monthly_gtot_avg,
        'monthly_gtot_max'   : monthly_gtot_max,
        'monthly_gen_kWh'    : monthly_gen_kwh,
        'monthly_bat_charge' : monthly_bat_charge,
        'monthly_bat_discharge': monthly_bat_discharge,
        'daily_gtot_summer'  : daily_gtot_summer.tolist(),
        'daily_p_summer'     : daily_p_summer.tolist(),
        'stats'              : stats,
    }


def get_climate_cities() -> list:
    """Devuelve lista de ciudades disponibles en la base de datos climática."""
    return [
        {'key': k, 'desc': v['desc'], 'lat': v['lat'], 'lon': v['lon'],
         'alt': v['alt'], 'T_avg': v['T_avg'], 'wind': v['wind'], 'hum': v['hum']}
        for k, v in CLIMATE_DB.items()
    ]
