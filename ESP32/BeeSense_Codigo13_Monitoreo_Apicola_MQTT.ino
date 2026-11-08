// =====================================================
// BeeSense - Sistema de Monitoreo Apicola IoT
// CODIGO 13 - MQTT SEGURO + AWS IoT Core
// Basado en Codigo 12B. Mantiene sensores, OLED, WiFiManager y bateria.
//
// DHT11     -> temperatura + humedad EXTERIOR
// DS18B20   -> temperatura INTERIOR
// LDR       -> estado de tapa
// OLED      -> logo BeeSense + 4 pantallas
// WiFi      -> WiFiManager (configuracion sin cambiar codigo)
// NTP       -> hora y fecha
// BATERIA   -> estimacion por divisor resistivo en GPIO35
// =====================================================

#include <WiFi.h>
#include <WiFiManager.h>
#include <espMqttClient.h>
#include <string.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <DHT.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <time.h>

// =====================================================
// HORA / FECHA
// =====================================================

const char* ntpServer1 = "pool.ntp.org";
const char* ntpServer2 = "time.nist.gov";
const char* timezone =
  "CLT4CLST,M9.1.6/24,M4.1.6/24";

// =====================================================
// AWS IOT CORE - COMPLETAR ANTES DE USAR
// =====================================================

// Debe coincidir exactamente con el Thing y el client ID autorizado por la politica.
const char* THING_NAME = "Hive_001";

// Debe coincidir exactamente con el topic autorizado en BeeSenseApicolaPolicy.
const char* MQTT_TOPIC = "telemetry/Hive_001";

// Certificado raiz publico de Amazon Root CA 1
static const char AWS_ROOT_CA[] PROGMEM = R"PEM(
-----BEGIN CERTIFICATE-----
MIIDQTCCAimgAwIBAgITBmyfz5m/jAo54vB4ikPmljZbyjANBgkqhkiG9w0BAQsF
ADA5MQswCQYDVQQGEwJVUzEPMA0GA1UEChMGQW1hem9uMRkwFwYDVQQDExBBbWF6
b24gUm9vdCBDQSAxMB4XDTE1MDUyNjAwMDAwMFoXDTM4MDExNzAwMDAwMFowOTEL
MAkGA1UEBhMCVVMxDzANBgNVBAoTBkFtYXpvbjEZMBcGA1UEAxMQQW1hem9uIFJv
b3QgQ0EgMTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBALJ4gHHKeNXj
ca9HgFB0fW7Y14h29Jlo91ghYPl0hAEvrAIthtOgQ3pOsqTQNroBvo3bSMgHFzZM
9O6II8c+6zf1tRn4SWiw3te5djgdYZ6k/oI2peVKVuRF4fn9tBb6dNqcmzU5L/qw
IFAGbHrQgLKm+a/sRxmPUDgH3KKHOVj4utWp+UhnMJbulHheb4mjUcAwhmahRWa6
VOujw5H5SNz/0egwLX0tdHA114gk957EWW67c4cX8jJGKLhD+rcdqsq08p8kDi1L
93FcXmn/6pUCyziKrlA4b9v7LWIbxcceVOF34GfID5yHI9Y/QCB/IIDEgEw+OyQm
jgSubJrIqg0CAwEAAaNCMEAwDwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMC
AYYwHQYDVR0OBBYEFIQYzIU07LwMlJQuCFmcx7IQTgoIMA0GCSqGSIb3DQEBCwUA
A4IBAQCY8jdaQZChGsV2USggNiMOruYou6r4lK5IpDB/G/wkjUu0yKGX9rbxenDI
U5PMCCjjmCXPI6T53iHTfIUJrU6adTrCC2qJeHZERxhlbI1Bjjt/msv0tadQ1wUs
N+gDS63pYaACbvXy8MWy7Vu33PqUXHeeE6V/Uq2V8viTO96LXFvKWlJbYK8U90vv
o/ufQJVtMVT8QtPHRh8jrdkPSHCa2XV4cdFyQzR1bldZwgJcJmApzyMZFo6IQ6XU
5MsI+yMRQ+hDKXJioaldXgjUkK642M4UwtBV8ob2xJNDd2ZhwLnoQdeXeGADbkpy
rqXRfboQnoZsG4q5WTP468SQvvG5
-----END CERTIFICATE-----
)PEM";

// Carga de credenciales privadas de AWS IoT Core:
// Si existe "secrets.h" localmente se utiliza de inmediato; de lo contrario recurre
// a la plantilla "secrets.example.h" para indicar las instrucciones de configuracion.
#if __has_include("secrets.h")
  #include "secrets.h"
#else
  #include "secrets.example.h"
#endif

// Cliente MQTT con TLS (certificado del dispositivo + CA de Amazon).
espMqttClientSecure mqttClient;

volatile bool mqttConectado = false;
volatile bool mqttIntentando = false;
bool awsConfigurado = false;

unsigned long ultimoIntentoMQTT = 0;
const unsigned long intervaloReintentoMQTT = 5000;

unsigned long ultimoEnvioMQTT = 0;
const unsigned long intervaloMQTT = 10000;  // medicion cada 10 segundos

