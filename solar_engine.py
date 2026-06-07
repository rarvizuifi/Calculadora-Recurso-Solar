"""
solar_engine.py
Motor de Jensen simplificado para cálculo de irradiancia en plano inclinado (POA)
y generación fotovoltaica anual con resolución quinceminutal (15 min).

Modelo matemático:
  - Posición solar: declinación + ángulo horario + altura solar + azimut
  - DNI: modelo Jensen  Gb = G0 * 0.7^(AM^0.678)
  - POA: modelo isotrópico (Hottel-Woertz)
  - Temperatura de operación: modelo NOCT
  - T_amb: perfil horario histórico 10 años vía NASA POWER API (promedio típico)
  - Generación: η_ref(T) × η_sys × A × Gtot × N_paneles
"""

import numpy as np
import urllib.request
import urllib.parse
import json
import io
from typing import Optional


# ─────────────────────────────────────────────────────────────────────────────
# CONSTANTES
# ─────────────────────────────────────────────────────────────────────────────
GSC = 1367.0       # Constante solar [W/m²]
RHO = 0.20         # Albedo del suelo (reflectividad)
DEG = np.pi / 180.0  # Factor conversión grados → radianes

# Constantes del modelo NOCT
G_NOCT    = 800.0   # Irradiancia de referencia NOCT [W/m²]
T_NOCT_AMB = 20.0   # Temperatura ambiente de referencia NOCT [°C]
T_STC     = 25.0    # Temperatura de referencia STC [°C]

# NASA POWER
POWER_BASE_URL       = "https://power.larc.nasa.gov/api/temporal/hourly/point"
POWER_T_AMB_FALLBACK = 25.0   # [°C] — fallback si la API falla
POWER_YEARS          = list(range(2014, 2026))  # 12 años: 2014–2025


# ─────────────────────────────────────────────────────────────────────────────
# NASA POWER — PERFIL TÍPICO DE T_AMB
# ─────────────────────────────────────────────────────────────────────────────
def fetch_tambiente_profile(lat: float, lon: float,
                             years: list = None,
                             fallback_c: float = POWER_T_AMB_FALLBACK) -> np.ndarray:
    """
    Descarga datos horarios de temperatura ambiente (T2M) de NASA POWER
    para los años indicados y construye un perfil típico anual con
    resolución horaria (8,760 valores), promediando los años disponibles.

    El perfil se interpola luego a 15 min en run_solar_engine.

    Args:
        lat        : Latitud [°]
        lon        : Longitud [°]
        years      : Lista de años a promediar (default: 2014–2025)
        fallback_c : Valor constante [°C] a usar si la API falla

    Returns:
        np.ndarray de shape (8760,) con T_amb [°C] hora por hora (año típico).
        Si falla la descarga, retorna un array constante de fallback_c.
    """
    if years is None:
        years = POWER_YEARS

    # Acumulador: dict {(mes, dia, hora): [lista de valores °C]}
    # Para el año típico usamos 365 días × 24 h = 8,760 slots
    # Indexamos por (doy_0indexed * 24 + hora) donde doy va 0..364
    hourly_accum = [[] for _ in range(8760)]

    days_in_month = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

    for year in years:
        start = f"{year}0101"
        end   = f"{year}1231"

        params = urllib.parse.urlencode({
            "parameters" : "T2M",
            "community"  : "SB",
            "longitude"  : lon,
            "latitude"   : lat,
            "start"      : start,
            "end"        : end,
            "format"     : "JSON",
            "time-standard": "LST",
        })
        url = f"{POWER_BASE_URL}?{params}"

        try:
            with urllib.request.urlopen(url, timeout=30) as resp:
                data = json.loads(resp.read().decode())

            # NASA POWER devuelve: data["properties"]["parameter"]["T2M"]
            # con claves tipo "20140101_0100" (YYYYMMDD_HHMM en LST)
            t2m_dict = data["properties"]["parameter"]["T2M"]

            # Iterar sobre los 8,760 slots del año (365 días × 24 h)
            # Ignoramos el 29 de febrero si el año es bisiesto (simplificación)
            slot = 0
            for m_idx, n_days in enumerate(days_in_month):
                for d in range(1, n_days + 1):
                    for h in range(24):
                        key = f"{year}{m_idx+1:02d}{d:02d}_{h:02d}00"
                        val = t2m_dict.get(key)
                        # NASA POWER usa -999 como valor inválido
                        if val is not None and val > -900:
                            hourly_accum[slot].append(float(val))
                        slot += 1

        except Exception:
            # Si un año falla, simplemente se omite del promedio
            continue

    # Construir perfil promedio; donde no hay datos usar fallback
    profile = np.full(8760, fallback_c)
    for i, vals in enumerate(hourly_accum):
        if vals:
            profile[i] = float(np.mean(vals))

    return profile


