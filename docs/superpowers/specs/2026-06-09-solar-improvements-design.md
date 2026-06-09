# Diseño: Mejoras Motor Solar FV v2.2
**Fecha:** 2026-06-09  
**Estado:** Aprobado  

---

## Resumen de cambios

Seis mejoras independientes sobre la versión actual (v2.1):

1. Documentar `eta_ref` en la tabla de la Guía de Datos
2. Cambiar economía de GDMTH → GDMTO (tarifa plana + fetch en vivo desde CFE)
3. Aumentar padding entre "Especificaciones del Panel FV" y el panel verde de Ángulos Óptimos
4. Corregir bug NaN en la estimación de T_cel cuando se usa modo NASA POWER
5. Obtener humedad relativa (RH2M) desde NASA POWER junto con T2M
6. Agregar `requests` y `beautifulsoup4` a requirements

---

## Contexto del proyecto

- **Frontend:** `index.html` + `solar_app.js` (motor Jensen 100% client-side) + `solar_economics.js`
- **Backend:** `app.py` (Flask) — sirve el HTML, expone endpoints para NASA POWER (en el backend Python) y descarga Excel
- **Modo de uso:** siempre con `python app.py` corriendo (no se usa como HTML estático)
- **Cálculo solar:** duplicado en JS (client-side, el principal) y Python (solar_engine.py, usado solo por el endpoint `/api/solar` y Excel)

---

## Cambio 1 — `eta_ref` en la tabla de la Guía

### Problema
La tabla "Parámetros de Entrada — Referencia Rápida" en `#guia` no documenta el parámetro `η_ref (Eficiencia STC)`, aunque el campo ya existe en el formulario como `input-etastc`.

### Solución
Agregar una fila al final de la sección de parámetros de sistema en la tabla de la guía:

| Parámetro | Descripción | Rango / Formato | Ejemplo |
|---|---|---|---|
| η_ref STC [fracción] | Eficiencia real del panel en condiciones STC. Opcional: si se omite, se calcula como P_nom/(1000·A) | 0.05 – 0.30 (opcional) | 0.20 (o vacío = auto) |

### Archivo afectado
- `index.html` — dentro del `<tbody>` de la tabla de referencia (~línea 390)

---

## Cambio 2 — Economía: GDMTH → GDMTO

### Diferencia estructural clave
| | GDMTH (actual) | GDMTO (nuevo) |
|---|---|---|
| Energía | 3 precios: Base/Intermedio/Punta | **1 precio fijo único [$/kWh]** |
| Estacionalidad | Tarifas distintas verano/normal | **Sin distinción estacional** |
| Cargo demanda | Sobre máx. en horas punta (20–22h L–V) | **Sobre máx. demanda del mes (cualquier hora)** |

GDMTO varía **por división/región CFE**, no por hora ni temporada.

### 2a — Nuevo endpoint Flask `/api/cfe_gdmto`

**Archivo:** `app.py`

```python
@app.route('/api/cfe_gdmto', methods=['GET'])
def api_cfe_gdmto():
    """Obtiene tarifas GDMTO en vivo desde CFE."""
    import requests
    from bs4 import BeautifulSoup
    URL = "https://app.cfe.mx/Aplicaciones/CCFE/Tarifas/TarifasCRENegocio/Tarifas/GranDemandaMTO.aspx"
    try:
        r = requests.get(URL, verify=False, timeout=10,
                         headers={"User-Agent": "Mozilla/5.0"})
        r.raise_for_status()
        soup = BeautifulSoup(r.text, "html.parser")
        # Parsear tabla/valores de tarifas
        # Retornar: cargo_fijo, precio_kwh, cargo_demanda_dist, cargo_demanda_cap, division, fecha
        ...
        return jsonify({'ok': True, 'tarifas': [...], 'fecha': ..., 'fuente': URL})
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e),
                        'fallback': {
                            'cargo_fijo_mensual': 466.83,
                            'precio_kwh': 1.699,
                            'cargo_demanda': 437.87
                        }})
```