// Guarda un evento de tapa si no hay conexion en ese instante.
bool eventoTapaPendiente = true;
char ultimoEventoTapa[24] = "estado_inicial";

// =====================================================
// DHT11 - TEMPERATURA Y HUMEDAD EXTERIOR
// =====================================================

#define DHTPIN 4
#define DHTTYPE DHT11

DHT dht(DHTPIN, DHTTYPE);

// =====================================================
// DS18B20 - TEMPERATURA INTERIOR
// =====================================================

#define DS18B20_PIN 5

OneWire oneWire(DS18B20_PIN);
DallasTemperature sensors(&oneWire);

// =====================================================
// OLED
// =====================================================

#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64

Adafruit_SSD1306 display(
  SCREEN_WIDTH,
  SCREEN_HEIGHT,
  &Wire,
  -1
);

// =====================================================
// BOTON
// =====================================================

#define BOTON_PIN 18

int pantalla = 0;
  
bool alertaActiva = false;
bool estadoAnteriorBoton = HIGH;

unsigned long ultimoTiempoBoton = 0;
const unsigned long debounce = 200;

// Si el boton esta presionado al arrancar, se fuerza el portal Wi-Fi.
bool forzarConfiguracionWiFi = false;

// =====================================================
// LDR - TAPA
// LOW = LUZ = TAPA ABIERTA
// HIGH = OSCURIDAD = TAPA CERRADA
// =====================================================

#define LDR_PIN 34

bool tapaAbierta = false;

char horaApertura[10] = "--:--:--";

// =====================================================
// VARIABLES DE SENSORES
// =====================================================

float temperaturaExterior = 0;
float humedadExterior = 0;
float temperaturaInterior = 0;

// =====================================================
// TIEMPOS
// =====================================================

unsigned long ultimaLecturaSensores = 0;
const unsigned long intervaloSensores = 2000;

// =====================================================
// BATERIA 18650 - LECTURA POR GPIO35
// Divisor: B+ -- R1 100k -- GPIO35 -- R2 100k -- B-
// El porcentaje es una estimacion basada en el voltaje.
// =====================================================

#define BATTERY_PIN 35

const float BATTERY_R1_OHMS = 100000.0;  // B+ a GPIO35
const float BATTERY_R2_OHMS = 100000.0;  // GPIO35 a B-
const unsigned long intervaloBateria = 5000;

unsigned long ultimaLecturaBateria = 0;
float voltajeBateria = 0.0;
int porcentajeBateria = 0;
bool bateriaLecturaValida = false;

// =====================================================
// LOGO BEESENSE
// 80 x 64 pixeles, monocromatico
// =====================================================

const uint8_t logoBeeSense[] PROGMEM = {
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x80, 0x01,
  0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x60, 0x07, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x18, 0x0C, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x08, 0x18, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x07, 0xF0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x1C, 0x3C, 0x00, 0x03, 0xC0, 0x00, 0x00, 0x02, 0x18, 0x00, 0x34, 0x26, 0x00, 0x1F, 0xF0, 0x00,
  0x00, 0x08, 0x02, 0x00, 0x24, 0x22, 0x00, 0xF0, 0x18, 0x00, 0x00, 0x10, 0x00, 0x80, 0x44, 0x33,
  0x01, 0xC0, 0x0C, 0x00, 0x00, 0x00, 0x00, 0x20, 0x44, 0x13, 0x07, 0x08, 0x04, 0x00, 0x00, 0x20,
  0x00, 0x18, 0x48, 0x1B, 0x1C, 0x04, 0x06, 0x00, 0x00, 0x00, 0x20, 0x04, 0x70, 0x0E, 0x30, 0x02,
  0x02, 0x00, 0x00, 0x00, 0x04, 0x03, 0x20, 0x06, 0x60, 0x13, 0x02, 0x00, 0x00, 0x00, 0x48, 0x00,
  0xA0, 0x07, 0x80, 0x19, 0x02, 0x00, 0x00, 0x00, 0x01, 0x00, 0x70, 0x0F, 0x00, 0x49, 0x02, 0x00,
  0x00, 0x20, 0x00, 0x00, 0x38, 0x0E, 0x02, 0x69, 0x02, 0x00, 0x00, 0x20, 0x02, 0x60, 0x0C, 0x18,
  0x03, 0x6D, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x06, 0x30, 0x02, 0x49, 0x06, 0x00, 0x00, 0x10,
  0x00, 0x00, 0x03, 0xE0, 0x00, 0x09, 0x0C, 0x00, 0x00, 0x00, 0x40, 0x03, 0xFF, 0xFF, 0xF8, 0x01,
  0x0C, 0x00, 0x00, 0x08, 0x00, 0x70, 0x0F, 0xF8, 0xFF, 0x80, 0x18, 0x00, 0x00, 0x04, 0x03, 0x00,
  0x1E, 0x7C, 0x01, 0xE0, 0x30, 0x00, 0x00, 0x02, 0x00, 0x00, 0xE4, 0x37, 0x80, 0x38, 0x60, 0x00,
  0x00, 0x00, 0x90, 0x03, 0x8C, 0x19, 0xF8, 0x1F, 0xC0, 0x00, 0x00, 0x00, 0x30, 0x38, 0x18, 0x0C,
  0x3F, 0xFF, 0x00, 0x00, 0x00, 0x00, 0x20, 0x00, 0x31, 0x86, 0x01, 0xF6, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x67, 0xE3, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x8F, 0xF9, 0x80, 0x03,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x3C, 0x9E, 0xC0, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x06,
  0xF1, 0xCF, 0x70, 0x02, 0x00, 0x00, 0x00, 0x00, 0x20, 0x08, 0xE7, 0xE3, 0x98, 0x06, 0x00, 0x00,
  0x00, 0x00, 0x10, 0x30, 0xDF, 0xBD, 0x8F, 0x0C, 0x00, 0x00, 0x00, 0x00, 0x01, 0x80, 0xDD, 0xDD,
  0x83, 0xF8, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xDF, 0xFD, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0xDA, 0x6D, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xDF, 0x6D, 0x80, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xDF, 0xFD, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0xFD, 0x9D, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xDF, 0xF9, 0x80, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0xE7, 0xE3, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x79, 0x8F,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1C, 0xBC, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x0F, 0xD0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x40, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x01, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0E, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1F, 0xC0, 0x00, 0x00,
  0x3F, 0x80, 0x00, 0x00, 0x00, 0x00, 0x10, 0x60, 0x00, 0x00, 0x73, 0x80, 0x00, 0x00, 0x00, 0x00,
  0x10, 0x20, 0xE0, 0x30, 0x60, 0x0F, 0x8D, 0xE1, 0xF0, 0xF0, 0x10, 0x21, 0xB0, 0xEC, 0x70, 0x1F,
  0xCF, 0xF3, 0xF3, 0xF8, 0x1F, 0xE2, 0x08, 0x86, 0x7E, 0x38, 0xCE, 0x33, 0x03, 0x1C, 0x18, 0xE2,
  0x09, 0x82, 0x1F, 0xBF, 0xEC, 0x33, 0xC7, 0x7C, 0x10, 0x33, 0xF9, 0xFE, 0x03, 0xBF, 0xEC, 0x33,
  0xF7, 0xFC, 0x10, 0x32, 0x01, 0x80, 0x01, 0xB8, 0x0C, 0x30, 0x3B, 0x00, 0x10, 0x33, 0x00, 0x80,
  0x63, 0x9C, 0xCC, 0x32, 0x3B, 0x98, 0x1F, 0xE1, 0xF8, 0x7C, 0x7F, 0x9F, 0xCC, 0x33, 0xF1, 0xF8
};

