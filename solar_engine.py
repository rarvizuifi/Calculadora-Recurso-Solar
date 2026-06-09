"""
solar_engine.py  v2.1
=====================
Motor Jensen mejorado para cálculo de irradiancia en plano inclinado (POA)
y generación fotovoltaica anual con resolución quinceminutal (15 min).

NUEVO en v2.1 (sobre v2.0 de Eugenio):
  - eta_ref se deduce del datasheet: eta_ref = P_nominal / (1000 * area_m2)
  - chi [%/°C]: coeficiente de temperatura, se convierte internamente a 1/°C
  - η_T = η_ref · [1 − χ · (T_cell − 25)] — eficiencia corregida por temperatura
  - T_amb: perfil horario histórico 10 años vía NASA POWER API (promedio típico)
    interpolado a 15 min; si falla → perfil sinusoidal estimado por latitud

Original v2.0 de Eugenio:
  - Pérdidas térmicas del panel (modelo Faiman / NOCT extendido con viento y humedad)
  - Almacenamiento con baterías (ciclos, desgaste, CAPEX)
  - Base de datos climática simplificada (~30 ciudades)
  - Modelado de cortes de energía (frecuencia, duración, pérdidas)
  - Todas las pérdidas del sistema (cableado, inversor, suciedad, mismatch…)
"""

