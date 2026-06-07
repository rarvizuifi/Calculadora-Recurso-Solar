"""
solar_engine.py
Motor de Jensen simplificado para cálculo de irradiancia en plano inclinado (POA)
y generación fotovoltaica anual con resolución quinceminutal (15 min).

Modelo matemático:
  - Posición solar: declinación + ángulo horario + altura solar + azimut
  - DNI: modelo Jensen  Gb = G0 * 0.7^(AM^0.678)
  - POA: modelo isotrópico (Hottel-Woertz)
  - Temperatura de operación: modelo NOCT
  - Generación: η_ref(T) × η_sys × A × Gtot × N_paneles
"""

import numpy as np
from typing import Optional


# ─────────────────────────────────────────────────────────────────────────────
# CONSTANTES
# ─────────────────────────────────────────────────────────────────────────────
GSC = 1367.0   # Constante solar [W/m²]
RHO = 0.20     # Albedo del suelo (reflectividad)
DEG = np.pi / 180.0  # Factor conversión grados → radianes

# Constantes del modelo NOCT
G_NOCT = 800.0   # Irradiancia de referencia NOCT [W/m²]
T_NOCT_AMB = 20.0  # Temperatura ambiente de referencia NOCT [°C]
T_STC = 25.0     # Temperatura de referencia STC [°C]


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
    eot = _equation_of_time(n)
    # Corrección por longitud y ecuación del tiempo
    hour_solar = hour_std + (4 * (lon_rad - lon_ref_rad) / DEG + eot) / 60.0
    omega = _hour_angle(hour_solar)

    # Altura solar
    sin_alpha = (np.sin(lat_rad) * np.sin(delta) +
                 np.cos(lat_rad) * np.cos(delta) * np.cos(omega))
    sin_alpha = np.clip(sin_alpha, -1.0, 1.0)
    alpha = np.arcsin(sin_alpha)

    # Azimut solar (medido desde el norte, positivo hacia el este)
    cos_alpha = np.cos(alpha)
    if cos_alpha < 1e-10:
        azimuth = 0.0
    else:
        cos_az = (np.sin(delta) - np.sin(lat_rad) * sin_alpha) / (np.cos(lat_rad) * cos_alpha)
        cos_az = np.clip(cos_az, -1.0, 1.0)
        azimuth = np.arccos(cos_az)
        if np.sin(omega) > 0:
            azimuth = 2 * np.pi - azimuth  # tarde → azimut oeste

    return alpha, azimuth


# ─────────────────────────────────────────────────────────────────────────────
# MODELO NOCT — TEMPERATURA DE OPERACIÓN
# ─────────────────────────────────────────────────────────────────────────────
def _cell_temperature(t_amb: float, G_T: float, noct: float) -> float:
    """
    Temperatura de operación de la celda [°C] usando modelo NOCT.

    T_op = T_amb + (NOCT - 20) * (G_T / 800)

    Args:
        t_amb : Temperatura ambiente [°C]
        G_T   : Irradiancia sobre el panel (POA) [W/m²]
        noct  : NOCT del datasheet [°C] (típicamente 44–48°C)

    Returns:
        Temperatura de operación de la celda [°C]
    """
    return t_amb + (noct - T_NOCT_AMB) * (G_T / G_NOCT)


def _eta_temperature(eta_ref: float, beta: float, t_op: float) -> float:
    """
    Eficiencia del panel corregida por temperatura de operación.

    η_T = η_ref · [1 − β · (T_op − T_ref)]

    Args:
        eta_ref : Eficiencia en STC [fracción]
        beta    : Coeficiente de temperatura de potencia [1/°C]
                  (el usuario lo ingresa en %/°C, debe dividirse entre 100 antes)
        t_op    : Temperatura de operación de la celda [°C]

    Returns:
        Eficiencia corregida por temperatura [fracción]
    """
    eta_t = eta_ref * (1.0 - beta * (t_op - T_STC))
    return max(0.0, eta_t)