// =====================================================
// ICONO TERMOMETRO
// =====================================================

void dibujarTermometro(int x, int y) {

  display.drawRoundRect(
    x + 7, y, 8, 25, 4,
    SSD1306_WHITE
  );

  display.fillCircle(
    x + 11, y + 25, 6,
    SSD1306_WHITE
  );

  display.drawLine(
    x + 11, y + 7,
    x + 11, y + 22,
    SSD1306_WHITE
  );
}

// =====================================================
// ICONO GOTA
// =====================================================

void dibujarGota(int x, int y) {

  display.drawTriangle(
    x + 10, y,
    x, y + 15,
    x + 20, y + 15,
    SSD1306_WHITE
  );

  display.drawCircle(
    x + 10, y + 15, 10,
    SSD1306_WHITE
  );
}

// =====================================================
// PANTALLA DE INICIO - LOGO
// =====================================================

void mostrarLogoInicio() {

  display.clearDisplay();

  display.drawBitmap(
    24, 0,
    logoBeeSense,
    80, 64,
    SSD1306_WHITE
  );

  display.display();
}

// =====================================================
// PANTALLA DE CONFIGURACION WIFI
// =====================================================

void mostrarConfiguracionWiFi() {

  display.clearDisplay();

  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);

  display.setCursor(18, 0);
  display.println("CONFIGURAR WIFI");

  display.drawLine(
    0, 11, 127, 11,
    SSD1306_WHITE
  );

  display.setCursor(4, 21);
  display.println("Red de configuracion:");

  display.setCursor(4, 34);
  display.println("BeeSense-Config");

  display.setCursor(4, 47);
  display.println("IP: 192.168.4.1");

  display.display();
}

// =====================================================
// PANTALLA: CONECTANDO A UNA RED GUARDADA
// =====================================================

void mostrarConectandoWiFi() {

  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(18, 0);
  display.println("CONECTANDO WIFI");
  display.drawLine(0, 11, 127, 11, SSD1306_WHITE);
  display.setCursor(4, 25);
  display.println("Buscando red guardada");
  display.setCursor(4, 40);
  display.println("Espere, por favor...");
  display.display();
}

// =====================================================
// CONEXION WIFI MEDIANTE WIFIMANAGER
// =====================================================

