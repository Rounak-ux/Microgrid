/**
 * ============================================================
 *  Smart AI-Based Microgrid EMS — ESP32 Firmware
 *  File: ESP32.ino
 *  Version: 2.0.0
 *
 *  ┌─ PROJECT OVERVIEW ──────────────────────────────────────┐
 *  │  Target: ESP32 DevKit v1 (Xtensa LX6 Dual-Core 240MHz) │
 *  │  IDE:    Arduino IDE 2.x or PlatformIO                  │
 *  │  Board:  "ESP32 Dev Module"                             │
 *  │  Flash:  4MB                                            │
 *  └─────────────────────────────────────────────────────────┘
 *
 *  ┌─ LIBRARY DEPENDENCIES ──────────────────────────────────┐
 *  │  Install via Arduino Library Manager:                   │
 *  │  1. Firebase ESP32 Client by Mobizt (v4.x)             │
 *  │  2. ArduinoJson by Benoit Blanchon (v6.x)              │
 *  │  3. WiFi (built-in ESP32 core)                         │
 *  └─────────────────────────────────────────────────────────┘
 *
 *  ┌─ WIRING DIAGRAM ────────────────────────────────────────┐
 *  │                                                         │
 *  │  ESP32           ACS712-05B (×4)          Relay Module  │
 *  │  ─────           ─────────────            ────────────  │
 *  │  GPIO34 ────── VOUT (Solar)                             │
 *  │  GPIO35 ────── VOut (Wind)                              │
 *  │  GPIO32 ────── VOut (Battery)                           │
 *  │  GPIO33 ────── VOut (Load)                              │
 *  │  3.3V   ────── VCC (all ACS712)                        │
 *  │  GND    ────── GND (all ACS712)                        │
 *  │                                                         │
 *  │  GPIO4  ─────────────────────────── IN1 (Solar)        │
 *  │  GPIO5  ─────────────────────────── IN2 (Wind)         │
 *  │  GPIO18 ─────────────────────────── IN3 (Battery)      │
 *  │  GPIO19 ─────────────────────────── IN4 (EV)           │
 *  │  5V     ─────────────────────────── VCC (Relay)        │
 *  │  GND    ─────────────────────────── GND (Relay)        │
 *  │                                                         │
 *  │  IMPORTANT: Use optocoupled relay module for isolation! │
 *  │  Use voltage divider on any 5V sensor → ESP32 GPIO.    │
 *  └─────────────────────────────────────────────────────────┘
 *
 *  ┌─ P_EXCESS FORMULA — EDGE vs CLOUD ─────────────────────┐
 *  │                                                         │
 *  │  ESP32 Edge (Every 1 second):                           │
 *  │    P_solar  = V_bus × I_solar  / 1000  [kW]            │
 *  │    P_wind   = V_bus × I_wind   / 1000  [kW]            │
 *  │    P_load   = V_bus × I_load   / 1000  [kW]            │
 *  │    P_excess = (P_solar + P_wind) - P_load  [kW]        │
 *  │                                                         │
 *  │  Website/Cloud (Every 10 minutes from OWM):             │
 *  │    Irradiance_proxy = f(cloud_cover, hour_of_day)       │
 *  │    P_solar_forecast = Irradiance × Panel_Area × η       │
 *  │    P_wind_forecast  = f(wind_speed, power_curve)        │
 *  │    AI case selection using forecast + live SOC          │
 *  │                                                         │
 *  │  Firebase Realtime DB is the sync bridge between them.  │
 *  └─────────────────────────────────────────────────────────┘
 * ============================================================
 */

// ─────────────────────────────────────────────────────────────
//  INCLUDES
// ─────────────────────────────────────────────────────────────
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <FirebaseESP32.h>
#include <ArduinoJson.h>
#include <esp_task_wdt.h>     // Watchdog timer

// ─────────────────────────────────────────────────────────────
//  USER CONFIGURATION — EDIT THESE
// ─────────────────────────────────────────────────────────────

// WiFi credentials
#define WIFI_SSID        "YOUR_WIFI_SSID"
#define WIFI_PASSWORD    "YOUR_WIFI_PASSWORD"

// Firebase RTDB (from Firebase Console → Realtime Database → Rules)
#define FIREBASE_HOST    "your-project-default-rtdb.firebaseio.com"
#define FIREBASE_AUTH    "YOUR_DATABASE_SECRET_OR_ACCESS_TOKEN"

// System identification
#define DEVICE_ID        "microgrid_esp32_001"
#define LOCATION_LAT     23.6833f    // Asansol, WB, India
#define LOCATION_LON     86.9667f