# ─────────────────────────────────────────────────────────────────────────────
# CÁLCULO DE IRRADIANCIA
# ─────────────────────────────────────────────────────────────────────────────
def _air_mass(alpha_rad: float) -> float:
    """Masa de aire AM (modelo Kasten simplificado). Válido para α > 5°."""
    if alpha_rad < 5.0 * DEG:
        return None
    return 1.0 / np.sin(alpha_rad)


def _irradiance_horizontal(alpha_rad: float, n: int) -> tuple:
    """
    Calcula irradiancia directa y difusa en plano horizontal.

    Returns:
        (Gb_h, Gd_h) en [W/m²]
    """
    if alpha_rad <= 5.0 * DEG:
        return 0.0, 0.0

    # Corrección orbital
    Eo = 1.0 + 0.033 * np.cos(2 * np.pi * n / 365)
    G0 = GSC * Eo * np.sin(alpha_rad)

    AM = _air_mass(alpha_rad)
    if AM is None:
        return 0.0, 0.0

    # Jensen: transmitancia atmosférica directa
    tau_b = 0.7 ** (AM ** 0.678)

    Gb_h = G0 * tau_b          # Directa horizontal
    Gd_h = G0 * (1 - tau_b) * 0.5  # Difusa horizontal (isotrópica)

    return max(0.0, Gb_h), max(0.0, Gd_h)


def _angle_of_incidence(alpha_rad: float, azimuth_sun_rad: float,
                         tilt_rad: float, azimuth_panel_rad: float) -> float:
    """
    Ángulo de incidencia sobre el plano inclinado [rad].
    azimuth_panel_rad: 0=Norte, π=Sur (convención sur = 180°)
    """
    cos_theta = (np.sin(alpha_rad) * np.cos(tilt_rad) +
                 np.cos(alpha_rad) * np.cos(azimuth_sun_rad - azimuth_panel_rad) * np.sin(tilt_rad))
    return np.arccos(np.clip(cos_theta, -1.0, 1.0))


def _poa_irradiance(Gb_h: float, Gd_h: float, alpha_rad: float,
                    azimuth_sun_rad: float, tilt_rad: float,
                    azimuth_panel_rad: float) -> float:
    """
    Irradiancia total en el Plano de Arreglo (POA) [W/m²].
    Modelo isotrópico (Hottel-Woertz) para difusa y reflejada.
    """
    if alpha_rad <= 5.0 * DEG:
        return 0.0

    theta_i = _angle_of_incidence(alpha_rad, azimuth_sun_rad, tilt_rad, azimuth_panel_rad)

    # Solo la componente que incide en la cara frontal del panel
    cos_theta_i = np.cos(theta_i)
    if cos_theta_i <= 0:
        Gb_poa = 0.0
    else:
        # Factor de transposición: Rb = cos(θi) / sin(α)
        Rb = cos_theta_i / np.sin(alpha_rad) if np.sin(alpha_rad) > 0.01 else 0
        Gb_poa = Gb_h * Rb

    # Difusa isotrópica
    Gd_poa = Gd_h * (1.0 + np.cos(tilt_rad)) / 2.0

    # Reflejada
    Gr_poa = (Gb_h + Gd_h) * RHO * (1.0 - np.cos(tilt_rad)) / 2.0

    Gtot = Gb_poa + Gd_poa + Gr_poa
    return max(0.0, Gtot)