bool conectarWiFi() {

  WiFiManager wm;

  // Tiempo que intenta conectarse a la red guardada.
  wm.setConnectTimeout(20);

  // El portal permanece abierto hasta configurar.
  wm.setConfigPortalTimeout(0);

  Serial.println();
  Serial.println("=================================");
  Serial.println(" CONFIGURACION WIFI");
  Serial.println("=================================");

  Serial.println(
    "Intentando conectar con WiFi guardado..."
  );

  // La pantalla de configuracion solo se muestra cuando el portal
  // realmente esta activo. Antes de eso, indicamos que busca la red.
  wm.setAPCallback([](WiFiManager *miManager) {
    Serial.println("Portal activo: conecte el movil a BeeSense-Config.");
    Serial.println("Luego abra http://192.168.4.1");
    mostrarConfiguracionWiFi();
  });

  if (forzarConfiguracionWiFi) {
    Serial.println("Boton presionado al inicio: borrando Wi-Fi guardado.");
    wm.resetSettings();
    mostrarConfiguracionWiFi();
  } else {
    mostrarConectandoWiFi();
  }

  // WiFiManager:
  // 1) intenta la red guardada
  // 2) si no conecta, crea BeeSense-Config
  // 3) al configurar, guarda las credenciales
  bool conectado = wm.autoConnect(
    "BeeSense-Config",
    "BeeSense123"
  );

  if (!conectado) {

    Serial.println(
      "No fue posible configurar WiFi."
    );

    return false;
  }

  Serial.println("WiFi conectado.");

  Serial.print("SSID: ");
  Serial.println(WiFi.SSID());

  Serial.print("IP: ");
  Serial.println(WiFi.localIP());
  WiFi.setAutoReconnect(true);

  return true;
}

// =====================================================
// LEER VOLTAJE Y ESTIMAR PORCENTAJE DE BATERIA
// =====================================================

float leerVoltajeBateria() {
  // Promediar varias lecturas ayuda a reducir pequeñas variaciones.
  uint32_t sumaMilivoltios = 0;
  const int numeroMuestras = 16;

  for (int i = 0; i < numeroMuestras; i++) {
    sumaMilivoltios += analogReadMilliVolts(BATTERY_PIN);
    delay(2);
  }

  float voltajePin = (sumaMilivoltios / (float)numeroMuestras) / 1000.0;
  float factorDivisor = (BATTERY_R1_OHMS + BATTERY_R2_OHMS) / BATTERY_R2_OHMS;

  return voltajePin * factorDivisor;
}

int estimarPorcentajeBateria(float voltaje) {
  // Curva aproximada para una celda Li-ion 18650 en reposo.
  // Puede variar segun la celda, temperatura y consumo del equipo.
  const float voltajes[] = {
    3.20, 3.30, 3.45, 3.55, 3.60, 3.65, 3.70,
    3.75, 3.80, 3.85, 3.90, 4.00, 4.10, 4.20
  };
  const int porcentajes[] = {
    0, 5, 10, 15, 20, 30, 40,
    50, 60, 70, 80, 90, 95, 100
  };
  const int cantidad = sizeof(voltajes) / sizeof(voltajes[0]);

  if (voltaje <= voltajes[0]) return 0;
  if (voltaje >= voltajes[cantidad - 1]) return 100;

  for (int i = 0; i < cantidad - 1; i++) {
    if (voltaje >= voltajes[i] && voltaje <= voltajes[i + 1]) {
      float proporcion = (voltaje - voltajes[i]) / (voltajes[i + 1] - voltajes[i]);
      float resultado = porcentajes[i] + proporcion * (porcentajes[i + 1] - porcentajes[i]);
      return constrain((int)(resultado + 0.5), 0, 100);
    }
  }

  return 0;
}

void actualizarBateria(bool informarSerial = true) {
  voltajeBateria = leerVoltajeBateria();

  // Rangos amplios para detectar desconexion/cableado anomalo.
  bateriaLecturaValida = (voltajeBateria >= 2.5 && voltajeBateria <= 4.5);

  if (bateriaLecturaValida) {
    porcentajeBateria = estimarPorcentajeBateria(voltajeBateria);
  }

  if (informarSerial) {
    Serial.print("Bateria: ");
    Serial.print(voltajeBateria, 2);
    Serial.print(" V | ");

    if (bateriaLecturaValida) {
      Serial.print(porcentajeBateria);
      Serial.println("% estimado");
    } else {
      Serial.println("lectura fuera de rango; revisar divisor y GND");
    }
  }
}


// =====================================================
// MQTT / AWS IOT CORE
// =====================================================

bool credencialesAWSCompletas() {
  // Evita intentar TLS mientras quedan los textos de ejemplo.
  if (strstr(AWS_IOT_ENDPOINT, "PEGA_AQUI") != nullptr) return false;
  if (strstr(AWS_ROOT_CA, "PEGA_AQUI") != nullptr) return false;
  if (strstr(AWS_DEVICE_CERT, "PEGA_AQUI") != nullptr) return false;
  if (strstr(AWS_PRIVATE_KEY, "PEGA_AQUI") != nullptr) return false;
  return true;
}

void alConectarMQTT(bool sessionPresent) {
  mqttConectado = true;
  mqttIntentando = false;
  Serial.println();
  Serial.println("=================================");
  Serial.println("MQTT CONECTADO A AWS IOT CORE");
  Serial.print("Thing / Client ID: ");
  Serial.println(THING_NAME);
  Serial.print("Topic de publicacion: ");
  Serial.println(MQTT_TOPIC);
  Serial.println("=================================");
}

void alDesconectarMQTT(espMqttClientTypes::DisconnectReason reason) {
  mqttConectado = false;
  mqttIntentando = false;
  Serial.println("MQTT desconectado. Se intentara reconectar automaticamente.");
}

