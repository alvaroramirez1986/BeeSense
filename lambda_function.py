"""
============================================================================
AWS LAMBDA (PYTHON 3.9): IoTHiveTelemetryAPI - BEESENSE IoT (PRODUCCIÓN)
============================================================================
Compatible con:
  1. Amazon API Gateway (HTTP API v2: IoT_Hive_HTTP_API / REST API v1)
  2. Invocación directa desde Regla de AWS IoT Core (MQTT -> Lambda 24/7)
  3. Amazon DynamoDB:
     - Tabla Telemetría : IoT_Hive_Telemetry (PK: device_id [S], SK: timestamp [N])
     - Tabla Alertas    : IoT_Hive_Events    (PK: device_id [S], SK: id [S])
  4. VozDigital SMS API : Variables de entorno seguras VD_API_KEY y VD_TELEFONO

Rutas HTTP soportadas (con CORS habilitado para CloudFront):
  - GET   /telemetry (o GET /) -> Última lectura + serie histórica de Hive_001
  - GET   /events              -> Historial persistente de alertas para Reportes y PDF
  - POST  /events              -> Registro de inicio de alerta en IoT_Hive_Events
  - PATCH /events/{id}         -> Cierre de alerta con fecha y hora de término
  - POST  /sms-alert           -> Disparo seguro de SMS vía VozDigital
"""

import datetime
import decimal
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

try:
    from zoneinfo import ZoneInfo

    CHILE_TZ = ZoneInfo("America/Santiago")
except Exception:
    CHILE_TZ = datetime.timezone(datetime.timedelta(hours=-3))

try:
    import boto3
    from boto3.dynamodb.conditions import Key
except ImportError:
    boto3 = None
    Key = None

TABLE_TELEMETRY_NAME = os.environ.get("TABLE_TELEMETRY", "IoT_Hive_Telemetry")
TABLE_EVENTS_NAME = os.environ.get("TABLE_EVENTS", "IoT_Hive_Events")
DEFAULT_DEVICE_ID = os.environ.get("DEFAULT_DEVICE_ID", "Hive_001")
NOMBRE_COLMENAR = os.environ.get("NOMBRE_COLMENAR", "Colmenar Principal - Sede PAO")

def _safe_env_float(var_name, default_val):
    raw = str(os.environ.get(var_name, "") or "").strip().replace("%", "").replace(",", ".")
    if not raw:
        return float(default_val)
    try:
        return float(raw)
    except Exception:
        return float(default_val)


TEMP_HIGH_LIMIT = _safe_env_float("TEMP_MAX_THRESHOLD", 36.0)
TEMP_LOW_LIMIT = _safe_env_float("TEMP_MIN_THRESHOLD", 15.0)
BATTERY_CRITICAL_LIMIT = _safe_env_float("BATTERY_ALERT_THRESHOLD", 10.0)

VD_BASE_URL = "https://portal.vozdigital.net/api/v1"
VD_API_KEY = os.environ.get("VD_API_KEY", "")
VD_TELEFONO = os.environ.get("VD_TELEFONO", "")

CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Requested-With",
    "Access-Control-Allow-Methods": "OPTIONS,GET,POST,PATCH",
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "Content-Type": "application/json; charset=utf-8",
}

_dynamodb = None


def get_dynamodb():
    global _dynamodb
    if _dynamodb is None and boto3 is not None:
        _dynamodb = boto3.resource("dynamodb")
    return _dynamodb


def decimal_to_native(obj):
    """Convierte objetos Decimal de DynamoDB a int o float estándar para JSON."""
    if isinstance(obj, list):
        return [decimal_to_native(x) for x in obj]
    if isinstance(obj, dict):
        return {k: decimal_to_native(v) for k, v in obj.items()}
    if isinstance(obj, decimal.Decimal):
        if obj % 1 == 0:
            return int(obj)
        return float(obj)
    return obj


