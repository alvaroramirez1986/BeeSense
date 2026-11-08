/**
 * ============================================================================
 * PLANTILLA DE CONFIGURACIÓN CLOUD (AWS) - BEESENSE IoT (2026)
 * ============================================================================
 * INSTRUCCIONES:
 * 1. Copia este archivo como "config.js" en la raiz del proyecto web:
 *      cp config.example.js config.js
 * 2. Reemplaza los marcadores <YOUR_...> con tus propios recursos desplegados en AWS.
 * 3. El archivo "config.js" local no debe compartirse si contiene endpoints privados.
 */
window.BEESENSE_CONFIG = {
  // Modo Producción: oculta simuladores de sensores y fluctuaciones aleatorias
  PRODUCTION_MODE: true,
  ENABLE_SIMULATOR: false,

  // Identificador del dispositivo en DynamoDB (IoT_Hive_Telemetry -> device_id)
  COLMENAR_ID: "Hive_001",
  NOMBRE_COLMENAR: "Colmenar Principal",

  // Umbral crítico de batería (%) para alerta parpadeante
  BATTERY_ALERT_THRESHOLD: 10,

  // Umbral de inactividad (en segundos) para considerar el hardware Desconectado
  DEVICE_OFFLINE_THRESHOLD_SECONDS: 60,

  // 1. AMAZON API GATEWAY (HTTP API / REST API) -> LAMBDA -> DYNAMODB
  API_BASE_URL: "https://<YOUR_API_GATEWAY_ID>.execute-api.us-east-1.amazonaws.com",
  TELEMETRY_ROUTE: "/telemetry",
  SINGLE_ROUTE_MODE: true,
  POLLING_INTERVAL_MS: 5000,

  // 2. AMAZON COGNITO (Autenticación OIDC / OAuth 2.0 / User Pool JWT)
  COGNITO: {
    ENABLED: true,
    // Dominio de Managed Login / Hosted UI de Amazon Cognito
    DOMAIN: "<YOUR_COGNITO_DOMAIN>.auth.us-east-1.amazoncognito.com",
    // App Client ID público para SPA (sin client secret)
    CLIENT_ID: "<YOUR_COGNITO_APP_CLIENT_ID>",
    // Identificador del User Pool
    USER_POOL_ID: "us-east-1_XXXXXXXXX",
    // Authority OIDC del User Pool
    AUTHORITY: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_XXXXXXXXX",
    // URLs de redirección autorizadas en Cognito (CloudFront HTTPS)
    REDIRECT_URI: "https://<YOUR_CLOUDFRONT_DOMAIN>.cloudfront.net/",
    LOGOUT_URI: "https://<YOUR_CLOUDFRONT_DOMAIN>.cloudfront.net/",
    RESPONSE_TYPE: "code",
    SCOPE: "email openid profile",
    IDENTITY_PROVIDER: "",
  },

  // 3. AWS IoT CORE - WEBSOCKETS (Opcional)
  IOT_WSS: {
    ENABLED: false,
    WSS_URL: "",
    USE_PRESIGNED_ENDPOINT: false,
    MQTT_TOPIC: "hive/Hive_001/telemetry",
  },
};