void configurarMQTT() {
  awsConfigurado = credencialesAWSCompletas();

  if (!awsConfigurado) {
    Serial.println();
    Serial.println("AWS MQTT aun no esta configurado.");
    Serial.println("Completa endpoint, Amazon Root CA 1, certificado y clave privada.");
    return;
  }

  mqttClient.setServer(AWS_IOT_ENDPOINT, 8883);
  mqttClient.setClientId(THING_NAME);
  mqttClient.setKeepAlive(30);
  mqttClient.setTimeout(10);

  mqttClient.setCACert(AWS_ROOT_CA);
  mqttClient.setCertificate(AWS_DEVICE_CERT);
  mqttClient.setPrivateKey(AWS_PRIVATE_KEY);

  mqttClient.onConnect(alConectarMQTT);
  mqttClient.onDisconnect(alDesconectarMQTT);

  Serial.println("Configuracion TLS/MQTT preparada.");
  Serial.println("Iniciando conexion con AWS IoT Core...");
}

bool publicarDatosMQTT(const char* evento) {
  if (!mqttClient.connected()) {
    Serial.println("MQTT no conectado; el mensaje no se publico aun.");
    return false;
  }

  // Unix timestamp basado en el reloj sincronizado por NTP.
  time_t ahora = time(nullptr);
  unsigned long timestampUnix = (ahora > 1000000000) ? (unsigned long)ahora : 0;

  char payload[420];
  snprintf(
    payload,
    sizeof(payload),
    "{"
      "\"device_id\":\"%s\","
      "\"temperatura_exterior_c\":%.1f,"
      "\"humedad_exterior_pct\":%.1f,"
      "\"temperatura_interior_c\":%.1f,"
      "\"tapa_abierta\":%s,"
      "\"bateria_lectura_valida\":%s,"
      "\"bateria_voltaje_v\":%.2f,"
      "\"bateria_porcentaje_estimado\":%d,"
      "\"evento\":\"%s\","
      "\"timestamp_unix\":%lu"
    "}",
    THING_NAME,
    temperaturaExterior,
    humedadExterior,
    temperaturaInterior,
    tapaAbierta ? "true" : "false",
    bateriaLecturaValida ? "true" : "false",
    bateriaLecturaValida ? voltajeBateria : 0.0,
    bateriaLecturaValida ? porcentajeBateria : 0,
    evento,
    timestampUnix
  );

  Serial.println("Publicando mensaje MQTT:");
  Serial.println(payload);

  // QoS 0: mensaje de telemetria sin confirmacion de entrega por mensaje.
  uint16_t packetId = mqttClient.publish(
    MQTT_TOPIC,
    0,
    false,
    payload
  );

  if (packetId != 0) {
    Serial.println("Mensaje aceptado por el cliente MQTT para envio.");
    return true;
  }

  Serial.println("No se pudo encolar el mensaje MQTT.");
  return false;
}

void gestionarMQTT() {
  if (!awsConfigurado) return;

  // La biblioteca intenta mantener la conexion Wi-Fi guardada.
  if (WiFi.status() != WL_CONNECTED) {
    mqttConectado = false;
    mqttIntentando = false;
    return;
  }

  if (!mqttClient.connected() && !mqttIntentando &&
      millis() - ultimoIntentoMQTT >= intervaloReintentoMQTT) {
    ultimoIntentoMQTT = millis();
    mqttIntentando = true;

    Serial.println("Intentando conectar con AWS IoT Core por MQTT/TLS...");

    if (!mqttClient.connect()) {
      mqttIntentando = false;
      Serial.println("No se pudo iniciar la conexion MQTT; se reintentara.");
    }
    return;
  }

  if (mqttClient.connected()) {
    // Al reconectar, se intenta enviar primero el estado de tapa pendiente.
    if (eventoTapaPendiente) {
      if (publicarDatosMQTT(ultimoEventoTapa)) {
        eventoTapaPendiente = false;
        ultimoEnvioMQTT = millis();
      }
    }

    // Telemetria periodica. Los cambios de tapa se intentan enviar inmediatamente.
    if (millis() - ultimoEnvioMQTT >= intervaloMQTT) {
      if (publicarDatosMQTT("medicion")) {
        ultimoEnvioMQTT = millis();
      } else {
        ultimoEnvioMQTT = millis() - intervaloMQTT + 1000;
      }
    }
  }
}

// =====================================================
// PANTALLA 1 - HORA Y FECHA + BATERIA
// =====================================================