def native_to_dynamodb(obj):
    """Convierte floats de Python a Decimal para escritura segura en DynamoDB."""
    if isinstance(obj, list):
        return [native_to_dynamodb(x) for x in obj]
    if isinstance(obj, dict):
        return {k: native_to_dynamodb(v) for k, v in obj.items()}
    if isinstance(obj, float):
        return decimal.Decimal(str(round(obj, 4)))
    return obj


def to_epoch_seconds(raw_ts):
    if raw_ts is None:
        return int(time.time())
    try:
        val = float(raw_ts)
        if val > 1e12:
            return int(val / 1000.0)
        return int(val)
    except Exception:
        try:
            dt = datetime.datetime.fromisoformat(str(raw_ts).replace("Z", "+00:00"))
            return int(dt.timestamp())
        except Exception:
            return int(time.time())


def format_chile_datetime(epoch_sec):
    dt = datetime.datetime.fromtimestamp(epoch_sec, tz=CHILE_TZ)
    hours24 = dt.hour
    period = "p. m." if hours24 >= 12 else "a. m."
    hours12 = hours24 % 12 or 12
    formatted = (
        f"{dt.day:02d}-{dt.month:02d}-{dt.year}, "
        f"{hours12}:{dt.minute:02d}:{dt.second:02d} {period}"
    )
    iso_date = f"{dt.year:04d}-{dt.month:02d}-{dt.day:02d}"
    hora24 = f"{hours24:02d}:{dt.minute:02d}"
    return formatted, iso_date, hora24, dt.isoformat()


def mask_phone(phone):
    clean = str(phone or "").strip()
    if len(clean) <= 4:
        return "****"
    return f"+{clean[:3]} **** {clean[-4:]}"