import numpy as np
import urllib.request
import urllib.parse
import json
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
# ─────────────────────────────────────────────────────────────────────────────
CLIMATE_DB = {
    'monterrey':        {'lat': 25.67, 'lon': -100.31, 'alt': 538,  'T_avg': 22.5, 'T_max': 38.0, 'T_min': 8.0,  'wind': 3.2, 'hum': 58, 'desc': 'Monterrey, México'},
    'guadalajara':      {'lat': 20.66, 'lon': -103.35, 'alt': 1567, 'T_avg': 20.0, 'T_max': 33.0, 'T_min': 8.0,  'wind': 2.5, 'hum': 55, 'desc': 'Guadalajara, México'},
    'cdmx':             {'lat': 19.43, 'lon': -99.13,  'alt': 2240, 'T_avg': 16.0, 'T_max': 28.0, 'T_min': 5.0,  'wind': 2.0, 'hum': 62, 'desc': 'Ciudad de México'},
    'merida':           {'lat': 20.97, 'lon': -89.62,  'alt': 9,    'T_avg': 27.0, 'T_max': 40.0, 'T_min': 16.0, 'wind': 3.5, 'hum': 72, 'desc': 'Mérida, México'},
    'chihuahua':        {'lat': 28.63, 'lon': -106.07, 'alt': 1428, 'T_avg': 18.0, 'T_max': 38.0, 'T_min': -2.0, 'wind': 2.8, 'hum': 40, 'desc': 'Chihuahua, México'},
    'hermosillo':       {'lat': 29.07, 'lon': -110.96, 'alt': 237,  'T_avg': 24.0, 'T_max': 44.0, 'T_min': 7.0,  'wind': 2.2, 'hum': 38, 'desc': 'Hermosillo, México'},
    'tijuana':          {'lat': 32.52, 'lon': -117.03, 'alt': 20,   'T_avg': 18.0, 'T_max': 32.0, 'T_min': 9.0,  'wind': 3.8, 'hum': 63, 'desc': 'Tijuana, México'},
    'phoenix':          {'lat': 33.45, 'lon': -112.07, 'alt': 331,  'T_avg': 24.0, 'T_max': 44.0, 'T_min': 8.0,  'wind': 2.7, 'hum': 27, 'desc': 'Phoenix, AZ, EE.UU.'},
    'los_angeles':      {'lat': 34.05, 'lon': -118.25, 'alt': 71,   'T_avg': 18.0, 'T_max': 32.0, 'T_min': 9.0,  'wind': 3.0, 'hum': 65, 'desc': 'Los Ángeles, CA, EE.UU.'},
    'miami':            {'lat': 25.77, 'lon': -80.19,  'alt': 2,    'T_avg': 25.0, 'T_max': 35.0, 'T_min': 15.0, 'wind': 4.5, 'hum': 76, 'desc': 'Miami, FL, EE.UU.'},
    'denver':           {'lat': 39.74, 'lon': -104.98, 'alt': 1609, 'T_avg': 10.0, 'T_max': 34.0, 'T_min': -8.0, 'wind': 4.2, 'hum': 40, 'desc': 'Denver, CO, EE.UU.'},
    'new_york':         {'lat': 40.71, 'lon': -74.01,  'alt': 10,   'T_avg': 12.0, 'T_max': 32.0, 'T_min': -5.0, 'wind': 4.8, 'hum': 61, 'desc': 'Nueva York, EE.UU.'},
    'madrid':           {'lat': 40.42, 'lon': -3.70,   'alt': 667,  'T_avg': 14.5, 'T_max': 37.0, 'T_min': 2.0,  'wind': 3.3, 'hum': 50, 'desc': 'Madrid, España'},
    'sevilla':          {'lat': 37.39, 'lon': -5.99,   'alt': 9,    'T_avg': 18.5, 'T_max': 42.0, 'T_min': 5.0,  'wind': 3.0, 'hum': 55, 'desc': 'Sevilla, España'},
    'berlin':           {'lat': 52.52, 'lon': 13.40,   'alt': 34,   'T_avg': 9.5,  'T_max': 30.0, 'T_min': -3.0, 'wind': 4.5, 'hum': 70, 'desc': 'Berlín, Alemania'},
    'rome':             {'lat': 41.90, 'lon': 12.50,   'alt': 21,   'T_avg': 15.5, 'T_max': 36.0, 'T_min': 4.0,  'wind': 2.8, 'hum': 64, 'desc': 'Roma, Italia'},
    'lisbon':           {'lat': 38.72, 'lon': -9.14,   'alt': 77,   'T_avg': 17.0, 'T_max': 35.0, 'T_min': 7.0,  'wind': 4.0, 'hum': 70, 'desc': 'Lisboa, Portugal'},
    'buenos_aires':     {'lat': -34.61,'lon': -58.38,  'alt': 25,   'T_avg': 17.0, 'T_max': 34.0, 'T_min': 5.0,  'wind': 3.8, 'hum': 74, 'desc': 'Buenos Aires, Argentina'},
    'santiago':         {'lat': -33.46,'lon': -70.65,  'alt': 520,  'T_avg': 14.0, 'T_max': 34.0, 'T_min': 3.0,  'wind': 2.5, 'hum': 62, 'desc': 'Santiago, Chile'},
    'bogota':           {'lat': 4.71,  'lon': -74.07,  'alt': 2600, 'T_avg': 14.0, 'T_max': 20.0, 'T_min': 8.0,  'wind': 2.0, 'hum': 79, 'desc': 'Bogotá, Colombia'},
    'lima':             {'lat': -12.05,'lon': -77.04,  'alt': 154,  'T_avg': 19.0, 'T_max': 29.0, 'T_min': 13.0, 'wind': 3.5, 'hum': 83, 'desc': 'Lima, Perú'},
    'sao_paulo':        {'lat': -23.55,'lon': -46.63,  'alt': 760,  'T_avg': 19.5, 'T_max': 30.0, 'T_min': 11.0, 'wind': 2.8, 'hum': 78, 'desc': 'São Paulo, Brasil'},
    'dubai':            {'lat': 25.20, 'lon': 55.27,   'alt': 5,    'T_avg': 28.0, 'T_max': 48.0, 'T_min': 14.0, 'wind': 3.5, 'hum': 59, 'desc': 'Dubái, EAU'},
    'riyadh':           {'lat': 24.69, 'lon': 46.72,   'alt': 620,  'T_avg': 26.0, 'T_max': 46.0, 'T_min': 8.0,  'wind': 3.0, 'hum': 30, 'desc': 'Riad, Arabia Saudita'},
    'new_delhi':        {'lat': 28.61, 'lon': 77.21,   'alt': 216,  'T_avg': 25.0, 'T_max': 45.0, 'T_min': 7.0,  'wind': 2.5, 'hum': 60, 'desc': 'Nueva Delhi, India'},
    'tokyo':            {'lat': 35.68, 'lon': 139.69,  'alt': 40,   'T_avg': 15.0, 'T_max': 35.0, 'T_min': 1.0,  'wind': 3.5, 'hum': 65, 'desc': 'Tokio, Japón'},
    'johannesburg':     {'lat': -26.20,'lon': 28.04,   'alt': 1753, 'T_avg': 15.5, 'T_max': 30.0, 'T_min': 1.0,  'wind': 2.5, 'hum': 52, 'desc': 'Johannesburgo, Sudáfrica'},
    'cairo':            {'lat': 30.06, 'lon': 31.25,   'alt': 74,   'T_avg': 22.0, 'T_max': 40.0, 'T_min': 9.0,  'wind': 3.2, 'hum': 50, 'desc': 'El Cairo, Egipto'},
    'sydney':           {'lat': -33.87,'lon': 151.21,  'alt': 39,   'T_avg': 17.5, 'T_max': 33.0, 'T_min': 8.0,  'wind': 4.0, 'hum': 68, 'desc': 'Sídney, Australia'},
    'perth':            {'lat': -31.95,'lon': 115.86,  'alt': 20,   'T_avg': 18.5, 'T_max': 38.0, 'T_min': 7.0,  'wind': 5.0, 'hum': 57, 'desc': 'Perth, Australia'},
}