void mostrarHoraFecha() {

  display.clearDisplay();

  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);

  // Encabezado compacto para dejar espacio al indicador de bateria.
  display.setCursor(0, 0);
  display.print("HORA/FECHA");

  // Icono de bateria en la esquina superior derecha.
  const int bateriaX = 75;
  const int bateriaY = 1;
  display.drawRect(bateriaX, bateriaY, 17, 9, SSD1306_WHITE);
  display.fillRect(bateriaX + 17, bateriaY + 2, 2, 5, SSD1306_WHITE);

  // Relleno del icono de acuerdo con el porcentaje estimado.
  if (bateriaLecturaValida) {
    int anchoRelleno = (porcentajeBateria * 11 + 50) / 100;
    if (anchoRelleno > 0) {
      display.fillRect(bateriaX + 3, bateriaY + 3, anchoRelleno, 5, SSD1306_WHITE);
    }
  }

  display.setCursor(98, 1);
  if (bateriaLecturaValida) {
    display.print(porcentajeBateria);
    display.print("%");
  } else {
    display.print("--%");
  }

  display.drawLine(
    0, 11, 127, 11,
    SSD1306_WHITE
  );

  struct tm timeinfo;

  if (getLocalTime(&timeinfo)) {

    char hora[10];

    strftime(
      hora,
      sizeof(hora),
      "%H:%M:%S",
      &timeinfo
    );

    display.setTextSize(2);

    display.setCursor(25, 23);
    display.println(hora);

    char fecha[12];

    strftime(
      fecha,
      sizeof(fecha),
      "%d/%m/%Y",
      &timeinfo
    );

    display.setTextSize(1);

    display.setCursor(36, 47);
    display.println(fecha);
  }

  display.setCursor(48, 56);
  display.println("[1/4]");

  display.display();
}

// =====================================================
// PANTALLA 2 - TEMPERATURA EXTERIOR
// DHT11
// =====================================================

void mostrarTemperaturaExterior() {

  display.clearDisplay();

  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);

  display.setCursor(17, 0);
  display.println("TEMP. EXTERIOR");

  display.drawLine(
    0, 11, 127, 11,
    SSD1306_WHITE
  );

  dibujarTermometro(18, 22);

  display.setTextSize(2);

  display.setCursor(43, 27);

  display.print(
    temperaturaExterior,
    1
  );

  display.setTextSize(1);
  display.print(" C");

  display.setCursor(48, 56);
  display.println("[2/4]");

  display.display();
}

// =====================================================
// PANTALLA 3 - HUMEDAD EXTERIOR
// DHT11
// =====================================================

void mostrarHumedadExterior() {

  display.clearDisplay();

  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);

  display.setCursor(18, 0);
  display.println("HUMEDAD EXTERIOR");

  display.drawLine(
    0, 11, 127, 11,
    SSD1306_WHITE
  );

  dibujarGota(18, 23);

  display.setTextSize(2);

  display.setCursor(50, 27);

  display.print(
    humedadExterior,
    1
  );

  display.setTextSize(1);
  display.print(" %");

  display.setCursor(48, 56);
  display.println("[3/4]");

  display.display();
}

// =====================================================
// PANTALLA 4 - TEMPERATURA INTERIOR
// DS18B20
// =====================================================

void mostrarTemperaturaInterior() {

  display.clearDisplay();

  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);

  display.setCursor(17, 0);
  display.println("TEMP. INTERIOR");

  display.drawLine(
    0, 11, 127, 11,
    SSD1306_WHITE
  );

  dibujarTermometro(18, 22);

  display.setTextSize(2);

  display.setCursor(43, 27);

  display.print(
    temperaturaInterior,
    1
  );

  display.setTextSize(1);
  display.print(" C");

  display.setCursor(48, 56);
  display.println("[4/4]");

  display.display();
}

// =====================================================
// PANTALLA TAPA ABIERTA
// =====================================================

void mostrarTapaAbierta() {

  display.clearDisplay();

  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);

  display.setCursor(27, 0);
  display.println("! TAPA ABIERTA");

  display.drawLine(
    0, 11, 127, 11,
    SSD1306_WHITE
  );

  display.setCursor(31, 24);
  display.println("SENSOR EXPUESTO");

  display.setTextSize(2);

  display.setCursor(39, 42);
  display.println(horaApertura);

  display.display();
}

// =====================================================
// GUARDAR HORA DE APERTURA
// =====================================================

void guardarHoraApertura() {

  struct tm timeinfo;

  if (getLocalTime(&timeinfo)) {

    strftime(
      horaApertura,
      sizeof(horaApertura),
      "%H:%M:%S",
      &timeinfo
    );
  }
}

// =====================================================
// ACTUALIZAR PANTALLA
// =====================================================

void actualizarPantalla() {

  if (alertaActiva) {

    mostrarTapaAbierta();

    return;
  }

  if (pantalla == 0) {

    mostrarHoraFecha();

  } else if (pantalla == 1) {

    mostrarTemperaturaExterior();

  } else if (pantalla == 2) {

    mostrarHumedadExterior();

  } else if (pantalla == 3) {

    mostrarTemperaturaInterior();
  }
}

// =====================================================
// SETUP
// =====================================================