def send_vozdigital_sms(mensaje=None):
    """Envía SMS real vía VozDigital usando VD_API_KEY y VD_TELEFONO desde Lambda Env Vars."""
    api_key = os.environ.get("VD_API_KEY") or VD_API_KEY
    telefono = os.environ.get("VD_TELEFONO") or VD_TELEFONO
    texto = mensaje or f"ALERTA!!! Tapa de colmena abierta ({NOMBRE_COLMENAR})"

    if not api_key or not telefono:
        return {
            "ok": False,
            "status": 500,
            "messageId": None,
            "telefonoMasked": "Celular del apicultor",
            "error": "Configure VD_API_KEY y VD_TELEFONO en las variables de entorno de Lambda",
        }

    payload = json.dumps({"phone_number": telefono, "message": texto}).encode("utf-8")
    req = urllib.request.Request(
        f"{VD_BASE_URL}/sms/send",
        data=payload,
        method="POST",
        headers={"X-API-Key": api_key, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=12) as resp:
            body = json.loads(resp.read().decode("utf-8"))
            ok = resp.status == 200 and bool(body.get("success"))
            msg_id = body.get("data", {}).get("message_id") if isinstance(body.get("data"), dict) else None
            return {
                "ok": ok,
                "status": resp.status,
                "messageId": msg_id,
                "telefonoMasked": mask_phone(telefono),
            }
    except urllib.error.HTTPError as err:
        return {
            "ok": False,
            "status": err.code,
            "messageId": None,
            "telefonoMasked": mask_phone(telefono),
            "error": err.read().decode("utf-8", errors="replace"),
        }
    except Exception as exc:
        return {
            "ok": False,
            "status": 500,
            "messageId": None,
            "telefonoMasked": mask_phone(telefono),
            "error": str(exc),
        }


def parse_valid_float(val, min_v, max_v, valid_flag=True):
    if valid_flag is False or str(valid_flag).lower() == "false":
        return None
    if val is None or val == "" or str(val).upper() == "N/A" or str(val).lower() == "nan":
        return None
    try:
        num = float(val)
        if num < min_v or num > max_v:
            return None
        return num
    except Exception:
        return None


REAL_BEESENSE_KEYS = (
    "temperatura_interior_c",
    "temperatura_exterior_c",
    "humedad_exterior_pct",
    "tapa_abierta",
    "bateria_porcentaje_estimado",
    "bateria_lectura_valida",
    "bateria_voltaje_v",
    "temperatura_interior_valida",
    "tapa_lectura_valida",
    "evento",
    "timestamp_unix",
    "tempInterior",
    "tempExterior",
    "humedadExterior",
    "estadoTapa",
    "bateria",
)

# Umbral previo a la puesta en marcha del Arduino real (descarta semillas dummy 1728259200 / 1791013600)
LEGACY_SEED_CUTOFF_MS = 1793000000000


def is_real_beesense_item(raw):
    """Descarta registros semilla antiguos de prueba (ej. peso_kg / temperatura_interna) sin esquema BeeSense."""
    if not isinstance(raw, dict):
        return False
    if ("peso_kg" in raw or "temperatura_interna" in raw) and not (
        "temperatura_interior_c" in raw
        or "evento" in raw
        or "timestamp_unix" in raw
        or "bateria_lectura_valida" in raw
    ):
        return False
    return any(k in raw for k in REAL_BEESENSE_KEYS)


def is_legacy_seed_event(ev):
    """Detecta falsas alertas N/A derivadas de registros semilla antiguos previos al Arduino real."""
    if not isinstance(ev, dict):
        return False
    ev_id = str(ev.get("id") or "")
    if ev_id.startswith("EVT-NA-1728") or ev_id.startswith("EVT-NA-1791"):
        return True
    try:
        start_ms = int(ev.get("startTimestampMs") or 0)
    except Exception:
        start_ms = 0
    if ev_id.startswith("EVT-NA-") and 0 < start_ms < LEGACY_SEED_CUTOFF_MS:
        return True
    return False


def normalize_item(raw):
    """Normaliza una fila de IoT_Hive_Telemetry (Hive_001) para evaluación y respuesta JSON."""
    item = decimal_to_native(raw or {})
    ts_sec = to_epoch_seconds(
        item.get("timestamp") if item.get("timestamp") is not None else item.get("timestamp_unix")
    )

    temp_int = parse_valid_float(
        item.get("temperatura_interior_c", item.get("tempInterior")),
        -45.0,
        110.0,
        item.get("temperatura_interior_valida", True),
    )
    temp_ext = parse_valid_float(
        item.get("temperatura_exterior_c", item.get("tempExterior")),
        -45.0,
        110.0,
        item.get("temperatura_exterior_valida", True),
    )
    hum_ext = parse_valid_float(
        item.get("humedad_exterior_pct", item.get("humedadExterior")),
        0.0,
        100.0,
        item.get("humedad_exterior_valida", True),
    )
    bat_raw = parse_valid_float(
        item.get("bateria_porcentaje_estimado", item.get("bateria")),
        0.0,
        150.0,
        item.get("bateria_lectura_valida", True),
    )
    bat_pct = min(100.0, bat_raw) if bat_raw is not None else None

    estado_tapa = "N/A"
    if item.get("tapa_lectura_valida") is False:
        estado_tapa = "N/A"
    elif "tapa_abierta" in item:
        t_val = item.get("tapa_abierta")
        if t_val is None or str(t_val).upper() == "N/A":
            estado_tapa = "N/A"
        elif t_val is True or t_val == 1 or str(t_val).lower() == "true" or str(t_val).upper() == "ABIERTA":
            estado_tapa = "ABIERTA"
        else:
            estado_tapa = "Cerrada"
    elif "estadoTapa" in item:
        et = str(item.get("estadoTapa") or "N/A")
        if et.upper() == "N/A":
            estado_tapa = "N/A"
        elif et.upper() == "ABIERTA":
            estado_tapa = "ABIERTA"
        else:
            estado_tapa = "Cerrada"

    # Conserva tanto los campos originales del Arduino como los normalizados del Front-End
    enriched = dict(item)
    enriched.update(
        {
            "device_id": item.get("device_id") or item.get("colmenarId") or DEFAULT_DEVICE_ID,
            "timestamp": ts_sec,
            "tempInterior": temp_int,
            "tempExterior": temp_ext,
            "humedadExterior": hum_ext,
            "estadoTapa": estado_tapa,
            "bateria": bat_pct,
        }
    )
    return enriched


def evaluate_anomalies(norm_item):
    """Evalúa las 4 condiciones críticas solicitadas para alertas y Reportes."""
    device_id = norm_item.get("device_id") or DEFAULT_DEVICE_ID
    temp_int = norm_item.get("tempInterior")
    temp_ext = norm_item.get("tempExterior")
    hum_ext = norm_item.get("humedadExterior")
    tapa = norm_item.get("estadoTapa")
    bat = norm_item.get("bateria")

    anomalies = {}

    # 1. Temperatura Interior (> 36°C o < 15°C)
    if temp_int is not None and (temp_int > TEMP_HIGH_LIMIT or temp_int < TEMP_LOW_LIMIT):
        if temp_int > TEMP_HIGH_LIMIT:
            detalle = f"Temperatura interior crítica alta: {temp_int:.1f}°C (Umbral > {TEMP_HIGH_LIMIT:.0f}°C)"
        else:
            detalle = f"Temperatura interior crítica baja: {temp_int:.1f}°C (Umbral < {TEMP_LOW_LIMIT:.1f}°C)"
        anomalies["TEMPERATURA"] = ("Alerta Temperatura", detalle)

    # 2. Tapa Abierta -> ESTADO DE TAPADA + ALERTA CELULAR
    if tapa == "ABIERTA":
        anomalies["ESTADO DE TAPADA"] = (
            "Alerta Estado de Tapada",
            "Apertura física detectada: Tapa del colmenar principal ABIERTA",
        )
        anomalies["ALERTA CELULAR"] = (
            "Alerta Enviada al Celular",
            "Notificación SMS enviada al celular del apicultor por apertura de tapa de la colmena",
        )

    # 3. Batería menor a 10%
    if bat is not None and bat < BATTERY_CRITICAL_LIMIT:
        anomalies["ESTADO DE BATERIA"] = (
            "Alerta Estado de Batería",
            f"Nivel energético crítico (< {BATTERY_CRITICAL_LIMIT:.0f}%) en nodo {device_id}: {bat:.1f}%",
        )

    # 4. Sensor N/A
    missing = []
    if temp_int is None:
        missing.append("Temp. Interior (DS18B20)")
    if temp_ext is None:
        missing.append("Temp. Exterior (DHT22)")
    if hum_ext is None:
        missing.append("Humedad Exterior (DHT22)")
    if tapa == "N/A":
        missing.append("Sensor Tapa (Reed Switch)")
    if bat is None:
        missing.append("Batería (Lectura Inválida / ADC)")

    if missing:
        anomalies["N/A"] = (
            "Alerta Sensor Sin Señal (N/A)",
            f"Pérdida de conectividad (N/A) en: {', '.join(missing)} [Nodo {device_id}]",
        )

    return anomalies


CATEGORY_SLUGS = {
    "TEMPERATURA": "TEMP",
    "ESTADO DE TAPADA": "TAPA",
    "ALERTA CELULAR": "SMS",
    "ESTADO DE BATERIA": "BAT",
    "N/A": "NA",
}


def derive_episodes_from_telemetry(device_id, norm_items):
    """
    Reconstruye episodios completos de alertas (con fechaInicio y fechaTermino exactas)
    a partir de las lecturas reales de IoT_Hive_Telemetry, con IDs deterministas sin duplicados.
    """
    if not norm_items:
        return []

    chronological = sorted(norm_items, key=lambda x: x.get("timestamp", 0))
    active_by_cat = {}
    episodes = []

    for item in chronological:
        ts_sec = item.get("timestamp", int(time.time()))
        current_anomalies = evaluate_anomalies(item)

        # Abrir nuevos episodios
        for cat, (titulo, detalle) in current_anomalies.items():
            if cat not in active_by_cat:
                f_inicio, iso_date, hora24, _ = format_chile_datetime(ts_sec)
                slug = CATEGORY_SLUGS.get(cat, "EVT")
                ev = {
                    "device_id": device_id,
                    "colmenarId": device_id,
                    "id": f"EVT-{slug}-{ts_sec}",
                    "nombreColmenar": NOMBRE_COLMENAR,
                    "tipoEvento": cat,
                    "titulo": titulo,
                    "detalle": detalle,
                    "fechaInicio": f_inicio,
                    "fechaTermino": "En curso (Activa)",
                    "isoDate": iso_date,
                    "horaInicio24": hora24,
                    "estadoEvento": "ACTIVO",
                    "startTimestampMs": ts_sec * 1000,
                }
                active_by_cat[cat] = ev
                episodes.append(ev)

        # Cerrar episodios cuya condición volvió a la normalidad
        for cat in list(active_by_cat.keys()):
            if cat not in current_anomalies:
                ev = active_by_cat.pop(cat)
                f_fin, _, _, iso_fin = format_chile_datetime(ts_sec)
                ev["fechaTermino"] = f_fin
                ev["isoTermino"] = iso_fin
                ev["estadoEvento"] = "FINALIZADO"

    episodes.sort(key=lambda e: e.get("startTimestampMs", 0), reverse=True)
    return episodes


def build_chart_history(norm_items):
    """Genera hasta 10 puntos históricos preservando picos > 36°C."""
    if not norm_items:
        return []
    chronological = sorted(norm_items, key=lambda x: x.get("timestamp", 0))
    buckets = {}
    order = []
    for it in chronological:
        slot = int(it.get("timestamp", 0) // 600)
        if slot not in buckets:
            order.append(slot)
            buckets[slot] = it
        else:
            prev_t = buckets[slot].get("tempInterior")
            curr_t = it.get("tempInterior")
            if prev_t is not None and prev_t > TEMP_HIGH_LIMIT and (curr_t is None or curr_t <= TEMP_HIGH_LIMIT):
                continue
            buckets[slot] = it

    ten_min = [buckets[s] for s in order]
    if len(ten_min) >= 3:
        return ten_min[-10:]
    if len(chronological) <= 10:
        return chronological
    step = (len(chronological) - 1) / 9.0
    return [chronological[int(round(i * step))] for i in range(10)]


def query_recent_telemetry(device_id, limit=360):
    ddb = get_dynamodb()
    if ddb is None:
        return []
    table = ddb.Table(TABLE_TELEMETRY_NAME)
    resp = table.query(
        KeyConditionExpression=Key("device_id").eq(device_id),
        ScanIndexForward=False,
        Limit=max(1, min(int(limit), 1000)),
    )
    return [normalize_item(x) for x in resp.get("Items", []) if is_real_beesense_item(x)]


def query_stored_events(device_id):
    """Lee eventos permanentes desde IoT_Hive_Events (limpiando semillas antiguas de prueba si existieran)."""
    ddb = get_dynamodb()
    if ddb is None:
        return [], False
    try:
        table = ddb.Table(TABLE_EVENTS_NAME)
        resp = table.query(
            KeyConditionExpression=Key("device_id").eq(device_id),
            ScanIndexForward=False,
            Limit=300,
        )
        clean_items = []
        for raw_ev in resp.get("Items", []):
            ev = decimal_to_native(raw_ev)
            if is_legacy_seed_event(ev):
                try:
                    if ev.get("id"):
                        table.delete_item(Key={"device_id": device_id, "id": ev["id"]})
                except Exception:
                    pass
                continue
            clean_items.append(ev)
        return clean_items, True
    except Exception:
        return [], False


def sync_derived_events_to_table(device_id, derived_episodes, stored_events):
    """Guarda en IoT_Hive_Events cualquier alerta detectada en telemetría para que perdure en Reportes."""
    ddb = get_dynamodb()
    if ddb is None or not derived_episodes:
        return
    stored_by_id = {e.get("id"): e for e in stored_events if e.get("id")}
    try:
        table = ddb.Table(TABLE_EVENTS_NAME)
        for ep in derived_episodes:
            ep_id = ep.get("id")
            existing = stored_by_id.get(ep_id)
            if existing is None or (
                existing.get("estadoEvento") != "FINALIZADO" and ep.get("estadoEvento") == "FINALIZADO"
            ):
                # Si ya existía un detalle enriquecido con messageId de SMS, conservarlo al finalizar
                if existing and existing.get("detalle") and "[ID:" in str(existing.get("detalle")):
                    ep = dict(ep)
                    ep["detalle"] = existing["detalle"]
                table.put_item(Item=native_to_dynamodb(ep))
    except Exception:
        pass


def merge_events(stored_events, derived_episodes):
    merged = {}
    for ev in derived_episodes:
        if ev.get("id"):
            merged[ev["id"]] = ev
    for ev in stored_events:
        ev_id = ev.get("id")
        if not ev_id:
            continue
        if ev_id in merged:
            # Si el episodio derivado ya detectó término pero la fila guardada seguía ACTIVA, usar FINALIZADO
            if merged[ev_id].get("estadoEvento") == "FINALIZADO" and ev.get("estadoEvento") != "FINALIZADO":
                updated = dict(ev)
                updated["fechaTermino"] = merged[ev_id]["fechaTermino"]
                updated["isoTermino"] = merged[ev_id].get("isoTermino")
                updated["estadoEvento"] = "FINALIZADO"
                merged[ev_id] = updated
            else:
                merged[ev_id] = ev
        else:
            merged[ev_id] = ev

    result = list(merged.values())
    result.sort(
        key=lambda e: (int(e.get("startTimestampMs") or 0), str(e.get("id") or "")),
        reverse=True,
    )
    return result


def handle_iot_rule_event(raw_iot_payload):
    """
    Permite conectar esta misma Lambda a una Regla de AWS IoT Core (24/7 sin navegador abierto):
    persiste inicio/cierre de alertas en IoT_Hive_Events y envía SMS real cuando se abre la tapa.
    """
    if not is_real_beesense_item(raw_iot_payload):
        return {"statusCode": 200, "body": json.dumps({"ok": True, "ignored": "legacy_seed_schema"})}
    norm = normalize_item(raw_iot_payload)
    device_id = norm.get("device_id") or DEFAULT_DEVICE_ID
    ts_sec = norm.get("timestamp", int(time.time()))
    anomalies = evaluate_anomalies(norm)
    stored, table_ok = query_stored_events(device_id)
    if not table_ok:
        return {"statusCode": 200, "body": json.dumps({"ok": True, "note": "Tabla IoT_Hive_Events pendiente"})}

    ddb = get_dynamodb()
    table = ddb.Table(TABLE_EVENTS_NAME)
    active_by_cat = {
        e.get("tipoEvento"): e
        for e in stored
        if e.get("estadoEvento") == "ACTIVO" and e.get("tipoEvento")
    }

    for cat, (titulo, detalle) in anomalies.items():
        if cat not in active_by_cat:
            if cat == "ALERTA CELULAR":
                sms = send_vozdigital_sms(f"ALERTA!!! Tapa de colmena abierta ({NOMBRE_COLMENAR})")
                if sms.get("ok"):
                    id_tag = f" [ID: {sms['messageId']}]" if sms.get("messageId") else ""
                    detalle = (
                        f"SMS enviado al celular {sms['telefonoMasked']}{id_tag} "
                        f"por apertura de tapa de la colmena"
                    )
            f_inicio, iso_date, hora24, _ = format_chile_datetime(ts_sec)
            slug = CATEGORY_SLUGS.get(cat, "EVT")
            new_ev = {
                "device_id": device_id,
                "colmenarId": device_id,
                "id": f"EVT-{slug}-{ts_sec}",
                "nombreColmenar": NOMBRE_COLMENAR,
                "tipoEvento": cat,
                "titulo": titulo,
                "detalle": detalle,
                "fechaInicio": f_inicio,
                "fechaTermino": "En curso (Activa)",
                "isoDate": iso_date,
                "horaInicio24": hora24,
                "estadoEvento": "ACTIVO",
                "startTimestampMs": ts_sec * 1000,
            }
            table.put_item(Item=native_to_dynamodb(new_ev))

    for cat, active_ev in active_by_cat.items():
        if cat not in anomalies:
            f_fin, _, _, iso_fin = format_chile_datetime(ts_sec)
            updated = dict(active_ev)
            updated["fechaTermino"] = f_fin
            updated["isoTermino"] = iso_fin
            updated["estadoEvento"] = "FINALIZADO"
            table.put_item(Item=native_to_dynamodb(updated))

    return {"statusCode": 200, "body": json.dumps({"ok": True, "device_id": device_id})}


def json_response(status_code, payload):
    return {
        "statusCode": status_code,
        "headers": CORS_HEADERS,
        "body": json.dumps(decimal_to_native(payload), ensure_ascii=False),
    }


def lambda_handler(event, context):
    # 1. Detectar si la invocación proviene directamente de AWS IoT Core (sin contexto HTTP)
    if isinstance(event, dict) and "requestContext" not in event and "httpMethod" not in event:
        if "device_id" in event or "temperatura_interior_c" in event or "tapa_abierta" in event:
            return handle_iot_rule_event(event)

    method = (
        event.get("httpMethod")
        or event.get("requestContext", {}).get("http", {}).get("method")
        or "GET"
    ).upper()

    raw_path = event.get("rawPath") or event.get("path") or "/"
    path = raw_path.rstrip("/") or "/"
    qs = event.get("queryStringParameters") or {}
    path_params = event.get("pathParameters") or {}

    if method == "OPTIONS":
        return json_response(200, {"ok": True})

    device_id = (
        qs.get("device_id")
        or qs.get("colmenarId")
        or path_params.get("device_id")
        or DEFAULT_DEVICE_ID
    )
    action = str(qs.get("action") or "").strip().lower()

    try:
        # --------------------------------------------------------------------
        # RUTA A: SMS ALERT (POST /sms-alert o GET ?action=sms_alert sin preflight)
        # --------------------------------------------------------------------
        if action == "sms_alert" or (method == "POST" and path.endswith("/sms-alert")):
            body = json.loads(event.get("body") or "{}") if event.get("body") else {}
            colmenar = qs.get("nombreColmenar") or body.get("nombreColmenar") or NOMBRE_COLMENAR
            mensaje = (
                qs.get("mensaje")
                or body.get("mensaje")
                or f"ALERTA!!! Tapa de colmena abierta ({colmenar})"
            )
            sms_res = send_vozdigital_sms(mensaje)
            return json_response(200, sms_res)

        # --------------------------------------------------------------------
        # RUTA B: LISTAR EVENTOS (GET /events o GET ?action=events sin preflight)
        # --------------------------------------------------------------------
        if action == "events" or (method == "GET" and path.endswith("/events")):
            recent_tel = query_recent_telemetry(device_id, limit=500)
            derived = derive_episodes_from_telemetry(device_id, recent_tel)
            stored, table_exists = query_stored_events(device_id)
            if table_exists and derived:
                sync_derived_events_to_table(device_id, derived, stored)
            combined = merge_events(stored, derived)
            return json_response(
                200,
                {
                    "device_id": device_id,
                    "eventsTableActive": table_exists,
                    "count": len(combined),
                    "items": combined,
                },
            )

        # --------------------------------------------------------------------
        # RUTA C: GUARDAR INICIO DE EVENTO (POST /events o GET ?action=save_event)
        # --------------------------------------------------------------------
        if action == "save_event" or (method == "POST" and path.endswith("/events")):
            if qs.get("payload"):
                body = json.loads(qs.get("payload"))
            else:
                body = json.loads(event.get("body") or "{}")
            target_device = body.get("device_id") or body.get("colmenarId") or device_id
            stored, table_exists = query_stored_events(target_device)

            # Evitar duplicar si ya existe un evento ACTIVO de la misma categoría
            cat = body.get("tipoEvento")
            for ev in stored:
                if ev.get("estadoEvento") == "ACTIVO" and ev.get("tipoEvento") == cat:
                    return json_response(200, {"saved": True, "deduplicated": True, "item": ev})

            now_sec = int(time.time())
            f_inicio, iso_date, hora24, _ = format_chile_datetime(now_sec)
            item = {
                "device_id": target_device,
                "colmenarId": target_device,
                "id": body.get("id") or f"EVT-{now_sec}",
                "nombreColmenar": body.get("nombreColmenar") or NOMBRE_COLMENAR,
                "tipoEvento": cat or "N/A",
                "titulo": body.get("titulo") or "Alerta Registrada",
                "detalle": body.get("detalle") or "",
                "fechaInicio": body.get("fechaInicio") or f_inicio,
                "fechaTermino": body.get("fechaTermino") or "En curso (Activa)",
                "isoDate": body.get("isoDate") or iso_date,
                "horaInicio24": body.get("horaInicio24") or hora24,
                "estadoEvento": body.get("estadoEvento") or "ACTIVO",
                "startTimestampMs": body.get("startTimestampMs") or (now_sec * 1000),
            }
            if table_exists:
                ddb = get_dynamodb()
                ddb.Table(TABLE_EVENTS_NAME).put_item(Item=native_to_dynamodb(item))
            return json_response(200, {"saved": table_exists, "item": item})

        # --------------------------------------------------------------------
        # RUTA D: CERRAR EVENTO (PATCH /events/{id} o GET ?action=close_event)
        # --------------------------------------------------------------------
        if action == "close_event" or (method == "PATCH" and "/events/" in path):
            raw_id = qs.get("id") or path_params.get("id") or path.split("/events/")[-1]
            event_id = urllib.parse.unquote(str(raw_id))
            body = json.loads(event.get("body") or "{}") if event.get("body") else {}
            target_device = body.get("device_id") or body.get("colmenarId") or device_id
            now_sec = int(time.time())
            f_fin, _, _, iso_fin = format_chile_datetime(now_sec)
            final_fecha_termino = qs.get("fechaTermino") or body.get("fechaTermino") or f_fin
            final_iso_termino = qs.get("isoTermino") or body.get("isoTermino") or iso_fin

            ddb = get_dynamodb()
            if ddb is not None:
                try:
                    ddb.Table(TABLE_EVENTS_NAME).update_item(
                        Key={"device_id": target_device, "id": event_id},
                        UpdateExpression="SET fechaTermino = :ft, isoTermino = :it, estadoEvento = :st",
                        ExpressionAttributeValues={
                            ":ft": final_fecha_termino,
                            ":it": final_iso_termino,
                            ":st": "FINALIZADO",
                        },
                    )
                except Exception:
                    pass
            return json_response(200, {"updated": True, "id": event_id})

        # --------------------------------------------------------------------
        # RUTA E (DEFAULT GET): /telemetry, /, /hive/{device_id}, /items
        # Consulta IoT_Hive_Telemetry en tiempo real + devuelve alertas sincronizadas
        # --------------------------------------------------------------------
        limit = int(qs.get("limit") or 360)
        items_desc = query_recent_telemetry(device_id, limit=max(limit, 120))
        latest = items_desc[0] if items_desc else None
        history = build_chart_history(items_desc)

        derived = derive_episodes_from_telemetry(device_id, items_desc) if items_desc else []
        stored, table_exists = query_stored_events(device_id)
        if table_exists and derived:
            sync_derived_events_to_table(device_id, derived, stored)
        combined_events = merge_events(stored, derived)

        return json_response(
            200,
            {
                "device_id": device_id,
                "latest": latest,
                "history": history,
                "items": items_desc[:30],
                "events": combined_events,
                "eventsTableActive": table_exists,
                "count": len(items_desc),
            },
        )

    except Exception as err:
        return json_response(200, {"ok": False, "error": str(err), "device_id": device_id})


# Alias compatibles por si el arquitecto configuró otro nombre de función en el Handler
handler = lambda_handler
main = lambda_handler
get_telemetry = lambda_handler