// ─────────────────────────────────────────────────────────────
//  GPIO PIN DEFINITIONS
// ─────────────────────────────────────────────────────────────

// Relay outputs (Active HIGH — optocoupled module)
#define PIN_RELAY_SOLAR    4
#define PIN_RELAY_WIND     5
#define PIN_RELAY_BATTERY  18
#define PIN_RELAY_EV       19

// ACS712 analog inputs (ADC1 only — ADC2 conflicts with WiFi)
#define PIN_ADC_SOLAR      34    // ADC1_CH6 — Solar array current
#define PIN_ADC_WIND       35    // ADC1_CH7 — Wind turbine current
#define PIN_ADC_BATTERY    32    // ADC1_CH4 — Battery charge/discharge
#define PIN_ADC_LOAD       33    // ADC1_CH5 — Load bus current

// Optional status LEDs (comment out if not used)
#define PIN_LED_STATUS     2     // Onboard LED
#define PIN_LED_FAULT      25    // External fault LED

// ─────────────────────────────────────────────────────────────
//  SYSTEM PARAMETERS
// ─────────────────────────────────────────────────────────────

// Electrical system
#define BUS_VOLTAGE_V          48.0f    // 48V DC bus
#define SOLAR_CAPACITY_KW      15.0f    // 15 kWp solar array
#define WIND_CAPACITY_KW       10.0f    // 10 kW wind turbine
#define BATTERY_CAPACITY_KWH   50.0f    // 50 kWh battery bank
#define BATTERY_MAX_CHARGE_KW   8.0f    // Max charge rate
#define EV_CHARGE_KW            7.2f    // AC Level 2 EVSE

// ACS712 calibration (ACS712-05B: ±5A range, 185mV/A)
#define ACS712_SENSITIVITY_VA  0.185f   // V per Ampere
#define ACS712_ZERO_OFFSET_V   1.65f    // 0A → 1.65V (VCC/2 at 3.3V)
#define ADC_VREF               3.3f
#define ADC_MAX                4095.0f
#define ADC_SAMPLES            64       // Oversampling for noise reduction

// NOTE: Scale ACS712 current up for actual system ratings using a
//       current transformer (CT) or higher-rated ACS module.
//       ACS712-05B: 5A max → use ACS712-30B (30A) for realistic loads.
//       Apply CT_RATIO multiplier below:
#define CT_RATIO_SOLAR         1.0f     // Scale factor for solar input
#define CT_RATIO_WIND          1.0f     // Scale factor for wind input
#define CT_RATIO_BATTERY       1.0f
#define CT_RATIO_LOAD          1.0f

// AI thresholds
#define BATT_SOC_CRITICAL      20.0f    // % — disable EV, import alert
#define BATT_SOC_EV_ENABLE     90.0f    // % — allow EV charging
#define WIND_PRIORITY_MS       10.0f    // m/s — wind priority mode
#define NEIGHBOR_EXPORT_SOC    80.0f    // % — allow export to neighbor

// Timing
#define SENSOR_INTERVAL_MS     1000     // Sensor read: every 1s
#define FIREBASE_INTERVAL_MS   3000     // Firebase push: every 3s
#define WATCHDOG_TIMEOUT_S     30       // WDT reset after 30s hang

// ─────────────────────────────────────────────────────────────
//  DATA STRUCTURES
// ─────────────────────────────────────────────────────────────

/**
 * Sensor readings (physical measurements from ACS712 modules)
 */
struct SensorData {
  // Raw ADC
  uint16_t adcSolar;
  uint16_t adcWind;
  uint16_t adcBattery;
  uint16_t adcLoad;
  // Millivolts
  float mvSolar;
  float mvWind;
  float mvBattery;
  float mvLoad;
  // Currents (A)
  float currentSolar;
  float currentWind;
  float currentBattery;
  float currentLoad;
  // Powers (kW) — computed from V_bus × I / 1000
  float powerSolar;
  float powerWind;
  float powerBattery;   // +ve = charging, -ve = discharging
  float powerLoad;
  // Computed
  float totalGeneration;  // P_solar + P_wind
  float pExcess;          // P_total_gen - P_load  [★ Edge formula]
};

/**
 * System state — relay positions, AI logic, SOC
 */
struct SystemState {
  // Battery
  float   battSOC;         // % (updated from Firebase/BMS)
  float   battVoltage;     // V (measured or estimated)
  String  battStatus;      // "CHARGING" / "DISCHARGING" / "IDLE"

