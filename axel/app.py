import pandas as pd
import streamlit as st
import plotly.express as px
import plotly.graph_objects as go
from motor_calculo import calcular_viabilidad

# ==================== CONFIGURACIÓN DE PÁGINA ====================
st.set_page_config(
    page_title="Análisis Fotovoltaico - Cosmic Rose",
    page_icon="🌸",
    layout="wide",
    initial_sidebar_state="expanded"
)

# ==================== ESTILOS CSS PERSONALIZADOS (GLASSMORPHISM & PINK ACCENTS) ====================
st.markdown("""
<style>
    /* Importación de tipografía premium */
    @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap');
    
    html, body, [class*="css"] {
        font-family: 'Outfit', sans-serif;
    }
    
    /* Efecto degradado para el título principal */
    .title-container {
        padding: 1.5rem 0rem;
        text-align: left;
    }
    .main-title {
        background: linear-gradient(135deg, #FF4B91 0%, #FF76CE 50%, #9400D3 100%);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        font-size: 2.8rem;
        font-weight: 700;
        margin-bottom: 0.5rem;
    }
    .sub-title {
        color: #A3A3C2;
        font-size: 1.1rem;
        font-weight: 300;
    }
    
    /* Contenedor de Métricas Estilizado (KPI Card) */
    .kpi-card {
        background: rgba(33, 28, 56, 0.45);
        border: 1px solid rgba(255, 75, 145, 0.25);
        border-radius: 14px;
        padding: 22px;
        box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.3);
        backdrop-filter: blur(10px);
        transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        margin-bottom: 15px;
        text-align: center;
    }
    .kpi-card:hover {
        transform: translateY(-5px);
        border-color: rgba(255, 75, 145, 0.6);
        box-shadow: 0 12px 40px 0 rgba(255, 75, 145, 0.25);
        background: rgba(45, 35, 74, 0.6);
    }
    .kpi-title {
        color: #A3A3C2;
        font-size: 0.85rem;
        font-weight: 500;
        margin-bottom: 6px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
    }
    .kpi-value {
        color: #FDF8FC;
        font-size: 2.1rem;
        font-weight: 700;
        margin-bottom: 2px;
        text-shadow: 0 0 10px rgba(255, 75, 145, 0.25);
    }
    .kpi-unit {
        color: #FF4B91;
        font-size: 0.8rem;
        font-weight: 600;
    }
    
    /* Cuadro de recomendación técnica */
    .rec-box {
        background: linear-gradient(135deg, rgba(33, 28, 56, 0.65) 0%, rgba(120, 28, 104, 0.15) 100%);
        border-left: 5px solid #FF4B91;
        border-radius: 6px 16px 16px 6px;
        padding: 24px;
        margin-top: 20px;
        border-top: 1px solid rgba(255, 75, 145, 0.15);
        border-right: 1px solid rgba(255, 75, 145, 0.15);
        border-bottom: 1px solid rgba(255, 75, 145, 0.15);
        box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.2);
    }
    .rec-title {
        color: #FF4B91;
        font-size: 1.2rem;
        font-weight: 600;
        margin-bottom: 10px;
        display: flex;
        align-items: center;
        gap: 8px;
    }
    .rec-text {
        color: #E2E2EC;
        font-size: 0.95rem;
        line-height: 1.6;
    }

    /* Rediseño de botones primarios */
    div.stButton > button:first-child {
        background: linear-gradient(135deg, #FF4B91 0%, #9400D3 100%) !important;
        color: #FDF8FC !important;
        border: none !important;
        padding: 10px 20px !important;
        border-radius: 10px !important;
        font-weight: 600 !important;
        width: 100% !important;
        box-shadow: 0 4px 15px rgba(255, 75, 145, 0.3) !important;
        transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1) !important;
    }
    div.stButton > button:first-child:hover {
        transform: translateY(-2px) !important;
        box-shadow: 0 6px 22px rgba(255, 75, 145, 0.5) !important;
        filter: brightness(1.1);
    }
    div.stButton > button:first-child:active {
        transform: translateY(1px) !important;
    }
    
    /* Sidebar styling refinements */
    section[data-testid="stSidebar"] {
        background-color: #120C24 !important;
        border-right: 1px solid rgba(255, 75, 145, 0.1) !important;
    }
</style>
""", unsafe_allow_html=True)