void setup() {

  Serial.begin(115200);

  // Mantenga pulsado el boton GPIO18 al reiniciar para forzar
  // el portal Wi-Fi y borrar la red almacenada.
  pinMode(BOTON_PIN, INPUT_PULLUP);
  delay(30);
  forzarConfiguracionWiFi = (digitalRead(BOTON_PIN) == LOW);

  Serial.println();
  if (forzarConfiguracionWiFi) {
    Serial.println("Modo de configuracion Wi-Fi forzado por boton.");
  }

  Serial.println(
    "================================="
  );

  Serial.println(
    "             BEESENSE"
  );

  Serial.println(
    "   MONITOREO APICOLA IOT"
  );

  Serial.println(
    "           CODIGO 13"
  );

  Serial.println(
    "================================="
  );

  // ---------------------------------------------------
  // SENSORES
  // ---------------------------------------------------

  dht.begin();

  sensors.begin();

  Serial.print(
    "DS18B20 encontrados: "
  );

  Serial.println(
    sensors.getDeviceCount()
  );

  // ---------------------------------------------------
  // BOTON
  // ---------------------------------------------------

  pinMode(
    BOTON_PIN,
    INPUT_PULLUP
  );

  // ---------------------------------------------------
  // LDR
  // ---------------------------------------------------

  pinMode(
    LDR_PIN,
    INPUT
  );

  // ---------------------------------------------------
  // ADC PARA MEDIR BATERIA EN GPIO35
  // ---------------------------------------------------

  analogReadResolution(12);
  analogSetPinAttenuation(BATTERY_PIN, ADC_11db);

  // ---------------------------------------------------
  // OLED
  // ---------------------------------------------------

  Wire.begin(21, 22);

  if (!display.begin(
        SSD1306_SWITCHCAPVCC,
        0x3C
      )) {

    Serial.println(
      "ERROR OLED"
    );

    while (true) {
      delay(1000);
    }
  }

  // ---------------------------------------------------
  // LOGO DE INICIO
  // ---------------------------------------------------

  mostrarLogoInicio();

  delay(3000);

  // ---------------------------------------------------
  // WIFI
  // ---------------------------------------------------

  bool wifiConectado =
    conectarWiFi();

  // ---------------------------------------------------
  // NTP
  // ---------------------------------------------------

  if (wifiConectado) {

    configTzTime(
      timezone,
      ntpServer1,
      ntpServer2
    );

    Serial.print(
      "Sincronizando hora"
    );

    struct tm timeinfo;

    unsigned long inicioNTP =
      millis();

    while (
      !getLocalTime(&timeinfo) &&
      millis() - inicioNTP < 10000
    ) {

      delay(500);

      Serial.print(".");
    }

    Serial.println();

    if (getLocalTime(&timeinfo)) {

      Serial.println(
        "Hora sincronizada."
      );

    } else {

      Serial.println(
        "No se pudo sincronizar la hora."
      );
    }
  }

  // ---------------------------------------------------
  // DHT11 - LECTURA INICIAL EXTERIOR
  // ---------------------------------------------------

  temperaturaExterior =
    dht.readTemperature();

  humedadExterior =
    dht.readHumidity();

  if (
    isnan(temperaturaExterior)
  ) {

    temperaturaExterior = 0;
  }

  if (
    isnan(humedadExterior)
  ) {

    humedadExterior = 0;
  }

  // ---------------------------------------------------
  // DS18B20 - LECTURA INICIAL INTERIOR
  // ---------------------------------------------------

  sensors.requestTemperatures();

  temperaturaInterior =
    sensors.getTempCByIndex(0);

  if (
    temperaturaInterior ==
    DEVICE_DISCONNECTED_C
  ) {

    temperaturaInterior = 0;
  }

  // ---------------------------------------------------
  // LECTURA INICIAL DE BATERIA
  // ---------------------------------------------------

  actualizarBateria();
  ultimaLecturaBateria = millis();

  // ---------------------------------------------------
  // ESTADO INICIAL DE TAPA
  // ---------------------------------------------------

  int estadoLDR =
    digitalRead(LDR_PIN);

  Serial.print("Lectura inicial LDR GPIO34 = ");
  Serial.print(estadoLDR);
  Serial.print(" -> ");
  Serial.println(estadoLDR == LOW ? "LUZ / TAPA ABIERTA" : "OSCURIDAD / TAPA CERRADA");

  if (estadoLDR == LOW) {

    tapaAbierta = true;

    alertaActiva = true;

    guardarHoraApertura();

    mostrarTapaAbierta();

  } else {

    tapaAbierta = false;

    alertaActiva = false;

    pantalla = 0;

    actualizarPantalla();
  }

  // Registrar estado inicial para enviarlo al conectarse MQTT.
  strncpy(ultimoEventoTapa, tapaAbierta ? "tapa_abierta" : "tapa_cerrada", sizeof(ultimoEventoTapa) - 1);
  ultimoEventoTapa[sizeof(ultimoEventoTapa) - 1] = '\0';
  eventoTapaPendiente = true;

  // Configurar TLS/MQTT. La conexion se inicia en loop sin bloquear el OLED.
  configurarMQTT();

  Serial.println();
  Serial.println(
    "Sistema iniciado."
  );
}

// =====================================================
// LOOP
// =====================================================