# ─────────────────────────────────────────────────────────────────────────────
# MOTOR PRINCIPAL
# ─────────────────────────────────────────────────────────────────────────────
def run_solar_engine(lat: float, lon: float, alt: float,
                     eta_ref: float, area_m2: float, n_panels: int,
                     tilt: float, azimuth: float,
                     p_nominal_w: float,
                     eta_sys: float = 0.75,
                     noct: float = 45.0,
                     beta: float = 0.004,
                     t_amb: float = 25.0) -> dict:
    """
    Motor de Jensen completo para un año (35,040 intervalos de 15 min).

    Args:
        lat         : Latitud [°] positivo Norte
        lon         : Longitud [°] positivo Este
        alt         : Altitud [m] — usado para corrección de densidad de aire
        eta_ref     : Eficiencia del panel en STC [fracción, ej: 0.20]
                      Se calcula como P_nominal / (1000 * area_m2)
        area_m2     : Área de un panel [m²]
        n_panels    : Número de paneles
        tilt        : Ángulo de inclinación del panel [°] respecto a horizontal
        azimuth     : Azimut del panel [°] 0=Norte, 90=Este, 180=Sur, 270=Oeste
        p_nominal_w : Potencia nominal del panel [W] (para referencia y cálculo de FC)
        eta_sys     : Eficiencia del sistema [fracción] — pérdidas por cableado,
                      inversor, suciedad, sombreado (default 0.75)
        noct        : Nominal Operating Cell Temperature del datasheet [°C]
                      (default 45.0)
        beta        : Coeficiente de temperatura de potencia [%/°C]
                      (default 0.40 %/°C = 0.004 1/°C internamente)
                      El usuario lo ingresa en %/°C; se convierte a 1/°C dividiendo entre 100
        t_amb       : Temperatura ambiente representativa [°C] — usada cuando no
                      hay perfil horario disponible (default 25.0)

    Returns:
        dict con arrays y estadísticas
    """
    lat_r = lat * DEG
    lon_r = lon * DEG
    tilt_r = tilt * DEG
    azimuth_r = azimuth * DEG

    # beta viene del usuario en %/°C → convertir a 1/°C
    beta_per_c = beta / 100.0

    # eta_ref calculada internamente si no se pasa (redundancia con P_nominal y area)
    # Permite al frontend pasar cualquiera de las dos formas:
    #   eta_ref directo, o bien deducirlo de p_nominal_w y area_m2
    if eta_ref <= 0:
        eta_ref = p_nominal_w / (1000.0 * area_m2)

    # Corrección por altitud (densidad de aire ≈ reduce masa de aire efectiva)
    # Factor empírico: AM_eff = AM * exp(-alt/8500)
    alt_factor = np.exp(-alt / 8500.0)

    # Arrays de salida
    N = 35040
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
                # Hora estándar (centro del intervalo de 15 min)
                hour_std = interval * 0.25 + 0.125

                alpha, az_sun = _solar_position(lat_r, lon_r, n, hour_std)

                # Corrección de masa de aire por altitud
                if alpha > 5.0 * DEG:
                    alpha_eff = np.arcsin(np.clip(
                        np.sin(alpha) / alt_factor, -1, 1))
                else:
                    alpha_eff = alpha

                Gb_h, Gd_h = _irradiance_horizontal(alpha_eff, n)
                Gtot = _poa_irradiance(Gb_h, Gd_h, alpha_eff, az_sun, tilt_r, azimuth_r)

                # Temperatura de operación (modelo NOCT)
                t_op = _cell_temperature(t_amb, Gtot, noct)

                # Eficiencia corregida por temperatura
                eta_T = _eta_temperature(eta_ref, beta_per_c, t_op)

                # Generación PV [kW]: η_T × η_sys × A × Gtot × N_paneles
                P_kw = (eta_T * eta_sys * area_m2 * Gtot * n_panels) / 1000.0

                Gtot_arr[idx]  = Gtot
                Gb_h_arr[idx]  = Gb_h
                Gd_h_arr[idx]  = Gd_h
                P_kw_arr[idx]  = P_kw
                T_op_arr[idx]  = t_op
                eta_T_arr[idx] = eta_T
                idx += 1

    # ── Agregaciones ─────────────────────────────────────────────────────────

    # Promedios y máximos mensuales
    monthly_gtot_avg = []
    monthly_gtot_max = []
    monthly_gen_kwh  = []
    idx = 0
    for n_days in days_in_month:
        n_pts  = n_days * 96
        seg_g  = Gtot_arr[idx: idx + n_pts]
        seg_p  = P_kw_arr[idx: idx + n_pts]
        monthly_gtot_avg.append(float(np.mean(seg_g)))
        monthly_gtot_max.append(float(np.max(seg_g)))
        monthly_gen_kwh.append(float(np.sum(seg_p) * 0.25))
        idx += n_pts

    # Perfil horario diario representativo (promedio de días de verano)
    # Días de verano: mayo–agosto → días 120–243
    summer_start   = sum(days_in_month[:4]) * 96   # mayo
    summer_end     = sum(days_in_month[:8]) * 96   # sep
    n_summer_days  = sum(days_in_month[4:8])

    summer_gtot      = Gtot_arr[summer_start:summer_end].reshape(n_summer_days, 96)
    daily_gtot_summer = np.mean(summer_gtot, axis=0)

    summer_p         = P_kw_arr[summer_start:summer_end].reshape(n_summer_days, 96)
    daily_p_summer   = np.mean(summer_p, axis=0)

    # Estadísticas globales
    energia_anual_kwh    = float(np.sum(P_kw_arr) * 0.25)
    p_max_kw             = float(np.max(P_kw_arr))
    p_nominal_total_kw   = p_nominal_w * n_panels / 1000.0
    fc   = energia_anual_kwh / (p_nominal_total_kw * 8760) if p_nominal_total_kw > 0 else 0
    hpse = energia_anual_kwh / p_nominal_total_kw if p_nominal_total_kw > 0 else 0

    # Irradiación anual en plano horizontal y POA
    irrad_horizontal_kwh_m2 = float(np.sum(Gb_h_arr + Gd_h_arr) * 0.25 / 1000)
    irrad_poa_kwh_m2        = float(np.sum(Gtot_arr) * 0.25 / 1000)

    # Estadísticas térmicas
    t_op_media  = float(np.mean(T_op_arr[Gtot_arr > 0])) if np.any(Gtot_arr > 0) else t_amb
    t_op_max    = float(np.max(T_op_arr))
    eta_T_media = float(np.mean(eta_T_arr[Gtot_arr > 0])) if np.any(Gtot_arr > 0) else eta_ref

    hours = np.arange(N) * 0.25

    stats = {
        'energia_anual_kWh'       : energia_anual_kwh,
        'energia_anual_MWh'       : energia_anual_kwh / 1000,
        'p_max_kW'                : p_max_kw,
        'p_nominal_total_kW'      : p_nominal_total_kw,
        'factor_capacidad_pct'    : fc * 100,
        'horas_pico_sol_equiv'    : hpse,
        'irrad_horizontal_kWh_m2' : irrad_horizontal_kwh_m2,
        'irrad_poa_kWh_m2'        : irrad_poa_kwh_m2,
        'gtot_max_W_m2'           : float(np.max(Gtot_arr)),
        'gtot_media_W_m2'         : float(np.mean(Gtot_arr[Gtot_arr > 0])) if np.any(Gtot_arr > 0) else 0,
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
        'beta_pct_por_c'          : beta,
        't_amb_ref'               : t_amb,
        't_op_media_C'            : t_op_media,
        't_op_max_C'              : t_op_max,
        'eta_T_media'             : eta_T_media,
    }

    return {
        'Gtot_arr'          : Gtot_arr.tolist(),
        'P_kw_arr'          : P_kw_arr.tolist(),
        'T_op_arr'          : T_op_arr.tolist(),
        'hours'             : hours.tolist(),
        'monthly_gtot_avg'  : monthly_gtot_avg,
        'monthly_gtot_max'  : monthly_gtot_max,
        'monthly_gen_kWh'   : monthly_gen_kwh,
        'daily_gtot_summer' : daily_gtot_summer.tolist(),
        'daily_p_summer'    : daily_p_summer.tolist(),
        'stats'             : stats,
    }