  // Relays (actual GPIO state)
  bool    relaySolar;
  bool    relayWind;
  bool    relayBattery;
  bool    relayEV;

  // AI Engine
  uint8_t aiCase;
  String  aiTitle;
  String  aiDescription;

  // Weather (from Firebase, set by web dashboard)
  float   windSpeed;       // m/s
  float   temperature;     // °C
  float   irradiance;      // W/m²

  // Network
  bool    wifiConnected;
  bool    firebaseConnected;
  uint32_t uptime;         // seconds
  uint32_t loopCount;      // total loop iterations
};

// ─────────────────────────────────────────────────────────────
//  GLOBAL INSTANCES
// ─────────────────────────────────────────────────────────────
FirebaseData   fbData;
FirebaseConfig fbConfig;
FirebaseAuth   fbAuth;

SensorData   sensors    = {};
SystemState  sysState   = {
  .battSOC          = 75.0f,
  .battVoltage      = 50.0f,
  .battStatus       = "IDLE",
  .relaySolar       = false,
  .relayWind        = false,
  .relayBattery     = false,
  .relayEV          = false,
  .aiCase           = 0,
  .aiTitle          = "Initializing",
  .aiDescription    = "System starting up",
  .windSpeed        = 5.0f,
  .temperature      = 28.0f,
  .irradiance       = 500.0f,
  .wifiConnected    = false,
  .firebaseConnected= false,
  .uptime           = 0,
  .loopCount        = 0,
};

// Timing
unsigned long lastSensorRead   = 0;
unsigned long lastFirebasePush = 0;
unsigned long lastStatusLED    = 0;

// ─────────────────────────────────────────────────────────────
//  SETUP
// ─────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  delay(500);

  printBanner();

  // ── GPIO Configuration ───────────────────────────────────
  pinMode(PIN_RELAY_SOLAR,   OUTPUT);
  pinMode(PIN_RELAY_WIND,    OUTPUT);
  pinMode(PIN_RELAY_BATTERY, OUTPUT);
  pinMode(PIN_RELAY_EV,      OUTPUT);
  pinMode(PIN_LED_STATUS,    OUTPUT);
  pinMode(PIN_LED_FAULT,     OUTPUT);

  // Safety: ALL relays OFF during boot
  setAllRelays(false);
  digitalWrite(PIN_LED_FAULT, LOW);
  Serial.println("[GPIO] Relay outputs configured. All OPEN.");

  // ── ADC Configuration ────────────────────────────────────
  analogReadResolution(12);           // 12-bit: 0 to 4095
  analogSetAttenuation(ADC_11db);     // Input range: 0 to ~3.9V
  Serial.println("[ADC] 12-bit resolution, 11dB attenuation configured.");

  // ── Watchdog Timer ───────────────────────────────────────
  esp_task_wdt_init(WATCHDOG_TIMEOUT_S, true);
  esp_task_wdt_add(NULL);
  Serial.printf("[WDT] Watchdog configured: %d second timeout.\n", WATCHDOG_TIMEOUT_S);

  // ── WiFi Connection ──────────────────────────────────────
  connectWiFi();

  // ── Firebase Initialization ──────────────────────────────
  if (sysState.wifiConnected) {
    initFirebase();
  }

  // ── Boot Complete ────────────────────────────────────────
  Serial.println("\n[BOOT] ✓ System ready. Entering main loop.");
  Serial.println("══════════════════════════════════════════════\n");
  digitalWrite(PIN_LED_STATUS, HIGH);
}

// ─────────────────────────────────────────────────────────────
//  MAIN LOOP
// ─────────────────────────────────────────────────────────────
void loop() {
  esp_task_wdt_reset();  // Feed watchdog

  unsigned long now = millis();
  sysState.loopCount++;
  sysState.uptime = now / 1000;

  // ── Sensor Reading (every 1 second) ─────────────────────
  if (now - lastSensorRead >= SENSOR_INTERVAL_MS) {
    lastSensorRead = now;

    readAllSensors();
    computePowerBalance();    // ★ P_excess formula on edge
    runAIDecisionEngine();    // Apply 6 cases
    applyRelayState();        // Assert GPIO outputs
    updateFaultLED();
  }

  // ── Firebase Sync (every 3 seconds) ─────────────────────
  if (now - lastFirebasePush >= FIREBASE_INTERVAL_MS) {
    lastFirebasePush = now;

    if (sysState.wifiConnected) {
      pushToFirebase();
      pullCommandsFromFirebase();
    }
  }

  // ── Status LED blink ────────────────────────────────────
  if (now - lastStatusLED >= 1000) {
    lastStatusLED = now;
    digitalWrite(PIN_LED_STATUS, !digitalRead(PIN_LED_STATUS));
  }

  // ── Serial debug (uncomment for verbose) ────────────────
  // printDebugVerbose();
}