# ─────────────────────────────────────────────────────────────────────────────
# NASA POWER — PERFIL TÍPICO DE T_AMB  (NUEVO en v2.1 — aportación de Lucio)
# ─────────────────────────────────────────────────────────────────────────────
POWER_BASE_URL       = "https://power.larc.nasa.gov/api/temporal/hourly/point"
POWER_T_AMB_FALLBACK = 25.0
POWER_YEARS          = list(range(2014, 2024))  # 10 años: 2014–2023


def fetch_tambiente_profile(lat: float, lon: float,
                             years: list = None,
                             fallback_c: float = POWER_T_AMB_FALLBACK) -> np.ndarray:
    """
    Descarga datos horarios de T2M de NASA POWER para N años y devuelve
    un perfil típico anual (8 760 h), promediando los años disponibles.
    Si la API falla, devuelve array constante de fallback_c.
    """
    if years is None:
        years = POWER_YEARS

    hourly_accum  = [[] for _ in range(8760)]
    days_in_month = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

    for year in years:
        params = urllib.parse.urlencode({
            "parameters": "T2M", "community": "SB",
            "longitude": lon, "latitude": lat,
            "start": f"{year}0101", "end": f"{year}1231",
            "format": "JSON", "time-standard": "LST",
        })
        try:
            with urllib.request.urlopen(
                    f"{POWER_BASE_URL}?{params}", timeout=30) as r:
                t2m = json.loads(r.read().decode()
                                 )["properties"]["parameter"]["T2M"]
            slot = 0
            for m_idx, nd in enumerate(days_in_month):
                for d in range(1, nd + 1):
                    for h in range(24):
                        key = f"{year}{m_idx+1:02d}{d:02d}_{h:02d}00"
                        v   = t2m.get(key)
                        if v is not None and v > -900:
                            hourly_accum[slot].append(float(v))
                        slot += 1
        except Exception:
            continue

    profile = np.full(8760, fallback_c)
    for i, vals in enumerate(hourly_accum):
        if vals:
            profile[i] = float(np.mean(vals))
    return profile


def _interpolate_hourly_to_15min(hourly_profile: np.ndarray) -> np.ndarray:
    """Interpola linealmente 8 760 → 35 040 puntos."""
    extended = np.append(hourly_profile, hourly_profile[0])
    result   = np.zeros(35040)
    for h in range(8760):
        t0, t1 = extended[h], extended[h + 1]
        for q in range(4):
            result[h * 4 + q] = t0 + (q + 0.5) / 4.0 * (t1 - t0)
    return result


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


