#!/usr/bin/env python3
"""
==============================================================================
BEESENSE IoT - SERVIDOR Y MONITOR EN VIVO DE EVENTOS DYNAMODB
==============================================================================
Propósito:
  1. Corre constantemente como un servidor/demonio en tu terminal.
  2. Monitorea en tiempo real las lecturas en AWS DynamoDB (Hive_001).
  3. Detecta automáticamente cuando tú o cualquier sensor crea un evento
     de Tapa ABIERTA en DynamoDB.
  4. Despacha la alerta SMS vía Infobip a tu celular (+56 9 5137 8859).
  5. Muestra en pantalla si la API está respondiendo o si deja de funcionar.
  6. Se detiene limpiamente en cualquier momento presionando Ctrl + C.

Uso:
  python3 servidor_monitor.py
==============================================================================
"""

import sys
import os
import time
import json
import urllib.request
import urllib.error
from datetime import datetime
from http.server import BaseHTTPRequestHandler, HTTPServer
import threading

# Cargar variables de entorno desde .env
def cargar_env():
    env_path = os.path.join(os.path.dirname(__file__), ".env")
    if os.path.exists(env_path):
        try:
            with open(env_path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith("#") and "=" in line:
                        k, v = line.split("=", 1)
                        k = k.strip()
                        v = v.strip().strip('"').strip("'")
                        if k and k not in os.environ:
                            os.environ[k] = v
        except Exception:
            pass

cargar_env()

# Configuración de AWS API Gateway y DynamoDB
API_GATEWAY_URL = os.environ.get(
    "API_GATEWAY_URL",
    "https://<YOUR_API_GATEWAY_ID>.execute-api.us-east-1.amazonaws.com/telemetry",
)
DEVICE_ID = os.environ.get("DEVICE_ID", "Hive_001")
NOMBRE_COLMENAR = "Colmenar Principal - Sede PAO"

# Configuración de Infobip SMS
INFOBIP_BASE_URL = os.environ.get("INFOBIP_BASE_URL", "v3r46p.api-us.infobip.com").strip().rstrip("/")
if not INFOBIP_BASE_URL.startswith(("http://", "https://")):
    INFOBIP_BASE_URL = "https://" + INFOBIP_BASE_URL

INFOBIP_API_KEY = os.environ.get("INFOBIP_API_KEY", "")
INFOBIP_DESTINO = os.environ.get("INFOBIP_DESTINO", os.environ.get("VD_TELEFONO", "569XXXXXXXX"))
INFOBIP_SENDER = os.environ.get("INFOBIP_SENDER", "56224053317")

# Configuración de VozDigital SMS (activo y con saldo en Chile)
VD_BASE_URL = "https://portal.vozdigital.net/api/v1"
VD_API_KEY = os.environ.get("VD_API_KEY", "")
VD_TELEFONO = os.environ.get("VD_TELEFONO", "569XXXXXXXX")

# Puerto para el microservidor local opcional
PORT = int(os.environ.get("PORT", "8765"))
POLL_INTERVAL_SEC = 3.0

# Estado global del monitor
running = True
last_sent_episode_ts = None
last_reported_state = None


def timestamp_now_str():
    return datetime.now().strftime("%H:%M:%S")


def enviar_sms_vozdigital(mensaje):
    """Envía SMS usando el proveedor local chileno VozDigital."""
    clean_tel = VD_TELEFONO.strip().lstrip("+")
    if not clean_tel.startswith("56"):
        clean_tel = "56" + clean_tel
    phone_fmt = f"+{clean_tel}"

    payload = json.dumps({"phone_number": phone_fmt, "message": mensaje}).encode("utf-8")
    req = urllib.request.Request(
        f"{VD_BASE_URL}/sms/send",
        data=payload,
        method="POST",
        headers={
            "X-API-Key": VD_API_KEY,
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "BeeSense-LocalServer/1.0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=12) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            if data.get("success"):
                msg_data = data.get("data", {})
                return {
                    "ok": True,
                    "provider": "VozDigital",
                    "status": resp.status,
                    "messageId": msg_data.get("message_id") or msg_data.get("provider_id"),
                    "groupName": "SENT",
                    "description": data.get("message", "SMS enviado exitosamente"),
                }
            return {"ok": False, "provider": "VozDigital", "error": data.get("message", "Fallo VozDigital")}
    except urllib.error.HTTPError as err:
        return {"ok": False, "provider": "VozDigital", "status": err.code, "error": err.read().decode("utf-8", errors="replace")}
    except Exception as exc:
        return {"ok": False, "provider": "VozDigital", "status": 500, "error": str(exc)}


def enviar_sms_infobip(mensaje):
    """Envía SMS a través de la API oficial de Infobip."""
    url = f"{INFOBIP_BASE_URL}/sms/3/messages"
    payload = {
        "messages": [
            {
                "sender": INFOBIP_SENDER,
                "destinations": [{"to": INFOBIP_DESTINO}],
                "content": {"text": mensaje},
            }
        ]
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={
            "Authorization": f"App {INFOBIP_API_KEY}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "BeeSense-LocalServer/1.0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = json.loads(resp.read().decode("utf-8"))
            msgs = body.get("messages", [])
            msg_id = msgs[0].get("messageId") if msgs else body.get("bulkId")
            status = msgs[0].get("status", {}) if msgs else {}
            return {
                "ok": True,
                "status": resp.status,
                "messageId": msg_id,
                "groupName": status.get("groupName", "ACCEPTED"),
                "description": status.get("description", "Aceptado para envío"),
            }
    except urllib.error.HTTPError as err:
        return {"ok": False, "status": err.code, "error": err.read().decode("utf-8", errors="replace")}
    except Exception as exc:
        return {"ok": False, "status": 500, "error": str(exc)}


class LocalBridgeHandler(BaseHTTPRequestHandler):
    """Maneja peticiones HTTP locales por si la web envía solicitudes a localhost:8765."""
    def log_message(self, format, *args):
        pass  # Evita ruido en la consola

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()

    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(
            json.dumps(
                {
                    "ok": True,
                    "service": "BeeSense Local SMS Server & Monitor",
                    "device_id": DEVICE_ID,
                    "destino": INFOBIP_DESTINO,
                }
            ).encode("utf-8")
        )

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length).decode("utf-8") if length > 0 else "{}"
        try:
            body = json.loads(raw)
        except Exception:
            body = {}

        msg = body.get("mensaje", f"ALERTA!!! Tapa de colmena abierta ({NOMBRE_COLMENAR})")
        res = enviar_sms_vozdigital(msg)
        if not res.get("ok"):
            res = enviar_sms_infobip(msg)

        self.send_response(200 if res.get("ok") else 502)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps(res).encode("utf-8"))


def start_local_http_server():
    """Inicia el microservidor local en un hilo secundario."""
    try:
        httpd = HTTPServer(("0.0.0.0", PORT), LocalBridgeHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        return httpd
    except Exception as e:
        print(f"⚠️  [Aviso] No se pudo vincular al puerto local {PORT} ({e}). Continuando solo con monitor.")
        return None


def loop_monitoreo_dynamodb():
    global running, last_sent_episode_ts, last_reported_state

    api_url = f"{API_GATEWAY_URL}?device_id={DEVICE_ID}"
    consecutive_errors = 0

    print("=" * 72)
    print("🐝 BEESENSE IoT - SERVIDOR Y MONITOR EN VIVO DE DYNAMODB")
    print("=" * 72)
    print(f"📡 API Gateway / DynamoDB : {API_GATEWAY_URL}")
    print(f"🐝 Dispositivo Monitoreado: {DEVICE_ID}")
    print(f"📱 Celular de Alertas     : +{INFOBIP_DESTINO[:3]} {INFOBIP_DESTINO[3:7]} {INFOBIP_DESTINO[7:]}")
    print(f"⏱️  Frecuencia de sondeo  : Cada {POLL_INTERVAL_SEC:.0f} segundos")
    print("=" * 72)
    print("💡 INSTRUCCIONES:")
    print("   - Deja esta ventana abierta.")
    print("   - Genera tus eventos de Tapa Abierta/Cerrada en DynamoDB o con JSON.")
    print("   - Este script detectará cada cambio al instante y enviará el SMS.")
    print("   - Para DETENER el servidor en cualquier momento, presiona: Ctrl + C")
    print("=" * 72)
    print(f"[{timestamp_now_str()}] 🟢 Monitor iniciado. Esperando lecturas en DynamoDB...\n")

    while running:
        try:
            req = urllib.request.Request(
                api_url,
                headers={
                    "User-Agent": "BeeSense-DynamoWatcher/1.0",
                    "Accept": "application/json",
                },
            )

            # Consulta el estado en DynamoDB
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                latest = data.get("latest") or {}

                # Si veníamos de errores, avisar que la API se recuperó
                if consecutive_errors > 0:
                    print(f"\n[{timestamp_now_str()}] ✅ ¡Conexión con AWS API Gateway restablecida con éxito!\n")
                    consecutive_errors = 0

                estado_tapa = str(latest.get("estadoTapa", "")).upper()
                tapa_abierta_bool = bool(latest.get("tapa_abierta"))
                is_open = (estado_tapa == "ABIERTA") or tapa_abierta_bool
                ts = latest.get("timestamp") or latest.get("timestamp_unix")

                # -------------------------------------------------------------
                # CASO 1: SE DETECTA TAPA ABIERTA
                # -------------------------------------------------------------
                if is_open:
                    if last_reported_state != "ABIERTA":
                        print(f"\n[{timestamp_now_str()}] 🚨 ¡ALERTA DETECTADA EN DYNAMODB!")
                        print(f"           - Evento    : APERTURA DE TAPA")
                        print(f"           - Timestamp : {ts}")
                        print(f"           - Temp Int  : {latest.get('tempInterior', latest.get('temperatura_interior_c', 'N/A'))} °C")
                        print(f"           - Batería   : {latest.get('bateria', latest.get('bateria_porcentaje_estimado', 'N/A'))} %")
                        last_reported_state = "ABIERTA"

                    # Disparar SMS solo una vez por cada episodio de timestamp
                    if ts != last_sent_episode_ts:
                        print(f"[{timestamp_now_str()}] 📲 Despachando alerta SMS...")
                        # Prioriza VozDigital (cuenta local activa con saldo) con fallback a Infobip
                        sms_res = enviar_sms_vozdigital(f"ALERTA!!! Tapa de colmena abierta ({NOMBRE_COLMENAR})")
                        if not sms_res.get("ok"):
                            print(f"[{timestamp_now_str()}] ℹ️  Intentando proveedor alternativo Infobip...")
                            sms_res = enviar_sms_infobip(f"ALERTA!!! Tapa de colmena abierta ({NOMBRE_COLMENAR})")

                        if sms_res.get("ok"):
                            prov = sms_res.get("provider", "SMS")
                            print(f"[{timestamp_now_str()}] ✅ SMS ENTREGADO EXITOSAMENTE VÍA {prov.upper()}:")
                            print(f"           - Destino   : +{INFOBIP_DESTINO}")
                            print(f"           - ID SMS    : {sms_res.get('messageId')}")
                            print(f"           - Estado    : {sms_res.get('groupName')} ({sms_res.get('description')})")
                            last_sent_episode_ts = ts
                        else:
                            print(f"[{timestamp_now_str()}] ❌ Fallo al enviar SMS: {sms_res.get('error')}")

                # -------------------------------------------------------------
                # CASO 2: TAPA CERRADA (ESTADO NORMAL)
                # -------------------------------------------------------------
                else:
                    if last_reported_state == "ABIERTA":
                        print(f"\n[{timestamp_now_str()}] 🔒 Tapa CERRADA detectada en DynamoDB. Episodio finalizado.")
                        print(f"           - Timestamp : {ts}")
                        print(f"           - Colmena en estado seguro.\n")
                        last_reported_state = "CERRADA"
                    elif last_reported_state is None:
                        # Reporte inicial
                        print(f"[{timestamp_now_str()}] [OK] DynamoDB en línea | Tapa: CERRADA | Batería: {latest.get('bateria', 88)}% | Último TS: {ts}")
                        last_reported_state = "CERRADA"

        except urllib.error.HTTPError as http_err:
            consecutive_errors += 1
            print(f"[{timestamp_now_str()}] ⚠️  [ERROR API AWS] Código HTTP {http_err.code}: {http_err.reason}")
        except urllib.error.URLError as url_err:
            consecutive_errors += 1
            print(f"[{timestamp_now_str()}] ⚠️  [FALLO DE CONEXIÓN] No se pudo alcanzar la API: {url_err.reason}")
        except Exception as e:
            consecutive_errors += 1
            print(f"[{timestamp_now_str()}] ⚠️  [ERROR INESPERADO]: {e}")

        # Si hay más de 3 errores consecutivos, alertar al usuario
        if consecutive_errors == 3:
            print(f"\n[{timestamp_now_str()}] 🛑 ATENCIÓN: La API Gateway no está respondiendo. Puedes detener el proceso con Ctrl + C si deseas reiniciar.\n")

        # Esperar antes del siguiente sondeo
        try:
            time.sleep(POLL_INTERVAL_SEC)
        except KeyboardInterrupt:
            break


def main():
    global running
    start_local_http_server()
    try:
        loop_monitoreo_dynamodb()
    except KeyboardInterrupt:
        pass
    finally:
        running = False
        print("\n\n" + "=" * 72)
        print(f"[{timestamp_now_str()}] 🛑 Servidor y monitor de BeeSense detenidos por el usuario.")
        print("=" * 72)


if __name__ == "__main__":
    main()