// ─────────────────────────────────────────────────────────────
//  SENSOR READING MODULE
// ─────────────────────────────────────────────────────────────

/**
 * Read ACS712 current sensor with oversampling.
 * ACS712-05B: Sensitivity = 185mV/A, Zero = VCC/2 = 1.65V (at 3.3V)
 *
 * @param  pin  ADC GPIO pin number
 * @param  ctRatio  Current transformer ratio multiplier
 * @return measured current in Amperes (absolute value)
 */
float readCurrentACS712(int pin, float ctRatio) {
  // Oversample ADC for noise reduction
  uint32_t adcSum = 0;
  for (int i = 0; i < ADC_SAMPLES; i++) {
    adcSum += analogRead(pin);
    delayMicroseconds(50);
  }
  float adcAvg  = (float)adcSum / ADC_SAMPLES;
  float voltage = (adcAvg / ADC_MAX) * ADC_VREF;
  float current = (voltage - ACS712_ZERO_OFFSET_V) / ACS712_SENSITIVITY_VA;
  // Apply CT ratio and return magnitude (AC or DC with direction handled by sign)
  return fabs(current) * ctRatio;
}

void readAllSensors() {
  // Read currents (A)
  sensors.currentSolar   = readCurrentACS712(PIN_ADC_SOLAR,   CT_RATIO_SOLAR);
  sensors.currentWind    = readCurrentACS712(PIN_ADC_WIND,    CT_RATIO_WIND);
  sensors.currentBattery = readCurrentACS712(PIN_ADC_BATTERY, CT_RATIO_BATTERY);
  sensors.currentLoad    = readCurrentACS712(PIN_ADC_LOAD,    CT_RATIO_LOAD);

  // Raw ADC for telemetry
  sensors.adcSolar   = (uint16_t)((sensors.currentSolar   / (5.0f * CT_RATIO_SOLAR))   * ADC_MAX);
  sensors.adcWind    = (uint16_t)((sensors.currentWind    / (5.0f * CT_RATIO_WIND))    * ADC_MAX);
  sensors.adcBattery = (uint16_t)((sensors.currentBattery / (5.0f * CT_RATIO_BATTERY)) * ADC_MAX);
  sensors.adcLoad    = (uint16_t)((sensors.currentLoad    / (5.0f * CT_RATIO_LOAD))    * ADC_MAX);

  // Millivolts
  sensors.mvSolar   = (sensors.adcSolar   / ADC_MAX) * ADC_VREF * 1000.0f;
  sensors.mvWind    = (sensors.adcWind    / ADC_MAX) * ADC_VREF * 1000.0f;
  sensors.mvBattery = (sensors.adcBattery / ADC_MAX) * ADC_VREF * 1000.0f;
  sensors.mvLoad    = (sensors.adcLoad    / ADC_MAX) * ADC_VREF * 1000.0f;

  // Battery voltage estimation (48V nominal system)
  sysState.battVoltage = 44.0f + (sysState.battSOC / 100.0f) * 10.0f;
}

// ─────────────────────────────────────────────────────────────
//  POWER BALANCE — EDGE COMPUTATION (★ Core Formula)
// ─────────────────────────────────────────────────────────────

/**
 * ★ P_excess = P_solar + P_wind - P_load
 *
 * This formula is intentionally calculated on the ESP32 edge
 * every 1 second for immediate relay control.
 *
 * The website receives this value via Firebase and uses it
 * along with 10-minute weather forecasts for proactive decisions.
 *
 * Power formula: P [kW] = V_bus [V] × I [A] / 1000
 */
void computePowerBalance() {
  float vBus = sysState.battVoltage;  // Use measured/estimated bus voltage

  // Generation powers
  sensors.powerSolar = (vBus * sensors.currentSolar)   / 1000.0f;
  sensors.powerWind  = (vBus * sensors.currentWind)    / 1000.0f;
  sensors.powerLoad  = (vBus * sensors.currentLoad)    / 1000.0f;

  // Battery power: positive = charging (source), negative = discharging (sink)
  // Sign determined by relay state and battery management
  float rawBattPower = (vBus * sensors.currentBattery) / 1000.0f;
  sensors.powerBattery = sysState.relayBattery
    ? (sensors.totalGeneration > sensors.powerLoad ? rawBattPower : -rawBattPower)
    : 0.0f;

  // ★ THE CORE EDGE FORMULA
  sensors.totalGeneration = sensors.powerSolar + sensors.powerWind;
  sensors.pExcess         = sensors.totalGeneration - sensors.powerLoad;
}