def _solar_position(lat_rad: float, lon_rad: float, n: int, hour_std: float) -> tuple:
    delta      = _declination(n)
    eot        = _equation_of_time(n)
    hour_solar = hour_std + (4 * (lon_rad / DEG) + eot) / 60.0
    omega      = (hour_solar - 12.0) * 15.0 * DEG
    sin_alpha  = np.clip(
        np.sin(lat_rad) * np.sin(delta) +
        np.cos(lat_rad) * np.cos(delta) * np.cos(omega), -1, 1)
    alpha = np.arcsin(sin_alpha)
    cos_alpha = np.cos(alpha)
    if cos_alpha < 1e-10:
        return alpha, 0.0
    cos_az = np.clip(
        (np.sin(delta) - np.sin(lat_rad) * sin_alpha) /
        (np.cos(lat_rad) * cos_alpha), -1, 1)
    azimuth = np.arccos(cos_az)
    if np.sin(omega) > 0:
        azimuth = 2 * np.pi - azimuth
    return alpha, azimuth


# ─────────────────────────────────────────────────────────────────────────────
# MODELO TÉRMICO DEL PANEL — Faiman / NOCT extendido (de Eugenio, sin cambios)
# ─────────────────────────────────────────────────────────────────────────────
def _cell_temperature(G_poa: float, T_amb: float, wind_ms: float,
                      humidity_pct: float, NOCT: float = 45.0) -> float:
    """
    T_cell = T_amb + (NOCT-20)/800 * G_poa * f_wind * f_hum

    f_wind: enfriamiento convectivo (Ross+Faiman)
    f_hum:  capacidad calorífica del aire según HR
    """
    if G_poa <= 0:
        return T_amb
    dT_base = (NOCT - 20.0) / 800.0 * G_poa
    w_eff   = max(0.5, wind_ms)
    f_wind  = 1.0 / (1.0 + 0.054 * np.sqrt(w_eff))
    f_hum   = np.clip(1.0 + 0.003 * (humidity_pct - 50.0), 0.80, 1.20)
    return T_amb + dT_base * f_wind * f_hum


def _thermal_power_factor(T_cell: float, T_coeff_pct_per_C: float = -0.40) -> float:
    """
    Factor de corrección de potencia por temperatura [-].
    NOTA: en v2.1 este factor ya NO se aplica directamente — se usa en su lugar
    la fórmula de Lucio: η_T = η_ref · [1 − χ · (T_cell − 25)], que es
    matemáticamente equivalente pero físicamente más transparente.
    Se conserva por compatibilidad con código externo que pueda usarla.
    """
    return 1.0 + (T_coeff_pct_per_C / 100.0) * (T_cell - T_STC)


# ─────────────────────────────────────────────────────────────────────────────
# IRRADIANCIA
# ─────────────────────────────────────────────────────────────────────────────
def _irradiance_horizontal(alpha_rad: float, n: int) -> tuple:
    if alpha_rad <= 5.0 * DEG:
        return 0.0, 0.0
    Eo  = 1.0 + 0.033 * np.cos(2 * np.pi * n / 365)
    G0  = GSC * Eo * np.sin(alpha_rad)
    AM  = 1.0 / np.sin(alpha_rad)
    tau_b = 0.7 ** (AM ** 0.678)
    return max(0.0, G0 * tau_b), max(0.0, G0 * (1 - tau_b) * 0.5)


