#pragma once
#include <Arduino.h>

/**
 * ============================================================================
 * PLANTILLA DE CONFIGURACIÓN SEGURA - BEESENSE ESP32 (CODIGO 13)
 * ============================================================================
 * INSTRUCCIONES:
 * 1. Copia este archivo con el nombre "secrets.h" en este mismo directorio:
 *      cp secrets.example.h secrets.h
 * 2. Reemplaza los textos PEGA_AQUI con tus credenciales reales de AWS IoT Core.
 * 3. El archivo "secrets.h" esta protegido por .gitignore y NUNCA debe subirse
 *    a ningun repositorio publico.
 */

// Endpoint de datos obtenido desde AWS IoT Core (Configuracion -> Endpoint de datos del dispositivo)
// No incluir https:// ni una barra al final.
const char* AWS_IOT_ENDPOINT = "xxxxxx-ats.iot.us-east-1.amazonaws.com";

// Certificado X.509 emitido por AWS IoT para tu Thing (ej. Hive_001.cert.pem)
static const char AWS_DEVICE_CERT[] PROGMEM = R"PEM(
-----BEGIN CERTIFICATE-----
PEGA_AQUI_TU_CERTIFICADO_X509_DE_DISPOSITIVO
-----END CERTIFICATE-----
)PEM";

// Clave privada RSA del dispositivo (ej. Hive_001.private.key)
static const char AWS_PRIVATE_KEY[] PROGMEM = R"PEM(
-----BEGIN RSA PRIVATE KEY-----
PEGA_AQUI_TU_CLAVE_PRIVADA_RSA
-----END RSA PRIVATE KEY-----
)PEM";
