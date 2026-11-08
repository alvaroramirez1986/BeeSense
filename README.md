# BeeSense IoT — Sistema de Monitoreo Apícola en Tiempo Real

Plataforma integral de telemetría ambiental, seguridad física anti-apertura y gestión agro-apícola en tiempo real para colmenas (*Apis mellifera*), desarrollada con arquitectura Serverless en Amazon Web Services (AWS), nodo IoT de campo con microcontrolador ESP32 y aplicación web responsiva (Single Page Application).

---

## 🏗️ Arquitectura General del Sistema

El ecosistema BeeSense está compuesto por cuatro subsistemas desacoplados:

1. **Hardware / Nodo IoT de Campo (ESP32 DevKit):**
   - Sensores de microclima exterior: DHT11 (temperatura y humedad relativa).
   - Sensor de microclima interior: Sonda digital sumergible Dallas DS18B20 (cámara de cría).
   - Sensor de seguridad: Módulo fotorresistivo LDR (detección instantánea de apertura de tapa).
   - Monitor de energía: Divisor de tensión resistivo (batería Li-ion 18650 con curva de descarga de 14 puntos).
   - Interfaz local: Pantalla OLED SSD1306 (128×64 px) I2C con 4 vistas y alertas prioritarias.
   - Conectividad: Wi-Fi con portal cautivo (`WiFiManager`), NTP (zona horaria Chile) y publicación MQTT segura bajo TLS 1.2+ con autenticación mutua (mTLS) hacia AWS IoT Core (puerto 8883).

2. **Infraestructura Cloud Serverless (AWS us-east-1):**
   - **AWS IoT Core:** Broker MQTT e ingestión de telemetría de campo (`telemetry/Hive_001`).
   - **Amazon DynamoDB:** Almacenamiento NoSQL para telemetría histórica (`IoT_Hive_Telemetry`) y ciclo de vida de eventos/anomalías.
   - **AWS Lambda (`lambda_function.py`):** Backend serverless (`IoTHiveTelemetryAPI`) que multiplexa consultas de telemetría, persistencia de eventos y alertas SMS.
   - **Amazon API Gateway:** Exposición de endpoints REST / HTTP API v2 con baja latencia.
   - **Amazon Cognito:** Autenticación de usuarios vía OAuth 2.0 / OIDC con flujo Authorization Code + PKCE (S256).
   - **Amazon S3 + CloudFront:** Hosting estático HTTPS y distribución global con CDN.

3. **Aplicación Web Front-End (SPA React 18):**
   - Dashboard en tiempo real con 4 tarjetas de KPI métricas, umbral térmico (36 °C) y gráficos vectoriales SVG.
   - Módulo de Análisis Meteorológico integrado con Open-Meteo API (31 zonas apícolas de Chile e Índice de Vuelo Apícola).
   - Módulo de Reportes Históricos con filtrado, deduplicación de eventos y exportación oficial a PDF (`jsPDF`).
   - Gestión de Perfil de Colmena y respaldo automático de disparo SMS.

4. **Servidor Monitor y Pasarela SMS en Python (`servidor_monitor.py`):**
   - Demonio de vigilancia en vivo contra API Gateway / DynamoDB (cada 3 s).
   - Microservidor HTTP puente en `http://0.0.0.0:8765` para permitir a la app web despachar SMS locales ante aperturas de tapa.
   - Doble pasarela SMS con redundancia: **VozDigital** (primario) e **Infobip** (conmutación automática de respaldo).

---

## 📁 Estructura del Repositorio