def _poa_irradiance(Gb_h: float, Gd_h: float, alpha_rad: float,
                    azimuth_sun_rad: float, tilt_rad: float,
                    azimuth_panel_rad: float) -> float:
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
# MODELO DE BATERÍAS (de Eugenio, sin cambios)
# ─────────────────────────────────────────────────────────────────────────────
class BatteryBank:
    def __init__(self, capacity_kwh=0.0, eta_rt=0.92, dod=0.80,
                 cycle_life=4000, cost_kwh_usd=300.0, install_pct=0.25):
        self.capacity   = max(0.0, capacity_kwh)
        self.eta_rt     = eta_rt
        self.eta_charge = np.sqrt(eta_rt)
        self.eta_disch  = np.sqrt(eta_rt)
        self.dod        = dod
        self.cycle_life = cycle_life
        self.cost_kwh   = cost_kwh_usd
        self.install_pct= install_pct
        self.soc_kwh    = self.capacity * 0.50
        self.soc_min    = self.capacity * (1.0 - dod)
        self.soc_max    = self.capacity
        self.total_charged    = 0.0
        self.total_discharged = 0.0
        self.equiv_cycles     = 0.0

    @property
    def capex_usd(self) -> float:
        return self.capacity * self.cost_kwh * (1.0 + self.install_pct)

    @property
    def life_years(self) -> float:
        if self.equiv_cycles <= 0:
            return float('inf')
        return self.cycle_life / self.equiv_cycles

    def charge(self, energy_available_kwh: float) -> float:
        if self.capacity <= 0 or energy_available_kwh <= 0:
            return 0.0
        espacio    = self.soc_max - self.soc_kwh
        energia_dc = energy_available_kwh * self.eta_charge
        almacenado = min(espacio, energia_dc)
        self.soc_kwh      += almacenado
        self.total_charged += almacenado / self.eta_charge
        self.equiv_cycles  += almacenado / (self.capacity * self.dod) if self.capacity > 0 else 0
        return almacenado

    def discharge(self, energy_needed_kwh: float) -> float:
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
# MODELO DE CORTES DE ENERGÍA (de Eugenio, sin cambios)
# ─────────────────────────────────────────────────────────────────────────────
def _generate_outage_mask(n_intervals: int, freq_yr: float, avg_h: float,
                          seed: int = 99) -> np.ndarray:
    rng   = np.random.default_rng(seed)
    mask  = np.zeros(n_intervals, dtype=bool)
    if freq_yr <= 0 or avg_h <= 0:
        return mask
    n_outages = rng.poisson(freq_yr)
    avg_duration_intervals = max(1, round(avg_h * 4))
    for _ in range(n_outages):
        start    = rng.integers(0, n_intervals)
        duration = max(1, round(rng.exponential(avg_duration_intervals)))
        end      = min(start + duration, n_intervals)
        mask[start:end] = True
    return mask


