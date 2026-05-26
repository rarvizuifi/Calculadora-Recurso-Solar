import sys
import os
import pandas as pd
import numpy as np

# Añadir directorio padre al path de Python para importar los motores del proyecto
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

try:
    from solar_engine import run_solar_engine
    from demand_profile import generate_demand_profile
except ImportError:
    # Fallback si por alguna razón cambian las rutas
    pass

def calcular_viabilidad(latitud, longitud, altura_panel=1.5, df_demanda=None,
                        n_paneles=50, tilt=20.0, azimuth=180.0,
                        eta=0.20, area_m2=2.0, p_nominal_w=400.0):
    """
    Realiza los cálculos del motor solar y realiza el balance anual de energía (quinceminutal)
    con la curva de demanda de la empresa.

    Parámetros:
    -----------
    latitud : float
        Latitud de la ubicación.
    longitud : float
        Longitud de la ubicación.
    altura_panel : float
        Altura del panel solar en metros.
    df_demanda : pd.DataFrame, opcional
        Dataframe cargado desde archivo CSV/TXT con la curva de demanda.
    n_paneles : int
        Número de paneles en el arreglo solar.
    tilt : float
        Inclinación del panel en grados.
    azimuth : float
        Azimut del panel en grados (180 = Sur).
    eta : float
        Eficiencia decimal de conversión del panel (ej. 0.20 = 20%).
    area_m2 : float
        Área física de cada panel en m².
    p_nominal_w : float
        Potencia nominal de cada panel en Watts.

    Retorna:
    --------
    dict: Diccionario completo con estadísticas, perfiles mensuales y datos para gráficas.
    """
    # 1. Ejecutar el motor de física solar (Jensen + POA) para el año completo (35,040 puntos)
    # Usamos 500m de altitud por defecto para cálculos de densidad atmosférica
    solar_results = run_solar_engine(
        lat=latitud,
        lon=longitud,
        alt=500.0,
        eta=eta,
        area_m2=area_m2,
        n_paneles=n_paneles,
        tilt=tilt,
        azimuth=azimuth,
        p_nominal_w=p_nominal_w
    )
    
    # 2. Procesar e integrar la curva de demanda
    demand_kW = None
    demand_stats = {}
    
    if df_demanda is not None:
        try:
            # Buscar de forma inteligente la columna de demanda en el DataFrame subido
            numeric_cols = df_demanda.select_dtypes(include=[np.number]).columns
            demand_col = None
            
            # Buscar columnas con nombres comunes como 'demanda', 'kw', 'potencia', 'active_power'
            for col in numeric_cols:
                col_lower = col.lower()
                if any(x in col_lower for x in ['demanda', 'kw', 'potencia', 'active', 'power', 'value', 'real']):
                    demand_col = col
                    break
            
            # Fallback a la primera columna numérica si no encontramos por nombre
            if demand_col is None and len(numeric_cols) > 0:
                demand_col = numeric_cols[0]
                
            if demand_col is not None:
                raw_values = df_demanda[demand_col].values
                n_vals = len(raw_values)
                
                # Ajustar inteligentemente los datos cargados a la resolución quinceminutal de un año (35,040 puntos)
                if n_vals == 35040:
                    demand_kW = raw_values.tolist()
                elif n_vals == 8760:
                    # Datos horarios -> expandir cada hora a cuatro intervalos de 15 minutos
                    demand_kW = np.repeat(raw_values, 4).tolist()
                elif n_vals == 96:
                    # Datos diarios (un solo día) -> replicar para los 365 días del año
                    demand_kW = np.tile(raw_values, 365).tolist()
                elif n_vals > 0:
                    # Interpolación lineal para ajustar cualquier otro tamaño a los 35,040 puntos exactos
                    x_old = np.linspace(0, 1, n_vals)
                    x_new = np.linspace(0, 1, 35040)
                    demand_kW = np.interp(x_new, x_old, raw_values).tolist()
        except Exception as e:
            # En caso de error, el fallback se encargará de generar datos válidos
            pass

    # Si no hay archivo cargado o falló el procesamiento, generamos un perfil sintético estructurado
    if demand_kW is None:
        sintetico = generate_demand_profile(
            Pmax_kW=100.0, # Demanda pico típica de 100 kW
            FC_planta=0.60,
            FP_potencia=0.85,
            n_shifts=2, # Turno doble laboral común
            plant_type='manufactura_ligera',
            weekend_op_factor=0.50,
            summer_boost=1.10
        )
        demand_kW = sintetico['demand_kW']
        demand_stats = sintetico['stats']
    else:
        # Calcular estadísticas avanzadas de la curva de demanda real cargada
        demand_array = np.array(demand_kW)
        e_anual_kwh = float(np.sum(demand_array) * 0.25)
        demand_stats = {
            'pmax_kW': float(np.max(demand_array)),
            'p_media_kW': float(np.mean(demand_array)),
            'p_min_kW': float(np.min(demand_array)),
            'p_max_real_kW': float(np.max(demand_array)),
            'energia_anual_kWh': e_anual_kwh,
            'energia_anual_MWh': e_anual_kwh / 1000,
            'factor_carga_real': float(np.mean(demand_array) / np.max(demand_array)) if np.max(demand_array) > 0 else 0,
            'horas_punta_equiv': e_anual_kwh / np.max(demand_array) if np.max(demand_array) > 0 else 0,
            'plant_name': 'Curva Real Cargada por Usuario'
        }

    # 3. Cálculo del Balance Energético Anual (Quinceminutal)
    gen_kW = np.array(solar_results['P_kw_arr'])
    dem_kW_arr = np.array(demand_kW)
    
    # Excesos: Energía solar generada que supera la demanda instantánea (se puede inyectar a la red)
    exceso_kW = np.maximum(gen_kW - dem_kW_arr, 0.0)
    # Déficit: Demanda no cubierta por el sistema fotovoltaico (se debe comprar a la CFE/red eléctrica)
    deficit_kW = np.maximum(dem_kW_arr - gen_kW, 0.0)
    # Autoconsumo: Energía generada que se consume de forma inmediata en la planta
    autoconsumo_kW = np.minimum(gen_kW, dem_kW_arr)
    
    # Integrar kW en kWh aplicando el delta de tiempo de 15 min (0.25 horas)
    e_gen = float(np.sum(gen_kW) * 0.25)
    e_dem = float(np.sum(dem_kW_arr) * 0.25)
    e_exc = float(np.sum(exceso_kW) * 0.25)
    e_def = float(np.sum(deficit_kW) * 0.25)
    e_aut = float(np.sum(autoconsumo_kW) * 0.25)
    
    # Indicadores Clave de Desempeño Energético (KPIs)
    pct_cobertura = (e_gen / e_dem * 100.0) if e_dem > 0 else 0.0
    pct_autoconsumo = (e_aut / e_gen * 100.0) if e_gen > 0 else 0.0
    pct_autarquia = (e_aut / e_dem * 100.0) if e_dem > 0 else 0.0

    # 4. Agregación y Estructuración de Datos por Mes
    DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    MONTHS_ES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 
                 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre']
                 
    monthly_data = []
    idx = 0
    for m_idx, nd in enumerate(DAYS_IN_MONTH):
        n_pts = nd * 96
        g_seg = gen_kW[idx:idx+n_pts]
        d_seg = dem_kW_arr[idx:idx+n_pts]
        exc_seg = exceso_kW[idx:idx+n_pts]
        aut_seg = autoconsumo_kW[idx:idx+n_pts]
        
        eg = float(np.sum(g_seg) * 0.25)
        ed = float(np.sum(d_seg) * 0.25)
        eex = float(np.sum(exc_seg) * 0.25)
        eaut = float(np.sum(aut_seg) * 0.25)
        
        cob = (eg / ed * 100.0) if ed > 0 else 0.0
        autar = (eaut / ed * 100.0) if ed > 0 else 0.0
        
        monthly_data.append({
            'Mes': MONTHS_ES[m_idx],
            'Generación Solar (kWh)': eg,
            'Demanda Industrial (kWh)': ed,
            'Autoconsumo Directo (kWh)': eaut,
            'Excedentes a Red (kWh)': eex,
            'Cobertura Solar (%)': cob,
            'Autarquía (%)': autar
        })
        idx += n_pts
        
    df_monthly = pd.DataFrame(monthly_data)
    
    # 5. Generar perfiles diarios promedios (laboral vs fin de semana) para visualizaciones
    daily_gen_summer = solar_results['daily_p_summer']
    
    daily_dem_weekday = np.zeros(96)
    daily_dem_weekend = np.zeros(96)
    cnt_w, cnt_we = 0, 0
    for d in range(365):
        seg = dem_kW_arr[d * 96: (d + 1) * 96]
        if d % 7 < 5:
            daily_dem_weekday += seg
            cnt_w += 1
        else:
            daily_dem_weekend += seg
            cnt_we += 1
            
    if cnt_w > 0:
        daily_dem_weekday /= cnt_w
    if cnt_we > 0:
        daily_dem_weekend /= cnt_we

    # 6. Empaquetar resultados estructurados
    results = {
        'solar_stats': solar_results['stats'],
        'demand_stats': demand_stats,
        'balance_stats': {
            'energia_generada_kWh': e_gen,
            'energia_demanda_kWh': e_dem,
            'excedente_kWh': e_exc,
            'energia_red_kWh': e_def,
            'autoconsumo_kWh': e_aut,
            'cobertura_pct': pct_cobertura,
            'autoconsumo_pct': pct_autoconsumo,
            'autarquia_pct': pct_autarquia,
        },
        'df_monthly': df_monthly,
        'profiles': {
            'hours_96': [f"{h//4:02d}:{(h%4)*15:02d}" for h in range(96)],
            'daily_gen': daily_gen_summer,
            'daily_dem_weekday': daily_dem_weekday.tolist(),
            'daily_dem_weekend': daily_dem_weekend.tolist(),
        },
        'raw': {
            'gen_kW': gen_kW.tolist(),
            'dem_kW': dem_kW_arr.tolist(),
            'exceso_kW': exceso_kW.tolist(),
            'autoconsumo_kW': autoconsumo_kW.tolist()
        }
    }
    
    return results