def _interpolate_hourly_to_15min(hourly_profile: np.ndarray) -> np.ndarray:
    """
    Interpola linealmente un perfil horario (8,760 puntos) a resolución
    quinceminutal (35,040 puntos).

    Cada hora h se mapea a los intervalos [h*4, h*4+1, h*4+2, h*4+3].
    La interpolación es lineal entre el centro de una hora y el siguiente.

    Args:
        hourly_profile : np.ndarray de shape (8760,)

    Returns:
        np.ndarray de shape (35040,)
    """
    # Repetir el primer valor al final para cerrar el ciclo anual
    extended = np.append(hourly_profile, hourly_profile[0])

    # Interpolación lineal: 4 sub-intervalos por hora
    # El centro del sub-intervalo i dentro de la hora h está en h + (i+0.5)/4
    result = np.zeros(35040)
    for h in range(8760):
        t0 = extended[h]
        t1 = extended[h + 1]
        for q in range(4):
            # Fracción dentro de la hora: 0.125, 0.375, 0.625, 0.875
            frac = (q + 0.5) / 4.0
            result[h * 4 + q] = t0 + frac * (t1 - t0)

    return result


# ─────────────────────────────────────────────────────────────────────────────
# FUNCIONES DE POSICIÓN SOLAR
# ─────────────────────────────────────────────────────────────────────────────
def _day_of_year(month: int, day: int) -> int:
    """Retorna el número de día del año (1-365)."""
    days_per_month = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    return sum(days_per_month[:month]) + day


def _declination(n: int) -> float:
    """Declinación solar δ [radianes] para el día n del año."""
    return 23.45 * DEG * np.sin(2 * np.pi * (n - 81) / 365)


def _equation_of_time(n: int) -> float:
    """Ecuación del tiempo [minutos]."""
    B = 2 * np.pi * (n - 1) / 365
    return 229.18 * (0.000075 + 0.001868 * np.cos(B) - 0.032077 * np.sin(B)
                     - 0.014615 * np.cos(2 * B) - 0.04089 * np.sin(2 * B))


def _hour_angle(hour_solar: float) -> float:
    """Ángulo horario ω [radianes]. hour_solar en horas decimales (12.0 = mediodía)."""
    return (hour_solar - 12.0) * 15.0 * DEG


def _solar_position(lat_rad: float, lon_rad: float, n: int, hour_std: float,
                    lon_ref_rad: float = 0.0) -> tuple:
    """
    Calcula la posición solar para una latitud/longitud/día/hora dados.

    Returns:
        (alpha_rad, azimuth_rad) — altura solar y azimut solar [rad]
        alpha_rad < 0 → sol bajo el horizonte
    """
    delta = _declination(n)
    eot   = _equation_of_time(n)
    hour_solar = hour_std + (4 * (lon_rad - lon_ref_rad) / DEG + eot) / 60.0
    omega = _hour_angle(hour_solar)

    sin_alpha = (np.sin(lat_rad) * np.sin(delta) +
                 np.cos(lat_rad) * np.cos(delta) * np.cos(omega))
    sin_alpha = np.clip(sin_alpha, -1.0, 1.0)
    alpha = np.arcsin(sin_alpha)

    cos_alpha = np.cos(alpha)
    if cos_alpha < 1e-10:
        azimuth = 0.0
    else:
        cos_az = (np.sin(delta) - np.sin(lat_rad) * sin_alpha) / (np.cos(lat_rad) * cos_alpha)
        cos_az  = np.clip(cos_az, -1.0, 1.0)
        azimuth = np.arccos(cos_az)
        if np.sin(omega) > 0:
            azimuth = 2 * np.pi - azimuth

    return alpha, azimuth


# ─────────────────────────────────────────────────────────────────────────────
# MODELO NOCT — TEMPERATURA DE OPERACIÓN
# ─────────────────────────────────────────────────────────────────────────────
def _cell_temperature(t_amb: float, G_T: float, noct: float) -> float:
    """
    Temperatura de operación de la celda [°C] usando modelo NOCT.

    T_op = T_amb + (NOCT - 20) * (G_T / 800)
    """
    return t_amb + (noct - T_NOCT_AMB) * (G_T / G_NOCT)