# ==================== TÍTULO DE APLICACIÓN ====================
st.markdown("""
<div class="title-container">
    <div class="main-title">🌸 Análisis Fotovoltaico & Viabilidad</div>
    <div class="sub-title">Simulación solar interactiva con el modelo de irradiancia Jensen & POA y balance de demanda en tiempo real.</div>
</div>
""", unsafe_allow_html=True)

# ==================== BARRA LATERAL ====================
st.sidebar.markdown("<h2 style='color:#FF4B91; font-weight:600;'>⚙️ Configuración</h2>", unsafe_allow_html=True)

# --- 1. Parámetros Ubicación ---
st.sidebar.markdown("<p style='color:#FF76CE; font-weight:600; margin-bottom:5px;'>📍 Ubicación</p>", unsafe_allow_html=True)
latitud = st.sidebar.number_input(
    "Latitud (°)",
    min_value=-90.0,
    max_value=90.0,
    value=19.4789,
    step=0.0001,
    format="%.4f",
    help="Latitud geográfica (positivo = Norte, negativo = Sur)"
)
longitud = st.sidebar.number_input(
    "Longitud (°)",
    min_value=-180.0,
    max_value=180.0,
    value=-96.9500,
    step=0.0001,
    format="%.4f",
    help="Longitud geográfica (positivo = Este, negativo = Oeste)"
)
altura_panel = st.sidebar.number_input(
    "Altura del Panel (m)",
    min_value=0.0,
    value=1.5,
    step=0.1,
    format="%.2f",
    help="Altura física del panel solar sobre el nivel del suelo"
)

st.sidebar.markdown("---")

# --- 2. Parámetros Sistema Solar (¡Nuevos controles!) ---
st.sidebar.markdown("<p style='color:#FF76CE; font-weight:600; margin-bottom:5px;'>☀️ Sistema Fotovoltaico</p>", unsafe_allow_html=True)
n_paneles = st.sidebar.number_input(
    "Número de Paneles",
    min_value=1,
    max_value=10000,
    value=150,
    step=10,
    help="Cantidad total de paneles solares a simular en la planta"
)
p_nominal_w = st.sidebar.number_input(
    "Potencia por Panel (W)",
    min_value=10.0,
    max_value=1000.0,
    value=450.0,
    step=10.0,
    help="Potencia pico nominal de cada panel en Watts"
)
eta_pct = st.sidebar.slider(
    "Eficiencia del Panel (%)",
    min_value=5.0,
    max_value=40.0,
    value=21.0,
    step=0.5,
    help="Eficiencia nominal de conversión energética de las celdas solares"
)
area_panel = st.sidebar.number_input(
    "Área del Panel (m²)",
    min_value=0.1,
    max_value=10.0,
    value=2.2,
    step=0.1,
    help="Área de la superficie física de un solo panel"
)
tilt = st.sidebar.slider(
    "Inclinación (Tilt °)",
    min_value=0.0,
    max_value=90.0,
    value=20.0,
    step=1.0,
    help="Ángulo de inclinación del panel solar con respecto a la horizontal"
)
azimuth = st.sidebar.slider(
    "Azimut (Azimuth °)",
    min_value=0.0,
    max_value=360.0,
    value=180.0, # 180 es sur, ideal en hemisferio norte
    step=5.0,
    help="Orientación cardinal del panel (0=Norte, 90=Este, 180=Sur, 270=Oeste)"
)

st.sidebar.markdown("---")