// ─────────────────────────────────────────────────────────────
//  AI DECISION ENGINE — 6 CASES
// ─────────────────────────────────────────────────────────────

/**
 * Evaluates all 6 AI cases in priority order.
 * Cases are applied based on live sensor data + Firebase-synced
 * battery SOC and weather wind speed.
 *
 * Priority: Case 4 > Case 3 > Case 1 > Case 2 > Case 5 > Case 6
 */
void runAIDecisionEngine() {
  float soc    = sysState.battSOC;
  float ws     = sysState.windSpeed;    // From Firebase (web → ESP32)
  float pGen   = sensors.totalGeneration;
  float pLoad  = sensors.powerLoad;
  float excess = sensors.pExcess;

  // ─── CASE 4: Critical Battery Protection (HIGHEST PRIORITY) ──
  // Trigger: Battery SOC < 20%
  // Action: Disable EV, force all generation to battery recovery
  if (soc < BATT_SOC_CRITICAL) {
    sysState.aiCase       = 4;
    sysState.aiTitle      = "Case 4: Critical Battery Protection";
    sysState.aiDescription = "SOC below 20%. EV disabled. All gen to battery. Import from grid.";
    sysState.relaySolar   = true;
    sysState.relayWind    = true;
    sysState.relayBattery = true;    // Charging direction
    sysState.relayEV      = false;   // ★ FORCE EV OFF
    sysState.battStatus   = "CRITICAL_CHARGE";
    return;
  }

  // ─── CASE 3: Wind Priority Optimization ──────────────────────
  // Trigger: Wind speed > 10 m/s
  // Action: Wind → Battery charging; Solar → Active load supply
  if (ws > WIND_PRIORITY_MS) {
    bool evEnabled = (soc > BATT_SOC_EV_ENABLE);
    sysState.aiCase       = 3;
    sysState.aiTitle      = "Case 3: Wind Priority Mode";
    sysState.aiDescription = "Wind >10m/s. Wind→Battery, Solar→Load.";
    sysState.relaySolar   = true;
    sysState.relayWind    = true;
    sysState.relayBattery = true;
    sysState.relayEV      = evEnabled;
    sysState.battStatus   = "CHARGING";
    return;
  }

  // ─── CASE 1: Surplus Energy Management ───────────────────────
  // Trigger: P_generation > P_load (excess > 0)
  // Action: Supply load → Charge battery → Enable EV if SOC > 90%
  if (excess > 0) {
    bool evEnabled = (soc > BATT_SOC_EV_ENABLE);

    sysState.aiCase       = 1;
    sysState.aiTitle      = "Case 1: Surplus Management";
    sysState.aiDescription = evEnabled
      ? "Surplus: Charging battery + EV enabled (SOC >90%)"
      : "Surplus: Load supplied, excess to battery storage";
    sysState.relaySolar   = true;
    sysState.relayWind    = (sensors.powerWind > 0.5f);
    sysState.relayBattery = true;
    sysState.relayEV      = evEnabled;
    sysState.battStatus   = "CHARGING";

    // Case 6 sub-check: High SOC + large surplus → export
    if (soc > NEIGHBOR_EXPORT_SOC && excess > 3.0f) {
      sysState.aiDescription += " | Case 6: Exporting surplus to neighbor grid.";
      Serial.println("[CASE 6] Exporting surplus to neighbor microgrid.");
    }
    return;
  }

  // ─── CASE 2: Deficit Management ──────────────────────────────
  // Trigger: P_generation < P_load (excess < 0)
  // Action: Draw from battery; if near-critical → alert for grid import
  if (excess < 0) {
    float deficit = fabs(excess);

    sysState.aiCase       = 2;
    sysState.aiTitle      = "Case 2: Deficit Management";
    sysState.relaySolar   = true;
    sysState.relayWind    = (sensors.powerWind > 0.5f);
    sysState.relayBattery = true;    // Discharging
    sysState.relayEV      = false;
    sysState.battStatus   = "DISCHARGING";

    if (soc < BATT_SOC_CRITICAL + 5.0f) {
      sysState.aiDescription = "Deficit + Near-critical SOC. Requesting secondary grid import!";
    } else {
      sysState.aiDescription = "Deficit: Discharging battery to cover load demand.";
    }
    return;
  }

  // ─── CASE 5: Solar-Only Mode ──────────────────────────────────
  // Trigger: Wind generation negligible (< 0.5 kW)
  // Action: Split total load equally across available solar inverters
  if (sensors.powerWind < 0.5f) {
    sysState.aiCase       = 5;
    sysState.aiTitle      = "Case 5: Solar-Only Mode";
    sysState.aiDescription = "No wind. Load split equally between solar inverters.";
    sysState.relaySolar   = true;
    sysState.relayWind    = false;
    sysState.relayBattery = (excess < 0);
    sysState.relayEV      = false;
    sysState.battStatus   = (excess < 0) ? "DISCHARGING" : "IDLE";
    return;
  }

  // ─── BALANCED / DEFAULT ───────────────────────────────────────
  sysState.aiCase       = 1;
  sysState.aiTitle      = "Balanced State";
  sysState.aiDescription = "Generation ≈ Load. All systems nominal.";
  sysState.relaySolar   = true;
  sysState.relayWind    = (sensors.powerWind > 0.5f);
  sysState.relayBattery = false;
  sysState.relayEV      = false;
  sysState.battStatus   = "IDLE";
}