```text
BeeSense/
├── index.html                   # Punto de entrada HTML5 de la aplicación web SPA
├── 404.html                     # Manejo estático de rutas SPA y fallback en CloudFront
├── preview-fondo-cognito.html   # Entorno de previsualización de fondos y estilos
├── config.example.js            # Plantilla de configuración de la app web (AWS / Cognito)
├── config.js                    # [Privado - .gitignore] Configuración local de producción
├── lambda_function.py           # Código fuente de AWS Lambda (IoTHiveTelemetryAPI)
├── servidor_monitor.py          # Script monitor en Python y microservidor puente SMS
├── .env.example                 # Plantilla de variables de entorno para el monitor
├── .env                         # [Privado - .gitignore] Variables locales del monitor
├── DOCUMENTACION_BEESENSE_IoT.md# Documentación técnica integral exhaustiva (9 secciones)
├── .gitignore                   # Exclusión estricta de secretos, certificados y caches
├── assets/                      # Logotipos, fondos apícolas vectoriales y rasterizados
├── css/
│   └── styles.css               # Estilos globales, paleta de colores y animaciones
├── js/
│   ├── app.js                   # Núcleo de la SPA (React 18 UMD, 6.300+ líneas)
│   └── logo-base64.js           # Activo en base64 para generación de reportes PDF
└── ESP32/
    ├── BeeSense_Codigo13_Monitoreo_Apicola_MQTT.ino # Firmware C++ para ESP32
    ├── secrets.example.h        # Plantilla para certificados y llaves de AWS IoT
    └── secrets.h                # [Privado - .gitignore] Claves reales locales del hardware
```

---

## 🚀 Guía Rápida de Configuración y Puesta en Marcha

### 1. Configuración de la Aplicación Web

Copia la plantilla de configuración e ingresa tus identificadores de AWS y Cognito:

```bash
cp config.example.js config.js
```

Edita `config.js` con tus endpoints:
- `API_BASE_URL`: URL base de tu Amazon API Gateway.
- `COGNITO.DOMAIN`, `CLIENT_ID`, `USER_POOL_ID`: Datos de tu Amazon Cognito User Pool.
- `REDIRECT_URI`: Dominio CloudFront o URL de despliegue.

Para desarrollo local, puedes abrir directamente `index.html` en el navegador o levantarlo con cualquier servidor HTTP local:
```bash
python3 -m http.server 8080
```

### 2. Configuración del Hardware ESP32

1. Abre el directorio `ESP32/` en Arduino IDE.
2. Crea tu archivo de claves a partir de la plantilla:
   ```bash
   cp ESP32/secrets.example.h ESP32/secrets.h
   ```
3. Pega en `ESP32/secrets.h` tu endpoint de AWS IoT Core, tu certificado X.509 de dispositivo y tu clave privada RSA.
4. Conecta tu ESP32 por USB y compila el sketch `BeeSense_Codigo13_Monitoreo_Apicola_MQTT.ino`.
5. Al encender por primera vez, conéctate a la red Wi-Fi `BeeSense-Config` desde tu celular o PC y configura la red local de tu apiario.

### 3. Configuración del Servidor Monitor y Pasarela SMS

1. Crea el archivo de variables de entorno:
   ```bash
   cp .env.example .env
   ```
2. Completa tu `API_GATEWAY_URL`, número de celular de destino y credenciales de SMS (**VozDigital** o **Infobip**).
3. Inicia el monitor:
   ```bash
   python3 servidor_monitor.py
   ```

---

## 🔒 Seguridad y Buenas Prácticas

Este repositorio sigue el estándar de segregación de secretos:
- Todos los certificados X.509 (`*.pem`, `*.crt`), llaves privadas (`*.key`, `secrets.h`) y variables de entorno (`.env`) están estrictamente ignorados por `.gitignore`.
- Las plantillas `.example` permiten desplegar réplicas del sistema sin comprometer las credenciales de hardware ni las infraestructuras cloud en vivo.

---

## 📖 Documentación Técnica Completa

Para una descripción detallada de diagramas de arquitectura, pinout eléctrico, normalización de datos en DynamoDB, curvas Li-ion y auditoría de código, consulta el documento:
👉 **[DOCUMENTACION_BEESENSE_IoT.md](DOCUMENTACION_BEESENSE_IoT.md)**