**Notas de parsing:**
- La página CFE usa ASP.NET WebForms — puede tener tabla con filas por división
- El parser buscará `<table>` con filas que contengan valores numéricos de pesos
- Si la estructura de la página cambia, el endpoint retorna el fallback con valores conocidos de CDMX 2025
- `verify=False` es necesario porque el certificado SSL de `app.cfe.mx` no pasa verificación estándar

**`requirements.txt`:** agregar `requests` y `beautifulsoup4`

### 2b — Nueva función `calcularFacturaCFEGDMTO()` en `solar_economics.js`

Reemplaza `calcularFacturaCFE()` para el modelo GDMTO.

```
Factura SIN solar:
  E_sin_kWh    = suma total de demanda × 0.25 h (año completo)
  max_dem_sin  = promedio de los 12 máximos mensuales de demanda [kW]
  costo_sin    = E_sin_kWh × precio_kwh
               + max_dem_sin × cargo_demanda × 12
               + cargo_fijo_mensual × 12

Factura CON solar:
  E_con_kWh    = suma total de (demanda - generación, ≥ 0) × 0.25 h
  max_dem_con  = promedio de los 12 máximos mensuales de demanda neta
  costo_con    = E_con_kWh × precio_kwh
               + max_dem_con × cargo_demanda × 12
               + cargo_fijo_mensual × 12
               + p_nominal_kW × factor_respaldo × cargo_respaldo × 12

Ahorro = costo_sin - costo_con
```

**Diferencia vs GDMTH:** el max de demanda es el máximo de cualquier intervalo del mes (no solo horario punta).

### 2c — Cambios en `index.html` sección `#economia`

**Eliminar:**
- Los 3 inputs de precio por periodo: `precio-base`, `precio-intermedio`, `precio-punta`
- El toggle de verano `toggle-verano` y el panel `summer-tariff-panel`
- Los 3 inputs de precio verano: `precio-base-v`, `precio-intermedio-v`, `precio-punta-v`

**Agregar:**
- 1 input `precio-kwh` — Precio de Energía [$/kWh MXN], default 1.699
- Badge de estado de fetch: `"🔄 Última actualización: [fecha] · [División]"` o `"⚠️ Valores manuales"`
- Botón `"🔄 Actualizar tarifas desde CFE"` que llama `/api/cfe_gdmto`
- Si la página devuelve múltiples divisiones: mostrar un `<select>` con divisiones para que el usuario elija

**Actualizar:**
- Título de sección: `"GDMTH"` → `"GDMTO"`
- Descripción: actualizar texto explicativo
- Cargo por demanda: cambiar descripción a "máxima demanda registrada en el mes (cualquier hora)"
- `readEconomicParams()` en `solar_economics.js`: leer `precio_kwh` en vez de los 3 precios
- `renderEconomicResults()`: actualizar desglose de factura — mostrar Energía / Demanda / Cargo fijo en lugar de Base/Intermedio/Punta
- Tabla de desglose CFE: simplificar a 2 filas (Sin solar / Con solar) con columnas: Energía kWh, Costo energía, Cargo demanda, Cargo fijo, Total

---

## Cambio 3 — Padding entre Panel FV y Ángulos Óptimos

### Problema
El `<h3>` "🔆 Especificaciones del Panel FV" queda visualmente pegado al panel verde de Ángulos Óptimos que lo precede.

### Solución
En `index.html`, al `<h3>` de "Especificaciones del Panel FV" (~línea 993), cambiar de:
```html
<h3 style="font-size:0.85rem;color:var(--accent-orange);...;margin-bottom:1rem;">
```
a:
```html
<h3 style="font-size:0.85rem;color:var(--accent-orange);...;margin-top:2.5rem;margin-bottom:1rem;">
```

### Archivo afectado
- `index.html` línea ~993

---

## Cambio 4 — Bug NaN en T_cel (modo NASA y manual)

### Causa raíz
En `solar_app.js` líneas 1061–1067, el objeto `thermalParams` no incluye la propiedad `noct`:

```javascript
const thermalParams = useThermal ? {
    temp_verano:  parseFloat($('temp-amb-verano').value),
    temp_invierno:parseFloat($('temp-amb-invierno').value),
    hum_verano:   parseFloat($('hum-verano').value),
    hum_invierno: parseFloat($('hum-invierno').value),
    viento:       parseFloat($('viento-vel').value)
    // ← falta noct aquí
} : null;
```