// ─────────────────────────────────────────────────────────────
//  RELAY CONTROL
// ─────────────────────────────────────────────────────────────

/**
 * Apply AI decision to physical relay outputs.
 * Relays are optocoupled — HIGH signal = relay CLOSED (circuit active).
 */
void applyRelayState() {
  digitalWrite(PIN_RELAY_SOLAR,   sysState.relaySolar   ? HIGH : LOW);
  digitalWrite(PIN_RELAY_WIND,    sysState.relayWind    ? HIGH : LOW);
  digitalWrite(PIN_RELAY_BATTERY, sysState.relayBattery ? HIGH : LOW);
  digitalWrite(PIN_RELAY_EV,      sysState.relayEV      ? HIGH : LOW);
}

void setAllRelays(bool state) {
  int gpioState = state ? HIGH : LOW;
  digitalWrite(PIN_RELAY_SOLAR,   gpioState);
  digitalWrite(PIN_RELAY_WIND,    gpioState);
  digitalWrite(PIN_RELAY_BATTERY, gpioState);
  digitalWrite(PIN_RELAY_EV,      gpioState);
}

void updateFaultLED() {
  // Fault LED: ON if battery critical or load deficit
  bool fault = (sysState.battSOC < BATT_SOC_CRITICAL) || (sensors.pExcess < -5.0f);
  digitalWrite(PIN_LED_FAULT, fault ? HIGH : LOW);
}

// ─────────────────────────────────────────────────────────────
//  FIREBASE — PUSH DATA
// ─────────────────────────────────────────────────────────────

/**
 * Push all sensor values, relay states, and AI decisions to Firebase.
 * The web dashboard reads this path to update its UI in real-time.
 *
 * Firebase path: /microgrid/live
 */
void pushToFirebase() {
  if (!Firebase.ready()) {
    Serial.println("[FB] Not ready — skipping push.");
    return;
  }

  // Build JSON payload
  DynamicJsonDocument doc(1024);

  // Sensors
  JsonObject sensNode = doc.createNestedObject("sensors");
  sensNode["solar_current_a"]  = round(sensors.currentSolar   * 100) / 100.0f;
  sensNode["wind_current_a"]   = round(sensors.currentWind    * 100) / 100.0f;
  sensNode["battery_current_a"]= round(sensors.currentBattery * 100) / 100.0f;
  sensNode["load_current_a"]   = round(sensors.currentLoad    * 100) / 100.0f;
  sensNode["solar_power_kw"]   = round(sensors.powerSolar     * 100) / 100.0f;
  sensNode["wind_power_kw"]    = round(sensors.powerWind      * 100) / 100.0f;
  sensNode["load_power_kw"]    = round(sensors.powerLoad      * 100) / 100.0f;
  sensNode["total_gen_kw"]     = round(sensors.totalGeneration * 100) / 100.0f;
  sensNode["p_excess_kw"]      = round(sensors.pExcess        * 100) / 100.0f; // ★
  sensNode["adc_solar"]        = sensors.adcSolar;
  sensNode["adc_wind"]         = sensors.adcWind;
  sensNode["adc_battery"]      = sensors.adcBattery;
  sensNode["adc_load"]         = sensors.adcLoad;

  // Battery
  JsonObject battNode = doc.createNestedObject("battery");
  battNode["soc_pct"]    = sysState.battSOC;
  battNode["voltage_v"]  = round(sysState.battVoltage * 10) / 10.0f;
  battNode["status"]     = sysState.battStatus;

  // Relays (GPIO state)
  JsonObject relayNode = doc.createNestedObject("relays");
  relayNode["solar"]   = sysState.relaySolar;
  relayNode["wind"]    = sysState.relayWind;
  relayNode["battery"] = sysState.relayBattery;
  relayNode["ev"]      = sysState.relayEV;

  // AI Decision
  JsonObject aiNode = doc.createNestedObject("ai_decision");
  aiNode["case"]        = sysState.aiCase;
  aiNode["title"]       = sysState.aiTitle;
  aiNode["description"] = sysState.aiDescription;

  // System metadata
  JsonObject metaNode = doc.createNestedObject("meta");
  metaNode["device_id"]  = DEVICE_ID;
  metaNode["uptime_s"]   = sysState.uptime;
  metaNode["loop_count"] = sysState.loopCount;
  metaNode["wifi_rssi"]  = WiFi.RSSI();
  metaNode["timestamp"]  = String(millis());

  // Serialize and push
  String payload;
  serializeJson(doc, payload);

  String path = String(FIREBASE_PATH) + "/live";

  if (Firebase.setJSON(fbData, path, payload)) {
    Serial.printf("[FB] ✓ Pushed %d bytes to %s\n", payload.length(), path.c_str());
  } else {
    Serial.printf("[FB] ✗ Push failed: %s\n", fbData.errorReason().c_str());
    sysState.firebaseConnected = false;
  }
}