void loop() {

  // ---------------------------------------------------
  // AWS IOT CORE - MQTT/TLS
  // ---------------------------------------------------

  gestionarMQTT();

  // ---------------------------------------------------
  // LDR - TAPA
  // ---------------------------------------------------

  int estadoLDR =
    digitalRead(LDR_PIN);

  // Diagnostico: informar por Serial cada vez que cambia la salida DO del LDR.
  static int ultimoEstadoLDRInformado = -1;
  if (estadoLDR != ultimoEstadoLDRInformado) {
    Serial.print("LDR GPIO34 cambio a ");
    Serial.print(estadoLDR);
    Serial.print(" -> ");
    Serial.println(estadoLDR == LOW ? "LUZ / TAPA ABIERTA" : "OSCURIDAD / TAPA CERRADA");
    ultimoEstadoLDRInformado = estadoLDR;
  }

  bool nuevoEstadoTapa;

  if (estadoLDR == LOW) {

    nuevoEstadoTapa = true;

  } else {

    nuevoEstadoTapa = false;
  }

  // ---------------------------------------------------
  // CAMBIO DE TAPA
  // ---------------------------------------------------

  if (
    nuevoEstadoTapa != tapaAbierta
  ) {

    tapaAbierta =
      nuevoEstadoTapa;

    if (tapaAbierta) {

      alertaActiva = true;

      guardarHoraApertura();

      Serial.print(
        "TAPA ABIERTA - "
      );

      Serial.println(
        horaApertura
      );

      strncpy(ultimoEventoTapa, "tapa_abierta", sizeof(ultimoEventoTapa) - 1);
      ultimoEventoTapa[sizeof(ultimoEventoTapa) - 1] = '\0';
      eventoTapaPendiente = true;

      if (mqttConectado && publicarDatosMQTT(ultimoEventoTapa)) {
        eventoTapaPendiente = false;
        ultimoEnvioMQTT = millis();
      }

      mostrarTapaAbierta();

    } else {

      alertaActiva = false;

      pantalla = 0;

      Serial.println(
        "TAPA CERRADA"
      );

      strncpy(ultimoEventoTapa, "tapa_cerrada", sizeof(ultimoEventoTapa) - 1);
      ultimoEventoTapa[sizeof(ultimoEventoTapa) - 1] = '\0';
      eventoTapaPendiente = true;

      if (mqttConectado && publicarDatosMQTT(ultimoEventoTapa)) {
        eventoTapaPendiente = false;
        ultimoEnvioMQTT = millis();
      }

      actualizarPantalla();
    }
  }

  // ---------------------------------------------------
  // BOTON
  // ---------------------------------------------------

  bool estadoBoton =
    digitalRead(BOTON_PIN);

  if (
    estadoAnteriorBoton == HIGH &&
    estadoBoton == LOW &&
    millis() - ultimoTiempoBoton >
    debounce
  ) {

    ultimoTiempoBoton =
      millis();

    if (alertaActiva) {

      alertaActiva = false;

      pantalla = 0;

      actualizarPantalla();

    } else {

      pantalla++;

      if (pantalla > 3) {

        pantalla = 0;
      }

      actualizarPantalla();
    }
  }

  estadoAnteriorBoton =
    estadoBoton;

  // ---------------------------------------------------
  // LECTURA DE SENSORES
  // ---------------------------------------------------

  if (
    millis() - ultimaLecturaSensores >=
    intervaloSensores
  ) {

    ultimaLecturaSensores =
      millis();

    // -------------------------------------------------
    // DHT11 - EXTERIOR
    // -------------------------------------------------

    float nuevaTemperaturaExterior =
      dht.readTemperature();

    float nuevaHumedadExterior =
      dht.readHumidity();

    if (
      !isnan(
        nuevaTemperaturaExterior
      )
    ) {

      temperaturaExterior =
        nuevaTemperaturaExterior;
    }

    if (
      !isnan(
        nuevaHumedadExterior
      )
    ) {

      humedadExterior =
        nuevaHumedadExterior;
    }

    // -------------------------------------------------
    // DS18B20 - INTERIOR
    // -------------------------------------------------

    sensors.requestTemperatures();

    float nuevaTemperaturaInterior =
      sensors.getTempCByIndex(0);

    if (
      nuevaTemperaturaInterior !=
      DEVICE_DISCONNECTED_C
    ) {

      temperaturaInterior =
        nuevaTemperaturaInterior;
    }

    // -------------------------------------------------
    // SERIAL
    // -------------------------------------------------

    Serial.print(
      "Exterior: "
    );

    Serial.print(
      temperaturaExterior,
      1
    );

    Serial.print(
      " C | Humedad exterior: "
    );

    Serial.print(
      humedadExterior,
      1
    );

    Serial.print(
      " % | Interior: "
    );

    Serial.print(
      temperaturaInterior,
      1
    );

    Serial.println(
      " C"
    );

    // -------------------------------------------------
    // OLED
    // -------------------------------------------------

    if (!alertaActiva) {

      if (
        pantalla == 1 ||
        pantalla == 2 ||
        pantalla == 3
      ) {

        actualizarPantalla();
      }
    }
  }

  // ---------------------------------------------------
  // ACTUALIZAR LECTURA DE BATERIA CADA 5 SEGUNDOS
  // ---------------------------------------------------

  if (millis() - ultimaLecturaBateria >= intervaloBateria) {
    ultimaLecturaBateria = millis();
    actualizarBateria();
  }

  // ---------------------------------------------------
  // ACTUALIZAR HORA
  // ---------------------------------------------------

  static unsigned long
    ultimaActualizacionHora = 0;

  if (
    !alertaActiva &&
    pantalla == 0 &&
    millis() -
    ultimaActualizacionHora >=
    1000
  ) {

    ultimaActualizacionHora =
      millis();

    mostrarHoraFecha();
  }

  delay(10);
}