def _eta_temperature(eta_ref: float, chi: float, t_op: float) -> float:
    """
    Eficiencia del panel corregida por temperatura de operación.

    η_T = η_ref · [1 − χ · (T_op − T_ref)]

    Args:
        eta_ref : Eficiencia en STC [fracción]
        chi     : Coeficiente de temperatura de potencia [1/°C]
                  (usuario ingresa %/°C; dividir entre 100 antes de llamar)
        t_op    : Temperatura de operación de la celda [°C]
    """
    eta_t = eta_ref * (1.0 - chi * (t_op - T_STC))
    return max(0.0, eta_t)


# ─────────────────────────────────────────────────────────────────────────────
# CÁLCULO DE IRRADIANCIA
# ─────────────────────────────────────────────────────────────────────────────
def _air_mass(alpha_rad: float) -> Optional[float]:
    """Masa de aire AM (modelo Kasten simplificado). Válido para α > 5°."""
    if alpha_rad < 5.0 * DEG:
        return None
    return 1.0 / np.sin(alpha_rad)


def _irradiance_horizontal(alpha_rad: float, n: int) -> tuple:
    """Calcula irradiancia directa y difusa en plano horizontal. Returns (Gb_h, Gd_h) [W/m²]."""
    if alpha_rad <= 5.0 * DEG:
        return 0.0, 0.0

    Eo  = 1.0 + 0.033 * np.cos(2 * np.pi * n / 365)
    G0  = GSC * Eo * np.sin(alpha_rad)
    AM  = _air_mass(alpha_rad)
    if AM is None:
        return 0.0, 0.0

    tau_b = 0.7 ** (AM ** 0.678)
    Gb_h  = G0 * tau_b
    Gd_h  = G0 * (1 - tau_b) * 0.5

    return max(0.0, Gb_h), max(0.0, Gd_h)


def _angle_of_incidence(alpha_rad: float, azimuth_sun_rad: float,
                         tilt_rad: float, azimuth_panel_rad: float) -> float:
    """Ángulo de incidencia sobre el plano inclinado [rad]."""
    cos_theta = (np.sin(alpha_rad) * np.cos(tilt_rad) +
                 np.cos(alpha_rad) * np.cos(azimuth_sun_rad - azimuth_panel_rad) * np.sin(tilt_rad))
    return np.arccos(np.clip(cos_theta, -1.0, 1.0))


def _poa_irradiance(Gb_h: float, Gd_h: float, alpha_rad: float,
                    azimuth_sun_rad: float, tilt_rad: float,
                    azimuth_panel_rad: float) -> float:
    """Irradiancia total en el Plano de Arreglo (POA) [W/m²]. Modelo isotrópico."""
    if alpha_rad <= 5.0 * DEG:
        return 0.0

    theta_i     = _angle_of_incidence(alpha_rad, azimuth_sun_rad, tilt_rad, azimuth_panel_rad)
    cos_theta_i = np.cos(theta_i)

    if cos_theta_i <= 0:
        Gb_poa = 0.0
    else:
        Rb     = cos_theta_i / np.sin(alpha_rad) if np.sin(alpha_rad) > 0.01 else 0
        Gb_poa = Gb_h * Rb

    Gd_poa = Gd_h * (1.0 + np.cos(tilt_rad)) / 2.0
    Gr_poa = (Gb_h + Gd_h) * RHO * (1.0 - np.cos(tilt_rad)) / 2.0

    return max(0.0, Gb_poa + Gd_poa + Gr_poa)