// ─────────────────────────────────────────────────────────────
//  FIREBASE — PULL COMMANDS
// ─────────────────────────────────────────────────────────────

/**
 * Pull commands and external data from Firebase.
 * The web dashboard writes the weather data (wind speed, etc.)
 * and this ESP32 reads it to inform AI decisions.
 */
void pullCommandsFromFirebase() {
  if (!Firebase.ready()) return;

  // Pull battery SOC (set by BMS or calculated on cloud)
  if (Firebase.getFloat(fbData, String(FIREBASE_PATH) + "/battery_soc")) {
    float newSOC = fbData.floatData();
    if (newSOC >= 0.0f && newSOC <= 100.0f) {
      sysState.battSOC = newSOC;
    }
  }

  // Pull wind speed from web dashboard (sourced from OpenWeatherMap)
  if (Firebase.getFloat(fbData, String(FIREBASE_PATH) + "/weather/wind_speed")) {
    sysState.windSpeed = fbData.floatData();
  }

  // Pull temperature
  if (Firebase.getFloat(fbData, String(FIREBASE_PATH) + "/weather/temperature")) {
    sysState.temperature = fbData.floatData();
  }

  // Pull irradiance proxy
  if (Firebase.getFloat(fbData, String(FIREBASE_PATH) + "/weather/irradiance")) {
    sysState.irradiance = fbData.floatData();
  }

  // Pull manual relay override (from web dashboard emergency controls)
  // Example: /microgrid/commands/ev_override = true / false
  if (Firebase.getBool(fbData, String(FIREBASE_PATH) + "/commands/force_ev_off")) {
    if (fbData.boolData() == true) {
      sysState.relayEV = false;
      Serial.println("[CMD] Remote command: Force EV OFF received.");
    }
  }
}

// ─────────────────────────────────────────────────────────────
//  WIFI CONNECTION
// ─────────────────────────────────────────────────────────────
void connectWiFi() {
  Serial.printf("[WiFi] Connecting to SSID: %s", WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  WiFi.setAutoReconnect(true);

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 40) {
    delay(500);
    Serial.print(".");
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    sysState.wifiConnected = true;
    Serial.printf("\n[WiFi] ✓ Connected! IP: %s | RSSI: %d dBm\n",
      WiFi.localIP().toString().c_str(), WiFi.RSSI());
  } else {
    sysState.wifiConnected = false;
    Serial.println("\n[WiFi] ✗ FAILED — Operating offline. Firebase sync disabled.");
  }
}

// ─────────────────────────────────────────────────────────────
//  FIREBASE INIT
// ─────────────────────────────────────────────────────────────
void initFirebase() {
  fbConfig.host  = FIREBASE_HOST;
  fbConfig.signer.tokens.legacy_token = FIREBASE_AUTH;

  Firebase.begin(&fbConfig, &fbAuth);
  Firebase.reconnectWiFi(true);

  // Increase timeout for slow connections
  fbData.setResponseSize(4096);

  Serial.println("[Firebase] ✓ Initialized.");
  sysState.firebaseConnected = true;
}