La fórmula de display en línea 1212 accede `thermalParams.noct` → `undefined` → NaN.

### Solución
Agregar `noct` al objeto:
```javascript
noct: parseFloat($('input-NOCT').value),
```

### Archivo afectado
- `solar_app.js` línea ~1066

---

## Cambio 5 — NASA POWER: obtener RH2M junto con T2M

### Problema
Cuando se usa modo NASA POWER, el panel manual queda oculto y no hay forma de ingresar humedad relativa. El motor usa `RH = 0` por defecto, subestimando la temperatura de celda.

### Solución
**`fetchTambienteNASA(lat, lon)`** — cambiar para:
1. Pedir `T2M,RH2M` en la misma llamada a la API climatológica
2. Retornar `{ tamb_arr: Float64Array(35040), rh_arr: Float64Array(35040) }` en vez del array simple
3. Si `RH2M` no viene en la respuesta (fallo parcial): `rh_arr = null`

```javascript
async function fetchTambienteNASA(lat, lon) {
    const url = `...parameters=T2M,RH2M&community=RE&...`;
    const data = await res.json();
    const t2m = data.properties.parameter.T2M;
    const rh2m = data.properties.parameter.RH2M;  // puede ser undefined si falla
    // interpolate both to 35040 points
    return { tamb_arr, rh_arr };
}
```

**En `runSolar()`:**
- Detectar si `tamb_nasa_arr` es el objeto `{ tamb_arr, rh_arr }` o el array legacy
- Si tiene `rh_arr`, usarla en lugar de `thermalParams.hum_verano/invierno`

**En `runSolarEngine()`:**
- Aceptar `tamb_nasa_arr` como `{ tamb_arr, rh_arr }` o como array directo (compatibilidad)
- Si `rh_arr` disponible: `RH = rh_arr[idx]` en cada intervalo
- Fallback: seguir usando `thermalParams.hum_verano/invierno`

**En el panel NASA (`tamb-nasa-panel`):**
- Agregar un slider de humedad fallback visible solo cuando RH2M no esté disponible
- El `viento-vel` ya es siempre visible (correcto, no cambia)

**Display T_cel con NASA:**
- El cálculo de T_cel para mostrar en `thermal-result-content` usa la temperatura de verano del perfil NASA
- Reemplazar `thermalParams.temp_verano` por el promedio de mayo–octubre del perfil NASA descargado

### Archivos afectados
- `solar_app.js` — `fetchTambienteNASA()`, `runSolar()`, `runSolarEngine()`

---

## Cambio 6 — requirements.txt

Agregar:
```
requests
beautifulsoup4
```

---

## Archivos modificados

| Archivo | Cambios |
|---|---|
| `app.py` | Nuevo endpoint `GET /api/cfe_gdmto` |
| `requirements.txt` | `+requests`, `+beautifulsoup4` |
| `assets/js/solar_economics.js` | Nuevo `calcularFacturaCFEGDMTO()`, simplificar `readEconomicParams()`, actualizar `renderEconomicResults()` |
| `assets/js/solar_app.js` | Fix NaN (noct), fetch RH2M NASA, adaptar `runSolarEngine()` |
| `index.html` | Tabla guía (eta_ref), sección economía (GDMTO), padding Panel FV |
| `solar_engine.py` | Fix bug `'eta': eta` → `'eta': eta_ref` (línea 588) |

---

## Riesgos y notas

- **Parsing CFE:** La estructura HTML de `app.cfe.mx` puede cambiar sin aviso. El endpoint tiene fallback con valores CDMX 2025. Si la página devuelve múltiples divisiones, mostrar selector en UI.
- **NASA RH2M:** La API climatológica de NASA POWER sí incluye `RH2M`. Si en alguna coordenada fallan los datos, rh_arr será null y el fallback a los sliders manuales entra automáticamente.
- **Compatibilidad:** `calcularFacturaCFEGDMTO` reemplaza completamente a `calcularFacturaCFE` — no hay modo dual.
- **solar_engine.py bug:** línea 588 referencia `eta` que no existe en el scope. No afecta el cálculo (es solo el dict de stats) pero causa error al correr el backend Python. Se corrige como parte de esta tarea.