# ─────────────────────────────────────────────────────────────────────────────
# MOTOR PRINCIPAL
# ─────────────────────────────────────────────────────────────────────────────
def run_solar_engine(lat: float, lon: float, alt: float,
                     eta_ref: float, area_m2: float, n_panels: int,
                     tilt: float, azimuth: float,
                     p_nominal_w: float,
                     eta_sys: float = 0.75,
                     noct: float = 45.0,
                     chi: float = 0.40,
                     t_amb: float = None,
                     t_amb_profile: np.ndarray = None) -> dict:
    """
    Motor de Jensen completo para un año (35,040 intervalos de 15 min).

    Args:
        lat            : Latitud [°] positivo Norte
        lon            : Longitud [°] positivo Este
        alt            : Altitud [m]
        eta_ref        : Eficiencia STC [fracción]. Se deduce de p_nominal_w/area_m2.
        area_m2        : Área de un panel [m²]
        n_panels       : Número de paneles
        tilt           : Ángulo de inclinación [°]
        azimuth        : Azimut del panel [°] 0=N, 180=S
        p_nominal_w    : Potencia nominal STC [W]
        eta_sys        : Eficiencia del sistema [fracción] (default 0.75)
        noct           : NOCT del datasheet [°C] (default 45.0)
        chi            : Coeficiente de temperatura de potencia [%/°C] (default 0.40)
                         Se convierte internamente a 1/°C dividiendo entre 100.
        t_amb          : Temperatura ambiente escalar [°C]. Solo se usa si
                         t_amb_profile es None. Si ambos son None, usa 25.0.
        t_amb_profile  : Perfil quinceminutal (35,040,) o horario (8,760,) de T_amb [°C].
                         Si se pasa, tiene prioridad sobre t_amb escalar.
                         Obtener con fetch_tambiente_profile() + _interpolate_hourly_to_15min().

    Returns:
        dict con arrays y estadísticas
    """
    lat_r     = lat * DEG
    lon_r     = lon * DEG
    tilt_r    = tilt * DEG
    azimuth_r = azimuth * DEG

    # chi: %/°C → 1/°C
    chi_per_c = chi / 100.0

    # eta_ref: deducir si no se proporciona
    eta_ref = p_nominal_w / (1000.0 * area_m2)

    # Perfil de T_amb a 35,040 puntos
    if t_amb_profile is not None:
        if len(t_amb_profile) == 8760:
            t_amb_15min = _interpolate_hourly_to_15min(t_amb_profile)
        elif len(t_amb_profile) == 35040:
            t_amb_15min = np.asarray(t_amb_profile)
        else:
            raise ValueError(f"t_amb_profile debe tener 8760 o 35040 elementos, "
                             f"recibido: {len(t_amb_profile)}")
        t_amb_scalar = float(np.mean(t_amb_15min))
    else:
        # Fallback escalar
        t_amb_scalar = float(t_amb) if t_amb is not None else POWER_T_AMB_FALLBACK
        t_amb_15min  = np.full(35040, t_amb_scalar)

    # Corrección por altitud
    alt_factor = np.exp(-alt / 8500.0)

    # Arrays de salida
    N          = 35040
    Gtot_arr   = np.zeros(N)
    Gb_h_arr   = np.zeros(N)
    Gd_h_arr   = np.zeros(N)
    P_kw_arr   = np.zeros(N)
    T_op_arr   = np.zeros(N)
    eta_T_arr  = np.zeros(N)

    days_in_month = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

    idx = 0
    for month_idx, n_days in enumerate(days_in_month):
        for day in range(1, n_days + 1):
            n = _day_of_year(month_idx + 1, day)
            for interval in range(96):
                hour_std = interval * 0.25 + 0.125
                alpha, az_sun = _solar_position(lat_r, lon_r, n, hour_std)

                if alpha > 5.0 * DEG:
                    alpha_eff = np.arcsin(np.clip(np.sin(alpha) / alt_factor, -1, 1))
                else:
                    alpha_eff = alpha

                Gb_h, Gd_h = _irradiance_horizontal(alpha_eff, n)
                Gtot       = _poa_irradiance(Gb_h, Gd_h, alpha_eff, az_sun, tilt_r, azimuth_r)

                # T_amb del perfil quinceminutal
                t_a  = t_amb_15min[idx]

                # Modelo NOCT
                t_op = _cell_temperature(t_a, Gtot, noct)

                # Eficiencia corregida por temperatura
                eta_T = _eta_temperature(eta_ref, chi_per_c, t_op)

                # Generación [kW]
                P_kw = (eta_T * eta_sys * area_m2 * Gtot * n_panels) / 1000.0

                Gtot_arr[idx]  = Gtot
                Gb_h_arr[idx]  = Gb_h
                Gd_h_arr[idx]  = Gd_h
                P_kw_arr[idx]  = P_kw
                T_op_arr[idx]  = t_op
                eta_T_arr[idx] = eta_T
                idx += 1

    # ── Agregaciones ──────────────────────────────────────────────────────────
    monthly_gtot_avg, monthly_gtot_max, monthly_gen_kwh = [], [], []
    idx = 0
    for n_days in days_in_month:
        n_pts = n_days * 96
        seg_g = Gtot_arr[idx: idx + n_pts]
        seg_p = P_kw_arr[idx: idx + n_pts]
        monthly_gtot_avg.append(float(np.mean(seg_g)))
        monthly_gtot_max.append(float(np.max(seg_g)))
        monthly_gen_kwh.append(float(np.sum(seg_p) * 0.25))
        idx += n_pts

    summer_start  = sum(days_in_month[:4]) * 96
    summer_end    = sum(days_in_month[:8]) * 96
    n_summer_days = sum(days_in_month[4:8])

    daily_gtot_summer = np.mean(Gtot_arr[summer_start:summer_end].reshape(n_summer_days, 96), axis=0)
    daily_p_summer    = np.mean(P_kw_arr[summer_start:summer_end].reshape(n_summer_days, 96), axis=0)

    energia_anual_kwh  = float(np.sum(P_kw_arr) * 0.25)
    p_max_kw           = float(np.max(P_kw_arr))
    p_nominal_total_kw = p_nominal_w * n_panels / 1000.0
    fc   = energia_anual_kwh / (p_nominal_total_kw * 8760) if p_nominal_total_kw > 0 else 0
    hpse = energia_anual_kwh / p_nominal_total_kw if p_nominal_total_kw > 0 else 0

    irrad_horizontal_kwh_m2 = float(np.sum(Gb_h_arr + Gd_h_arr) * 0.25 / 1000)
    irrad_poa_kwh_m2        = float(np.sum(Gtot_arr) * 0.25 / 1000)

    mask_sol = Gtot_arr > 0
    t_op_media  = float(np.mean(T_op_arr[mask_sol]))  if np.any(mask_sol) else t_amb_scalar
    t_op_max    = float(np.max(T_op_arr))
    eta_T_media = float(np.mean(eta_T_arr[mask_sol])) if np.any(mask_sol) else eta_ref

    stats = {
        'energia_anual_kWh'       : energia_anual_kwh,
        'energia_anual_MWh'       : energia_anual_kwh / 1000,
        'p_max_kW'                : p_max_kw,
        'p_nominal_total_kW'      : p_nominal_total_kw,
        'factor_capacidad_pct'    : fc * 100,
        'horas_pico_sol_equiv'    : hpse,
        'irrad_horizontal_kWh_m2' : irrad_horizontal_kwh_m2,
        'irrad_poa_kwh_m2'        : irrad_poa_kwh_m2,
        'gtot_max_W_m2'           : float(np.max(Gtot_arr)),
        'gtot_media_W_m2'         : float(np.mean(Gtot_arr[mask_sol])) if np.any(mask_sol) else 0,
        'n_horas_generacion'      : float(np.sum(P_kw_arr > 0) * 0.25),
        # Parámetros del sistema
        'n_paneles'               : n_panels,
        'potencia_nominal_W_panel': p_nominal_w,
        'eta_ref'                 : eta_ref,
        'eta_sys'                 : eta_sys,
        'area_m2'                 : area_m2,
        'tilt'                    : tilt,
        'azimuth'                 : azimuth,
        'lat'                     : lat,
        'lon'                     : lon,
        'alt'                     : alt,
        # Parámetros térmicos
        'noct'                    : noct,
        'chi_pct_por_c'           : chi,
        't_amb_media_C'           : t_amb_scalar,
        't_op_media_C'            : t_op_media,
        't_op_max_C'              : t_op_max,
        'eta_T_media'             : eta_T_media,
        'fuente_t_amb'            : 'NASA POWER (perfil típico)' if t_amb_profile is not None else 'constante',
    }

    return {
        'Gtot_arr'          : Gtot_arr.tolist(),
        'P_kw_arr'          : P_kw_arr.tolist(),
        'T_op_arr'          : T_op_arr.tolist(),
        'hours'             : (np.arange(N) * 0.25).tolist(),
        'monthly_gtot_avg'  : monthly_gtot_avg,
        'monthly_gtot_max'  : monthly_gtot_max,
        'monthly_gen_kWh'   : monthly_gen_kwh,
        'daily_gtot_summer' : daily_gtot_summer.tolist(),
        'daily_p_summer'    : daily_p_summer.tolist(),
        'stats'             : stats,
    }