# ─────────────────────────────────────────────────────────────────────────────
# MOTOR PRINCIPAL  v2.1
# ─────────────────────────────────────────────────────────────────────────────
def run_solar_engine(
        lat: float, lon: float, alt: float,
        eta_stc: float, area_m2: float, n_panels: int,
        tilt: float, azimuth: float, p_nominal_w: float,
        # Pérdidas del sistema
        loss_wiring:    float = 0.02,
        loss_inverter:  float = 0.03,
        loss_dirt:      float = 0.03,
        loss_mismatch:  float = 0.01,
        loss_shading:   float = 0.00,
        # Modelo térmico
        NOCT:           float = 45.0,
        chi:            float = 0.40,    # [%/°C] NUEVO v2.1 — reemplaza T_coeff
        wind_speed:     float = 3.0,
        humidity_pct:   float = 55.0,
        # T_amb: NASA POWER (perfil) tiene prioridad; si None → perfil sinusoidal
        t_amb_profile:  np.ndarray = None,   # NUEVO v2.1
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
        # Localidad climática
        climate_city:   str   = None,
        # Costos
        panel_cost_usd: float = 0.0,
        inverter_cost_usd: float = 0.0,
) -> dict:
    """
    Motor de simulación fotovoltaica con 35 040 puntos (15 min/año).

    Cambios v2.1 respecto a v2.0:
      - eta se ignora; eta_ref se deduce internamente: eta_ref = p_nominal_w / (1000 * area_m2)
      - chi [%/°C] reemplaza T_coeff: se convierte a 1/°C y se aplica como
        η_T = η_ref · [1 − χ · (T_cell − 25)]
      - t_amb_profile (opcional): perfil horario (8760) o quinceminutal (35040)
        de T_amb histórico desde NASA POWER. Si None → perfil sinusoidal por latitud.
    """

    # ── Ciudad climática ──────────────────────────────────────────────────────
    T_amb_avg = None
    if climate_city and climate_city.lower() in CLIMATE_DB:
        cd          = CLIMATE_DB[climate_city.lower()]
        lat, lon, alt = cd['lat'], cd['lon'], cd['alt']
        T_amb_avg   = cd['T_avg']
        wind_speed  = cd['wind']
        humidity_pct= cd['hum']

    if T_amb_avg is None:
        T_amb_avg = max(5.0, 30.0 - 0.5 * abs(lat))

    # ── eta_ref desde datasheet (NUEVO v2.1) ──────────────────────────────────
    if eta_stc is not None:
        eta_ref = eta_stc
    else:
        eta_ref = p_nominal_w / (1000.0 * area_m2)
    chi_per_c = chi / 100.0          # %/°C → 1/°C

    # ── Perfil T_amb (NUEVO v2.1) ─────────────────────────────────────────────
    if t_amb_profile is not None:
        if len(t_amb_profile) == 8760:
            t_amb_15min = _interpolate_hourly_to_15min(t_amb_profile)
        elif len(t_amb_profile) == 35040:
            t_amb_15min = np.asarray(t_amb_profile, dtype=float)
        else:
            raise ValueError(f"t_amb_profile debe tener 8760 o 35040 elementos, "
                             f"recibido: {len(t_amb_profile)}")
        fuente_t_amb = 'NASA POWER (perfil típico 10 años)'
    else:
        # Perfil sinusoidal estacional + diurno (comportamiento original v2.0)
        fuente_t_amb = 'perfil sinusoidal estimado por latitud'
        t_amb_15min  = None   # se calculará por intervalo dentro del loop

    # ── Performance Ratio del sistema ─────────────────────────────────────────
    pr = (1 - loss_wiring) * (1 - loss_inverter) * (1 - loss_dirt) * \
         (1 - loss_mismatch) * (1 - loss_shading)

    lat_r    = lat * DEG
    lon_r    = lon * DEG
    tilt_r   = tilt * DEG
    azimuth_r= azimuth * DEG
    alt_factor = np.exp(-alt / 8500.0)

    # ── Baterías y cortes ─────────────────────────────────────────────────────
    battery = BatteryBank(
        battery_kwh, battery_eta, battery_dod,
        battery_cycles, battery_cost_kwh, battery_install_pct,
    )
    outage_mask = _generate_outage_mask(35040, outage_freq_yr, outage_avg_h)

    # ── Arrays de salida ──────────────────────────────────────────────────────
    N_total         = 35040
    Gtot_arr        = np.zeros(N_total)
    Gb_h_arr        = np.zeros(N_total)
    Gd_h_arr        = np.zeros(N_total)
    P_kw_gross_arr  = np.zeros(N_total)
    P_kw_arr        = np.zeros(N_total)
    T_cell_arr      = np.zeros(N_total)
    bat_soc_arr     = np.zeros(N_total)

    energy_thermal_loss  = 0.0
    monthly_bat_charge   = [0.0] * 12
    monthly_bat_discharge= [0.0] * 12

    days_in_month = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    idx = 0

    for month_idx, n_days in enumerate(days_in_month):
        for day in range(1, n_days + 1):
            n = _day_of_year(month_idx + 1, day)

            # T_amb diaria promedio (solo para perfil sinusoidal)
            A_ann     = 8.0
            T_day_avg = T_amb_avg + A_ann * np.cos(2 * np.pi * (n - 172) / 365)

            for interval in range(96):
                hour_std = interval * 0.25 + 0.125

                # T_amb de este intervalo
                if t_amb_15min is not None:
                    T_amb = t_amb_15min[idx]
                else:
                    # Perfil sinusoidal diurno (original v2.0)
                    A_diurna = 5.0
                    T_amb = (T_day_avg + A_diurna * np.sin(np.pi * (hour_std - 5.0) / 14.0)
                             if 5 <= hour_std <= 19 else T_day_avg - A_diurna)

                alpha, az_sun = _solar_position(lat_r, lon_r, n, hour_std)

                if alpha > 5.0 * DEG:
                    alpha_eff = np.arcsin(np.clip(np.sin(alpha) / alt_factor, -1, 1))
                else:
                    alpha_eff = alpha

                Gb_h, Gd_h = _irradiance_horizontal(alpha_eff, n)
                Gtot       = _poa_irradiance(Gb_h, Gd_h, alpha_eff, az_sun, tilt_r, azimuth_r)

                # Temperatura de celda (Faiman extendido)
                T_cell = T_amb + (Gtot / 800.0) * (NOCT - 20.0) * (1.0 - 0.003 * humidity_pct) * max(0.1, 1.0 - 0.1 * wind_speed)

                # ── Eficiencia corregida por temperatura (NUEVO v2.1 — de Lucio) ──
                # η_T = η_ref · [1 − χ · (T_cell − T_STC)]
                eta_T  = max(0.0, eta_ref * (1.0 - chi_per_c * (T_cell - 25.0)))

                # Potencia bruta [kW]
                P_gross = (eta_T * area_m2 * Gtot * n_panels) / 1000.0

                # Pérdida térmica acumulada (vs STC sin corrección)
                P_stc   = (eta_ref * area_m2 * Gtot * n_panels) / 1000.0
                energy_thermal_loss += max(0.0, P_stc - P_gross) * 0.25

                # Potencia neta tras pérdidas del sistema (PR)
                P_net = P_gross * pr

                # Cortes de energía
                if outage_mask[idx]:
                    pass   # generación propia sigue; pérdida se registra en balance

                # Gestión de baterías
                if Gtot > 50 and P_net > 0:
                    bc = battery.charge(P_net * 0.20 * 0.25)
                    monthly_bat_charge[month_idx] += bc
                elif Gtot <= 5:
                    bd = battery.discharge(
                        (p_nominal_w * n_panels / 1000.0) * 0.10 * 0.25)
                    monthly_bat_discharge[month_idx] += bd

                Gtot_arr[idx]       = Gtot
                Gb_h_arr[idx]       = Gb_h
                Gd_h_arr[idx]       = Gd_h
                P_kw_gross_arr[idx] = P_gross
                P_kw_arr[idx]       = P_net
                T_cell_arr[idx]     = T_cell
                bat_soc_arr[idx]    = battery.soc_kwh
                idx += 1

    # ── Agregaciones ──────────────────────────────────────────────────────────
    hours = np.arange(N_total) * 0.25

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

    summer_start   = sum(days_in_month[:4]) * 96
    summer_end     = sum(days_in_month[:8]) * 96
    n_summer_days  = sum(days_in_month[4:8])
    summer_gtot    = Gtot_arr[summer_start:summer_end].reshape(n_summer_days, 96)
    daily_gtot_summer = np.mean(summer_gtot, axis=0)
    summer_p       = P_kw_arr[summer_start:summer_end].reshape(n_summer_days, 96)
    daily_p_summer = np.mean(summer_p, axis=0)

    # KPIs
    energia_anual_kwh   = float(np.sum(P_kw_arr) * 0.25)
    energia_bruta_kwh   = float(np.sum(P_kw_gross_arr) * 0.25)
    p_max_kw            = float(np.max(P_kw_arr))
    p_nominal_total_kw  = p_nominal_w * n_panels / 1000.0
    fc    = energia_anual_kwh / (p_nominal_total_kw * 8760) if p_nominal_total_kw > 0 else 0
    hpse  = energia_anual_kwh / p_nominal_total_kw if p_nominal_total_kw > 0 else 0
    irrad_h_kwh_m2   = float(np.sum(Gb_h_arr + Gd_h_arr) * 0.25 / 1000)
    irrad_poa_kwh_m2 = float(np.sum(Gtot_arr) * 0.25 / 1000)

    mask_sol   = Gtot_arr > 10
    T_cell_sol = T_cell_arr[mask_sol]
    T_cell_med = float(np.mean(T_cell_sol)) if len(T_cell_sol) > 0 else 0.0
    T_cell_max = float(np.max(T_cell_arr))

    perd_term_pct = (energy_thermal_loss / energia_bruta_kwh * 100) if energia_bruta_kwh > 0 else 0
    perd_sis_pct  = (1 - pr) * 100

    outage_intervals   = int(np.sum(outage_mask))
    outage_hours_yr    = outage_intervals * 0.25
    outage_energy_lost = outage_hours_yr * (p_nominal_w * n_panels / 1000.0) * \
                         (outage_loss_pct / 100.0) * 0.50

    total_capex = panel_cost_usd * n_panels + inverter_cost_usd + battery.capex_usd

    # T_amb media del perfil usado
    if t_amb_15min is not None:
        t_amb_avg_used = float(np.mean(t_amb_15min))
    else:
        t_amb_avg_used = T_amb_avg

    stats = {
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
        'T_cell_media_C'           : round(T_cell_med, 1),
        'T_cell_max_C'             : round(T_cell_max, 1),
        'T_amb_avg_C'              : round(t_amb_avg_used, 1),
        'perdida_termica_pct'      : round(perd_term_pct, 2),
        'perdida_sistema_pct'      : round(perd_sis_pct, 2),
        'performance_ratio_pct'    : round(pr * 100, 2),
        'loss_wiring_pct'          : round(loss_wiring * 100, 2),
        'loss_inverter_pct'        : round(loss_inverter * 100, 2),
        'loss_dirt_pct'            : round(loss_dirt * 100, 2),
        'loss_mismatch_pct'        : round(loss_mismatch * 100, 2),
        'loss_shading_pct'         : round(loss_shading * 100, 2),
        'battery_kwh'              : round(battery.capacity, 2),
        'battery_energy_stored_kWh': round(battery.total_charged, 2),
        'battery_energy_served_kWh': round(battery.total_discharged, 2),
        'battery_cycles_used'      : round(battery.equiv_cycles, 2),
        'battery_life_years'       : round(battery.life_years, 1) if battery.life_years != float('inf') else 99.0,
        'battery_capex_usd'        : round(battery.capex_usd, 2),
        'battery_eta_rt'           : battery.eta_rt,
        'outage_freq_yr'           : outage_freq_yr,
        'outage_avg_h'             : outage_avg_h,
        'outage_hours_yr'          : round(outage_hours_yr, 2),
        'outage_energy_lost_kWh'   : round(outage_energy_lost, 2),
        'panel_cost_usd'           : round(panel_cost_usd * n_panels, 2),
        'inverter_cost_usd'        : round(inverter_cost_usd, 2),
        'total_capex_usd'          : round(total_capex, 2),
        'n_paneles'                : n_panels,
        'potencia_nominal_W_panel' : p_nominal_w,
        'eta'                      : eta,           # guardado por compatibilidad
        'eta_ref'                  : round(eta_ref, 4),   # NUEVO v2.1
        'chi_pct_por_c'            : chi,           # NUEVO v2.1
        'area_m2'                  : area_m2,
        'tilt'                     : tilt,
        'azimuth'                  : azimuth,
        'lat'                      : lat,
        'lon'                      : lon,
        'alt'                      : alt,
        'wind_speed_ms'            : wind_speed,
        'humidity_pct'             : humidity_pct,
        'NOCT'                     : NOCT,
        'climate_city'             : climate_city or 'manual',
        'fuente_t_amb'             : fuente_t_amb,  # NUEVO v2.1
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