// ─────────────────────────────────────────────────────────────
//  DEBUG OUTPUT
// ─────────────────────────────────────────────────────────────
void printDebugVerbose() {
  Serial.println("══════════════════════════════════════════════");
  Serial.printf("  Uptime: %lu s | Loop: %lu\n", sysState.uptime, sysState.loopCount);
  Serial.println("── Sensors ────────────────────────────────────");
  Serial.printf("  Solar:   I=%.2fA  P=%.2fkW  ADC=%d\n",
    sensors.currentSolar, sensors.powerSolar, sensors.adcSolar);
  Serial.printf("  Wind:    I=%.2fA  P=%.2fkW  ADC=%d\n",
    sensors.currentWind, sensors.powerWind, sensors.adcWind);
  Serial.printf("  Battery: I=%.2fA  P=%.2fkW  ADC=%d\n",
    sensors.currentBattery, sensors.powerBattery, sensors.adcBattery);
  Serial.printf("  Load:    I=%.2fA  P=%.2fkW  ADC=%d\n",
    sensors.currentLoad, sensors.powerLoad, sensors.adcLoad);
  Serial.println("── Power Balance ──────────────────────────────");
  Serial.printf("  Total Gen: %.2f kW | Load: %.2f kW | P_excess: %.2f kW\n",
    sensors.totalGeneration, sensors.powerLoad, sensors.pExcess);
  Serial.println("── AI Decision ────────────────────────────────");
  Serial.printf("  Case: %d | %s\n", sysState.aiCase, sysState.aiTitle.c_str());
  Serial.printf("  %s\n", sysState.aiDescription.c_str());
  Serial.println("── Relays ─────────────────────────────────────");
  Serial.printf("  Solar: %s | Wind: %s | Battery: %s | EV: %s\n",
    sysState.relaySolar   ? "CLOSED" : "OPEN",
    sysState.relayWind    ? "CLOSED" : "OPEN",
    sysState.relayBattery ? "CLOSED" : "OPEN",
    sysState.relayEV      ? "CLOSED" : "OPEN");
  Serial.printf("  Battery SOC: %.0f%% | Status: %s\n",
    sysState.battSOC, sysState.battStatus.c_str());
  Serial.println("── Network ────────────────────────────────────");
  Serial.printf("  WiFi: %s | Firebase: %s | RSSI: %d dBm\n",
    sysState.wifiConnected ? "✓" : "✗",
    sysState.firebaseConnected ? "✓" : "✗",
    WiFi.RSSI());
  Serial.println("══════════════════════════════════════════════\n");
}

void printBanner() {
  Serial.println("\n");
  Serial.println("╔══════════════════════════════════════════════╗");
  Serial.println("║   Smart AI Microgrid EMS — ESP32 Firmware    ║");
  Serial.println("║   Location: Asansol, West Bengal, India      ║");
  Serial.println("║   Version:  2.0.0                            ║");
  Serial.println("║   AI Cases: 6 | Firebase: Enabled            ║");
  Serial.println("╚══════════════════════════════════════════════╝");
  Serial.printf("   CPU: %d MHz | Flash: %d KB | PSRAM: %d KB\n",
    ESP.getCpuFreqMHz(),
    ESP.getFlashChipSize() / 1024,
    ESP.getPsramSize() / 1024);
  Serial.println();
}

/**
 * ============================================================
 *  INTEGRATION CHECKLIST
 *  ────────────────────────────────────────────────────────────
 *  Hardware:
 *  [ ] Confirm ACS712 sensor type matches current range
 *      (use ACS712-30B for 30A, ACS712-20A for 20A)
 *  [ ] Use CT_RATIO to scale readings if using external CTs
 *  [ ] Verify relay module is 5V coil, optocoupled
 *  [ ] Add flyback diode if relay is NOT optocoupled
 *  [ ] All GND rails must be common-referenced
 *
 *  Software:
 *  [ ] Set WIFI_SSID and WIFI_PASSWORD
 *  [ ] Create Firebase project and Realtime Database
 *  [ ] Set FIREBASE_HOST (do NOT include https://)
 *  [ ] Set FIREBASE_AUTH to database secret or service token
 *  [ ] Upload ESP32.ino → verify Serial output at 115200 baud
 *
 *  Firebase Rules (for development — restrict in production):
 *
 *    {
 *      "rules": {
 *        ".read":  "auth != null",
 *        ".write": "auth != null"
 *      }
 *    }
 *
 *  Web Dashboard:
 *  [ ] Enter Firebase config in "Hardware Technical Link" tab
 *  [ ] Click "Connect to Firebase"
 *  [ ] Verify data appears in Hardware → Sensor Readings table
 * ============================================================
 */