# --- 3. Carga de Datos de Demanda ---
st.sidebar.markdown("<p style='color:#FF76CE; font-weight:600; margin-bottom:5px;'>📁 Carga de Demanda</p>", unsafe_allow_html=True)
archivo_demanda = st.sidebar.file_uploader(
    "Sube el archivo de demanda",
    type=["csv", "txt"],
    help="Archivo CSV o TXT con los datos de demanda energética (resolución de 15 min, 1 hora, o perfil diario de 96 puntos)"
)

st.sidebar.markdown("<div style='margin-top:20px;'></div>", unsafe_allow_html=True)

# Botón para ejecutar la simulación
boton_ejecutar = st.sidebar.button(
    "▶️ Ejecutar Simulación",
    use_container_width=True
)

# ==================== VISTA PREVIA DE DATOS DE DEMANDA ====================
df_cargado = None
if archivo_demanda is not None:
    try:
        df_cargado = pd.read_csv(archivo_demanda)
        
        with st.expander("📊 Vista Previa de la Curva de Demanda Cargada", expanded=False):
            st.success(f"✅ Archivo cargado exitosamente: **{archivo_demanda.name}**")
            col_inf1, col_inf2 = st.columns(2)
            with col_inf1:
                st.markdown(f"**Dimensiones del archivo:** `{df_cargado.shape[0]}` filas × `{df_cargado.shape[1]}` columnas")
            with col_inf2:
                numeric_cols = df_cargado.select_dtypes(include=['number']).columns.tolist()
                st.markdown(f"**Columnas numéricas encontradas:** `{', '.join(numeric_cols)}`")
                
            st.write("**Primeras filas del archivo:**")
            st.dataframe(df_cargado.head(5), use_container_width=True)
    except Exception as e:
        st.error(f"❌ Error al procesar el archivo: {e}")
        st.info("💡 Asegúrate de que el archivo tenga formato CSV o TXT delimitado por comas.")
else:
    st.info("👈 Sube un archivo de demanda en la barra lateral para un análisis real. De lo contrario, la simulación correrá con un perfil industrial por defecto.")

# ==================== LÓGICA DE SIMULACIÓN ====================
if boton_ejecutar:
    with st.spinner("☀️ Calculando posición solar, irradiancia POA y balance energético anual..."):
        try:
            # Ejecutar cálculos viabilidad
            resultados = calcular_viabilidad(
                latitud=latitud,
                longitud=longitud,
                altura_panel=altura_panel,
                df_demanda=df_cargado,
                n_paneles=n_paneles,
                tilt=tilt,
                azimuth=azimuth,
                eta=eta_pct / 100.0,
                area_m2=area_panel,
                p_nominal_w=p_nominal_w
            )
            
            # Guardar en estado de sesión para conservar los resultados si interactúa con las gráficas
            st.session_state['resultados'] = resultados
            st.session_state['ejecutado'] = True
        except Exception as e:
            st.error(f"❌ Error durante el cálculo de simulación: {str(e)}")
            import traceback
            st.code(traceback.format_exc())

# ==================== SECCIÓN DE RESULTADOS ====================
if 'ejecutado' in st.session_state and st.session_state['ejecutado']:
    res = st.session_state['resultados']
    bs = res['balance_stats']
    ss = res['solar_stats']
    ds = res['demand_stats']
    
    st.markdown("<h2 style='color:#FF4B91; font-weight:600; margin-top:20px;'>🔬 Resultados del Balance Energético</h2>", unsafe_allow_html=True)
    
    # 1. TARJETAS DE INDICADORES CLAVE (KPIs con diseño personalizado en CSS)
    col1, col2, col3, col4 = st.columns(4)
    
    with col1:
        st.markdown(f"""
        <div class="kpi-card">
            <div class="kpi-title">Demanda Industrial Anual</div>
            <div class="kpi-value">{bs['energia_demanda_kWh']/1000:,.1f}</div>
            <div class="kpi-unit">MWh/año</div>
        </div>
        """, unsafe_allow_html=True)
        
    with col2:
        st.markdown(f"""
        <div class="kpi-card">
            <div class="kpi-title">Generación Solar Anual</div>
            <div class="kpi-value">{bs['energia_generada_kWh']/1000:,.1f}</div>
            <div class="kpi-unit">MWh/año</div>
        </div>
        """, unsafe_allow_html=True)
        
    with col3:
        st.markdown(f"""
        <div class="kpi-card">
            <div class="kpi-title">Autoconsumo Directo</div>
            <div class="kpi-value">{bs['autoconsumo_kWh']/1000:,.1f}</div>
            <div class="kpi-unit">MWh / {bs['autoconsumo_pct']:.1f}% del total sol</div>
        </div>
        """, unsafe_allow_html=True)
        
    with col4:
        st.markdown(f"""
        <div class="kpi-card">
            <div class="kpi-title">Cobertura Solar de Red</div>
            <div class="kpi-value">{bs['autarquia_pct']:.1f}%</div>
            <div class="kpi-unit">Ahorro en Consumo Directo</div>
        </div>
        """, unsafe_allow_html=True)

    col5, col6, col7, col8 = st.columns(4)
    
    with col5:
        st.markdown(f"""
        <div class="kpi-card">
            <div class="kpi-title">Potencia del Sistema</div>
            <div class="kpi-value">{ss['p_nominal_total_kW']:.1f}</div>
            <div class="kpi-unit">kWp (Pico)</div>
        </div>
        """, unsafe_allow_html=True)
        
    with col6:
        st.markdown(f"""
        <div class="kpi-card">
            <div class="kpi-title">Excedentes a Red</div>
            <div class="kpi-value">{bs['excedente_kWh']/1000:,.1f}</div>
            <div class="kpi-unit">MWh/año (Inyectable)</div>
        </div>
        """, unsafe_allow_html=True)
        
    with col7:
        st.markdown(f"""
        <div class="kpi-card">
            <div class="kpi-title">Energía de la Red</div>
            <div class="kpi-value">{bs['energia_red_kWh']/1000:,.1f}</div>
            <div class="kpi-unit">MWh/año a comprar</div>
        </div>
        """, unsafe_allow_html=True)
        
    with col8:
        st.markdown(f"""
        <div class="kpi-card">
            <div class="kpi-title">Factor de Capacidad</div>
            <div class="kpi-value">{ss['factor_capacidad_pct']:.2f}%</div>
            <div class="kpi-unit">Rendimiento Anual</div>
        </div>
        """, unsafe_allow_html=True)

    st.markdown("---")

    # 2. GRÁFICAS INTERACTIVAS
    col_g1, col_g2 = st.columns(2)
    
    with col_g1:
        st.markdown("<h3 style='color:#FF76CE; font-size:1.3rem;'>📈 Perfil Diario Promedio (Verano)</h3>", unsafe_allow_html=True)
        
        prof = res['profiles']
        df_profile = pd.DataFrame({
            'Hora': prof['hours_96'],
            'Generación Solar (kW)': prof['daily_gen'],
            'Demanda Laboral (kW)': prof['daily_dem_weekday'],
            'Demanda Fin de Semana (kW)': prof['daily_dem_weekend']
        })
        
        # Crear gráfico interactivo con Plotly para máxima estética
        fig1 = go.Figure()
        
        # Área de Demanda Laboral
        fig1.add_trace(go.Scatter(
            x=df_profile['Hora'], y=df_profile['Demanda Laboral (kW)'],
            name='Demanda Laboral', line=dict(color='#8B5CF6', width=2.5),
            mode='lines'
        ))
        
        # Área de Generación Solar
        fig1.add_trace(go.Scatter(
            x=df_profile['Hora'], y=df_profile['Generación Solar (kW)'],
            name='Generación Solar', line=dict(color='#FF4B91', width=3),
            fill='tozeroy', fillcolor='rgba(255, 75, 145, 0.15)',
            mode='lines'
        ))
        
        # Área de Demanda Fin de Semana
        fig1.add_trace(go.Scatter(
            x=df_profile['Hora'], y=df_profile['Demanda Fin de Semana (kW)'],
            name='Demanda Finde', line=dict(color='#3B82F6', width=2, dash='dash'),
            mode='lines'
        ))
        
        fig1.update_layout(
            paper_bgcolor='rgba(0,0,0,0)',
            plot_bgcolor='rgba(15, 12, 27, 0.5)',
            xaxis=dict(gridcolor='rgba(255,255,255,0.05)', title='Hora del Día', tickangle=-45, nticks=24),
            yaxis=dict(gridcolor='rgba(255,255,255,0.05)', title='Potencia (kW)'),
            legend=dict(font=dict(color='#FDF8FC'), bgcolor='rgba(15,12,27,0.8)'),
            margin=dict(l=40, r=40, t=10, b=40),
            hovermode='x unified'
        )
        
        st.plotly_chart(fig1, use_container_width=True)
        
    with col_g2:
        st.markdown("<h3 style='color:#FF76CE; font-size:1.3rem;'>📊 Balance Mensual de Energía</h3>", unsafe_allow_html=True)
        
        df_m = res['df_monthly']
        
        # Crear gráfico de barras agrupadas con Plotly
        fig2 = go.Figure()
        
        fig2.add_trace(go.Bar(
            x=df_m['Mes'], y=df_m['Demanda Industrial (kWh)'],
            name='Demanda (kWh)', marker_color='#4C1D95'
        ))
        
        fig2.add_trace(go.Bar(
            x=df_m['Mes'], y=df_m['Generación Solar (kWh)'],
            name='Generación (kWh)', marker_color='#FF4B91'
        ))
        
        fig2.add_trace(go.Bar(
            x=df_m['Mes'], y=df_m['Autoconsumo Directo (kWh)'],
            name='Autoconsumo (kWh)', marker_color='#10B981'
        ))
        
        fig2.update_layout(
            paper_bgcolor='rgba(0,0,0,0)',
            plot_bgcolor='rgba(15, 12, 27, 0.5)',
            xaxis=dict(gridcolor='rgba(255,255,255,0.05)', title='Mes'),
            yaxis=dict(gridcolor='rgba(255,255,255,0.05)', title='Energía (kWh)'),
            legend=dict(font=dict(color='#FDF8FC'), bgcolor='rgba(15,12,27,0.8)'),
            margin=dict(l=40, r=40, t=10, b=40),
            barmode='group'
        )
        
        st.plotly_chart(fig2, use_container_width=True)

    st.markdown("---")

    # 3. TABLA RESUMEN MENSUAL Y RECOMENDACIONES
    col_t1, col_t2 = st.columns([3, 2])
    
    with col_t1:
        st.markdown("<h3 style='color:#FF76CE; font-size:1.3rem;'>📋 Desglose Mensual</h3>", unsafe_allow_html=True)
        # Mostrar tabla interactiva formateada
        df_disp = df_m.copy()
        
        # Aplicar formato de moneda/número para legibilidad
        for col in ['Generación Solar (kWh)', 'Demanda Industrial (kWh)', 'Autoconsumo Directo (kWh)', 'Excedentes a Red (kWh)']:
            df_disp[col] = df_disp[col].apply(lambda x: f"{x:,.0f} kWh")
            
        for col in ['Cobertura Solar (%)', 'Autarquía (%)']:
            df_disp[col] = df_disp[col].apply(lambda x: f"{x:.1f}%")
            
        st.dataframe(df_disp, use_container_width=True, hide_index=True)
        
    with col_t2:
        st.markdown("<h3 style='color:#FF76CE; font-size:1.3rem;'>🌸 Recomendación y Análisis de Viabilidad</h3>", unsafe_allow_html=True)
        
        # Lógica inteligente para dar una recomendación técnica basada en excedentes y autoconsumo
        autoconsumo_pct = bs['autoconsumo_pct']
        cobertura_pct = bs['cobertura_pct']
        
        rec_title = ""
        rec_html = ""
        
        if autoconsumo_pct > 80.0:
            rec_title = "⭐ Viabilidad Sobresaliente (Dimensionamiento Óptimo)"
            rec_html = f"""
            El sistema está diseñado de manera excelente. Tu porcentaje de autoconsumo es del <b>{autoconsumo_pct:.1f}%</b>, 
            lo que significa que casi toda la energía producida por los paneles solares es aprovechada instantáneamente en 
            tus procesos industriales, minimizando el desperdicio. 
            <br><br>
            Con una autarquía del <b>{bs['autarquia_pct']:.1f}%</b>, verás un impacto inmediato en el cobro de tu factura eléctrica. 
            Esta configuración maximiza la tasa interna de retorno (TIR) y acorta el periodo de amortización del capital.
            """
        elif autoconsumo_pct < 50.0:
            rec_title = "⚠️ Alerta de Sobredimensionamiento"
            rec_html = f"""
            El sistema genera una cantidad considerable de energía excedente (<b>{bs['excedente_kWh']/1000:,.1f} MWh/año</b>) 
            que no se consume inmediatamente en tu planta (Autoconsumo del <b>{autoconsumo_pct:.1f}%</b>). 
            <br><br>
            <b>Recomendación técnica:</b>
            <ul>
                <li>Reduce el número de paneles en la barra lateral para maximizar la rentabilidad si el esquema tarifario de red no favorece la inyección de excedentes.</li>
                <li>Considera agregar un sistema de almacenamiento de baterías para guardar los excedentes producidos durante las horas pico de irradiancia.</li>
                <li>Desplaza cargas operativas pesadas al bloque de horas de 10:00 AM a 2:00 PM.</li>
            </ul>
            """
        else:
            rec_title = "📈 Viabilidad Moderada (Sistema Balanceado)"
            rec_html = f"""
            Tu sistema fotovoltaico se encuentra en un balance saludable, con un autoconsumo directo del <b>{autoconsumo_pct:.1f}%</b> 
            y una cobertura general de la demanda del <b>{cobertura_pct:.1f}%</b>. 
            <br><br>
            La inyección a red es razonable. Este diseño proporciona una buena reducción de huella de carbono y 
            un rendimiento financiero estable en tarifas de alta tensión o comercial ordinaria.
            """
            
        st.markdown(f"""
        <div class="rec-box">
            <div class="rec-title">
                <span>{rec_title}</span>
            </div>
            <div class="rec-text">
                {rec_html}
            </div>
        </div>
        """, unsafe_allow_html=True)
else:
    # Mensaje de bienvenida en el área principal antes de ejecutar
    st.markdown("""
    <div style="background: rgba(33, 28, 56, 0.45); border: 1.5px dashed rgba(255, 75, 145, 0.3); border-radius: 15px; padding: 40px; text-align: center; margin-top: 40px; box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.25);">
        <span style="font-size: 4rem;">🌸</span>
        <h3 style="color: #FF4B91; font-weight: 600; margin-top: 15px; font-size: 1.6rem;">¡Listo para Comenzar!</h3>
        <p style="color: #A3A3C2; font-size: 1.05rem; max-width: 600px; margin: 10px auto 20px auto; line-height: 1.6;">
            Configura los parámetros del sistema fotovoltaico (paneles solares, eficiencia, inclinación, orientación) e ingresa la ubicación deseada. Si lo deseas, puedes subir una curva de demanda real de tu empresa.
        </p>
        <p style="color: #FF76CE; font-weight: 500; font-size: 0.95rem;">
            👈 Presiona el botón <b>"▶️ Ejecutar Simulación"</b> en la barra lateral para generar el panel de control.
        </p>
    </div>
    """, unsafe_allow_html=True)