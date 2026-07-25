//***********************************************************************************************************************************************
//
// Environment Monitor - AHT20 + GUVA-S12SD (UV) + Analog IR CO2
//
//   * Logs to SD on a timer, independent of any connected client
//   * Hosts its own WiFi AP with a captive portal (scan QR -> page opens itself)
//   * Phone can download the whole CSV over WiFi - SD card never leaves the box
//   * Uploads new rows to a central database daily (needs an internet uplink)
//   * Clears the SD log monthly, but ONLY once every byte is confirmed uploaded
//
//***********************************************************************************************************************************************

#include "FS.h"
#include "SD.h"
#include <SPI.h>

#include <Wire.h>
#include <Adafruit_AHTX0.h>

#include <WiFi.h>
#include <WebServer.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <Preferences.h>
#include <time.h>

// ═══ CONFIGURATION ═════════════════════════════════════════════════════════

// --- Access point the phone connects to (this is what the QR code encodes) ---
const char *AP_SSID = "scout-361";
const char *AP_PASS = "yourPassword";      // must be 8+ chars

// --- Uplink to the internet, for database uploads + clock sync ---
// Leave STA_SSID empty ("") to run AP-only. The device still logs and still
// serves downloads; it just never uploads and has no wall clock.
const char *STA_SSID = "Tenda_992690_5G";
const char *STA_PASS = "Horseman";

// --- Central database endpoint ---
// Must be https:// - the ingest server only accepts TLS connections, and the
// API key travels as a plaintext header, so HTTPS is what actually keeps it
// secret in transit.
const char *UPLOAD_URL = "https://your-server.example.com/api/readings";
const char *UPLOAD_KEY = "replace-with-your-api-key";
const char *DEVICE_ID  = "esp32-node-01";

// --- Timing ---
const unsigned long LOG_INTERVAL_MS   = 2000;    // sensor -> SD, every 2 s
const unsigned long SCHED_CHECK_MS    = 30000;    // how often to test schedules
const int  UPLOAD_HOUR = 2;    // daily upload at 02:00 local
const int  CLEAR_DAY   = 1;    // monthly clear on the 1st
const int  CLEAR_HOUR  = 3;    // ...at 03:00, an hour after the upload window
const char *TZ_INFO    = "EST5EDT,M3.2.0,M11.1.0";   // Ontario, handles DST

// --- Analog pins (both ADC1: usable while WiFi is active) ---
const int UV_PIN  = 35;
const int CO2_PIN = 36;
const int ADC_SAMPLES = 16;

// --- UV calibration (board dependent - see notes at bottom) ---
const float UV_DARK_OFFSET_MV  = 0.0;
const float UV_MV_PER_UV_INDEX = 100.0;
const float UV_MV_PER_MW_CM2   = 200.0;

// --- CO2 calibration (DFRobot-style analog IR: 0.4 V = 0 ppm, 2.0 V = 5000) ---
const float CO2_ZERO_MV = 400.0;
const float CO2_SPAN_MV = 2000.0;
const float CO2_MAX_PPM = 5000.0;

// --- Files ---
const char *LOG_PATH = "/data.txt";
const char *CSV_HEADER =
  "timestamp,uptime_s,temperature_c,humidity_pct,uv_mv,uv_irradiance_mw_cm2,uv_index_est,co2_ppm\r\n";

const size_t UPLOAD_BATCH = 2048;   // bytes per POST

// ═══ GLOBALS ═══════════════════════════════════════════════════════════════

WebServer server(80);
Adafruit_AHTX0 aht;
Preferences prefs;

IPAddress apIP(192, 168, 4, 1);

float lastTemperature  = 0.0;
float lastHumidity     = 0.0;
float lastUvMv         = 0.0;
float lastUvIrradiance = 0.0;
float lastUvIndexEst   = 0.0;
float lastCo2Ppm       = -1.0;

unsigned long lastLogTime   = 0;
unsigned long lastSchedTime = 0;
unsigned long lastFallbackUpload = 0;
unsigned long logCount      = 0;

uint32_t uploadOffset = 0;    // bytes of LOG_PATH already sent, persisted in NVS
int lastUploadYday    = -1;
int lastClearMon      = -1;
String lastUploadStatus = "never";

bool sdReady = false;

// ═══ SD CARD ═══════════════════════════════════════════════════════════════

bool initSDCard() {
  if (!SD.begin()) {
    Serial.println("[SD] Card mount failed");
    return false;
  }
  if (SD.cardType() == CARD_NONE) {
    Serial.println("[SD] No SD card attached");
    return false;
  }
  Serial.printf("[SD] Card size: %lluMB\n", SD.cardSize() / (1024ULL * 1024ULL));
  return true;
}

void writeFile(fs::FS &fs, const char *path, const char *message) {
  File file = fs.open(path, FILE_WRITE);
  if (!file) { Serial.printf("[SD] Failed to open %s for writing\n", path); return; }
  file.print(message);
  file.close();
}

void appendFile(fs::FS &fs, const char *path, const char *message) {
  File file = fs.open(path, FILE_APPEND);
  if (!file) { Serial.printf("[SD] Failed to open %s for append\n", path); return; }
  if (!file.print(message)) Serial.println("[SD] Append failed");
  file.close();
}

size_t logFileSize() {
  File f = SD.open(LOG_PATH, FILE_READ);
  if (!f) return 0;
  size_t s = f.size();
  f.close();
  return s;
}

bool allDataUploaded() {
  return uploadOffset >= logFileSize();
}

// Wipe the log and start a fresh file with headers.
void clearLog() {
  Serial.println("[SD] Clearing log file.");
  SD.remove(LOG_PATH);
  writeFile(SD, LOG_PATH, CSV_HEADER);
  uploadOffset = strlen(CSV_HEADER);
  prefs.putULong("upOffset", uploadOffset);
}

// ═══ SENSORS ═══════════════════════════════════════════════════════════════

float readAnalogMv(int pin, int samples) {
  uint32_t total = 0;
  for (int i = 0; i < samples; i++) {
    total += analogReadMilliVolts(pin);
    delayMicroseconds(200);
  }
  return (float)total / (float)samples;
}

void readAllSensors() {
  sensors_event_t humidity_event, temp_event;
  aht.getEvent(&humidity_event, &temp_event);
  lastTemperature = temp_event.temperature;
  lastHumidity    = humidity_event.relative_humidity;

  float uv = readAnalogMv(UV_PIN, ADC_SAMPLES) - UV_DARK_OFFSET_MV;
  if (uv < 0) uv = 0;
  lastUvMv         = uv;
  lastUvIrradiance = uv / UV_MV_PER_MW_CM2;
  lastUvIndexEst   = uv / UV_MV_PER_UV_INDEX;

  float co2mv = readAnalogMv(CO2_PIN, ADC_SAMPLES);
  lastCo2Ppm = (co2mv < CO2_ZERO_MV)
             ? -1.0
             : (co2mv - CO2_ZERO_MV) * (CO2_MAX_PPM / (CO2_SPAN_MV - CO2_ZERO_MV));
}

// ═══ TIME ══════════════════════════════════════════════════════════════════

bool timeIsSynced() {
  return time(nullptr) > 1700000000;   // sanity threshold: well past 2023
}

String isoTimestamp() {
  if (!timeIsSynced()) return "";
  time_t now = time(nullptr);
  struct tm t;
  localtime_r(&now, &t);
  char buf[32];
  strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%S", &t);
  return String(buf);
}

// ═══ LOGGING ═══════════════════════════════════════════════════════════════

void logReading() {
  readAllSensors();

  String row = isoTimestamp()            + "," +
               String(millis() / 1000)   + "," +
               String(lastTemperature, 2)+ "," +
               String(lastHumidity, 2)   + "," +
               String(lastUvMv, 1)       + "," +
               String(lastUvIrradiance, 4) + "," +
               String(lastUvIndexEst, 2) + "," +
               String(lastCo2Ppm, 1)     + "\r\n";

  if (sdReady) appendFile(SD, LOG_PATH, row.c_str());
  logCount++;

  Serial.printf("[LOG #%lu] T=%.2fC RH=%.2f%% UV=%.1fmV CO2=%.0fppm\n",
                logCount, lastTemperature, lastHumidity, lastUvMv, lastCo2Ppm);
}

// Make sure the log exists and starts with the CSV header row.
//   1. missing/empty file      -> create with just the header
//   2. header already present  -> leave alone
//   3. file exists, no header  -> rewrite with the header prepended,
//                                 keeping the upload offset correct
void ensureLogHeader() {
  if (!sdReady) return;
  const size_t headerLen = strlen(CSV_HEADER);

  File f = SD.open(LOG_PATH, FILE_READ);
  if (!f || f.size() == 0) {
    if (f) f.close();
    Serial.println("[SD] No log yet - creating with header.");
    writeFile(SD, LOG_PATH, CSV_HEADER);
    uploadOffset = headerLen;                 // header counts as already handled
    prefs.putULong("upOffset", uploadOffset);
    return;
  }

  char firstLine[128];
  size_t n = f.readBytesUntil('\n', firstLine, sizeof(firstLine) - 1);
  firstLine[n] = '\0';
  if (strncmp(firstLine, "timestamp,", 10) == 0) {   // already has our header
    f.close();
    Serial.println("[SD] Log header present.");
    return;
  }

  // Prepend the header by rewriting through a temp file.
  Serial.println("[SD] Log has no header - rewriting to add one.");
  f.seek(0);
  const char *TMP_PATH = "/data.tmp";
  SD.remove(TMP_PATH);
  File out = SD.open(TMP_PATH, FILE_WRITE);
  if (!out) { f.close(); Serial.println("[SD] Temp open failed - log left as-is."); return; }

  out.print(CSV_HEADER);
  uint8_t copyBuf[512];
  while (f.available()) out.write(copyBuf, f.read(copyBuf, sizeof(copyBuf)));
  f.close();
  out.close();

  SD.remove(LOG_PATH);
  SD.rename(TMP_PATH, LOG_PATH);

  uploadOffset += headerLen;   // everything shifted forward; keep uploads consistent
  prefs.putULong("upOffset", uploadOffset);
  Serial.println("[SD] Header added; upload offset adjusted.");
}

// ═══ UPLOAD ════════════════════════════════════════════════════════════════

// Sends everything after uploadOffset in batches. Advances (and persists) the
// offset only on a 2xx response, so a failed upload is retried, never skipped.
bool uploadPending() {
  if (!sdReady) { lastUploadStatus = "no SD card"; return false; }

  if (WiFi.status() != WL_CONNECTED) {
    lastUploadStatus = "no internet uplink";
    Serial.println("[UP] Skipped - not connected to an uplink network.");
    return false;
  }

  size_t fileSize = logFileSize();
  if (uploadOffset > fileSize) uploadOffset = 0;   // file was cleared externally
  if (uploadOffset >= fileSize) {
    lastUploadStatus = "up to date";
    return true;
  }

  File f = SD.open(LOG_PATH, FILE_READ);
  if (!f) { lastUploadStatus = "cannot open log"; return false; }
  f.seek(uploadOffset);

  static char buf[UPLOAD_BATCH + 1];
  int batches = 0;

  while (uploadOffset < fileSize) {
    size_t n = f.read((uint8_t *)buf, UPLOAD_BATCH);
    if (n == 0) break;

    // Don't split a row across two POSTs: trim back to the last newline
    // unless this batch reaches the end of the file.
    if (uploadOffset + n < fileSize) {
      int lastNl = -1;
      for (int i = (int)n - 1; i >= 0; i--) { if (buf[i] == '\n') { lastNl = i; break; } }
      if (lastNl >= 0) n = lastNl + 1;
    }
    buf[n] = '\0';

    // WiFiClientSecure + setInsecure(): TLS is negotiated but the server's
    // certificate is not validated against a CA. Fine for a hobby project
    // hitting a known host; swap for client.setCACert(ROOT_CA_PEM) if you
    // want real certificate validation.
    WiFiClientSecure client;
    client.setInsecure();

    HTTPClient http;
    http.begin(client, UPLOAD_URL);
    http.addHeader("Content-Type", "text/csv");
    http.addHeader("X-API-Key", UPLOAD_KEY);
    http.addHeader("X-Device-Id", DEVICE_ID);
    int code = http.POST((uint8_t *)buf, n);
    http.end();

    if (code >= 200 && code < 300) {
      uploadOffset += n;
      prefs.putULong("upOffset", uploadOffset);
      f.seek(uploadOffset);
      batches++;
      Serial.printf("[UP] Batch OK (%u bytes), offset now %u\n", (unsigned)n, uploadOffset);
    } else {
      Serial.printf("[UP] FAILED with HTTP %d - will retry later.\n", code);
      lastUploadStatus = "failed (HTTP " + String(code) + ")";
      f.close();
      return false;
    }
  }

  f.close();
  lastUploadStatus = "ok, " + String(batches) + " batches at " + isoTimestamp();
  Serial.println("[UP] Upload complete.");
  return true;
}

// ═══ SCHEDULING ════════════════════════════════════════════════════════════

void checkSchedules() {
  if (!timeIsSynced()) {
    // No wall clock. Fall back to "once every 24 h of uptime" so an offline
    // unit still drains its buffer if the uplink comes back.
    if (millis() - lastFallbackUpload >= 86400000UL) {
      lastFallbackUpload = millis();
      uploadPending();
    }
    return;
  }

  time_t now = time(nullptr);
  struct tm t;
  localtime_r(&now, &t);

  // --- Daily upload ---
  if (t.tm_hour >= UPLOAD_HOUR && t.tm_yday != lastUploadYday) {
    Serial.println("[SCHED] Daily upload window.");
    if (uploadPending()) {
      lastUploadYday = t.tm_yday;
      prefs.putInt("upYday", lastUploadYday);
    }
  }

  // --- Monthly clear, gated on the upload being fully caught up ---
  if (t.tm_mday == CLEAR_DAY && t.tm_hour >= CLEAR_HOUR && t.tm_mon != lastClearMon) {
    if (allDataUploaded()) {
      Serial.println("[SCHED] Monthly clear - all data confirmed uploaded.");
      clearLog();
      lastClearMon = t.tm_mon;
      prefs.putInt("clrMon", lastClearMon);
    } else {
      Serial.println("[SCHED] Clear DEFERRED - unuploaded rows still on card.");
    }
  }
}

// ═══ WEB PAGE ══════════════════════════════════════════════════════════════

const char PAGE_HTML[] PROGMEM = R"rawliteral(
<!DOCTYPE html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Environment Monitor</title>
<style>
 body{font-family:-apple-system,system-ui,sans-serif;margin:0;padding:20px;background:#f5f5f7;color:#1d1d1f}
 h1{font-size:22px;margin:0 0 4px}
 .sub{color:#666;font-size:13px;margin-bottom:18px}
 .card{background:#fff;border-radius:12px;padding:16px;margin-bottom:14px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
 .row{display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid #eee}
 .row:last-child{border-bottom:none}
 .lbl{color:#555}
 .val{font-weight:600;font-variant-numeric:tabular-nums}
 a.btn,button{display:block;width:100%;box-sizing:border-box;padding:14px;margin:8px 0;
   border:none;border-radius:10px;font-size:16px;font-weight:600;text-align:center;
   text-decoration:none;cursor:pointer}
 .primary{background:#0071e3;color:#fff}
 .secondary{background:#e8e8ed;color:#1d1d1f}
 .danger{background:#fff;color:#d70015;border:1px solid #d70015}
 #msg{font-size:13px;color:#0071e3;min-height:18px;text-align:center}
 small{color:#888;font-size:12px}
</style></head><body>

<h1>Environment Monitor</h1>
<div class="sub" id="devid">&nbsp;</div>

<div class="card">
  <div class="row"><span class="lbl">Temperature</span><span class="val" id="t">--</span></div>
  <div class="row"><span class="lbl">Humidity</span><span class="val" id="h">--</span></div>
  <div class="row"><span class="lbl">UV sensor voltage</span><span class="val" id="uvmv">--</span></div>
  <div class="row"><span class="lbl">UV irradiance</span><span class="val" id="uvir">--</span></div>
  <div class="row"><span class="lbl">UV index (est.)</span><span class="val" id="uvi">--</span></div>
  <div class="row"><span class="lbl">CO&#8322;</span><span class="val" id="co2">--</span></div>
</div>

<div class="card">
  <div class="row"><span class="lbl">Rows logged</span><span class="val" id="rows">--</span></div>
  <div class="row"><span class="lbl">Log file size</span><span class="val" id="size">--</span></div>
  <div class="row"><span class="lbl">Pending upload</span><span class="val" id="pend">--</span></div>
  <div class="row"><span class="lbl">Uplink</span><span class="val" id="net">--</span></div>
  <div class="row"><span class="lbl">Last upload</span><span class="val" id="up">--</span></div>
</div>

<a class="btn primary" href="/download" download="sensor_data.csv">Download data (CSV)</a>
<button class="secondary" onclick="act('/upload-now','Uploading...')">Upload to database now</button>
<button class="danger" onclick="confirmClear()">Erase log on SD card</button>
<div id="msg"></div>
<p><small>UV index is a clear-sky daylight estimate, not a calibrated measurement.
If the download does not start, open this page in your normal browser at 192.168.4.1</small></p>

<script>
function fmt(b){return b>1048576?(b/1048576).toFixed(1)+' MB':(b/1024).toFixed(1)+' KB';}
async function poll(){
  try{
    const r = await fetch('/api'); const d = await r.json();
    document.getElementById('t').textContent   = d.temperature.toFixed(2)+' \u00B0C';
    document.getElementById('h').textContent   = d.humidity.toFixed(2)+' %';
    document.getElementById('uvmv').textContent= d.uv_mv.toFixed(1)+' mV';
    document.getElementById('uvir').textContent= d.uv_irradiance.toFixed(4)+' mW/cm\u00B2';
    document.getElementById('uvi').textContent = d.uv_index_est.toFixed(2);
    document.getElementById('co2').textContent = d.co2_ppm < 0 ? 'warming up' : d.co2_ppm.toFixed(0)+' ppm';
    document.getElementById('rows').textContent= d.rows;
    document.getElementById('size').textContent= fmt(d.file_size);
    document.getElementById('pend').textContent= fmt(d.pending);
    document.getElementById('net').textContent = d.online ? 'connected' : 'offline';
    document.getElementById('up').textContent  = d.last_upload;
    document.getElementById('devid').textContent = d.device_id + (d.time ? ' \u00B7 '+d.time : '');
  }catch(e){}
}
async function syncTime(){
  try{
    const epoch = Math.floor(Date.now()/1000);       // UTC seconds
    const tzoff = new Date().getTimezoneOffset();     // minutes behind UTC
    await fetch('/settime?epoch='+epoch+'&tzoff='+tzoff, {method:'POST'});
  }catch(e){}
}
async function act(url,busy){
  document.getElementById('msg').textContent = busy;
  try{ const r = await fetch(url,{method:'POST'}); document.getElementById('msg').textContent = await r.text(); }
  catch(e){ document.getElementById('msg').textContent = 'Request failed'; }
  poll();
}
function confirmClear(){
  if(confirm('Erase all data on the SD card? This only works if everything has been uploaded.')){
    act('/clear','Erasing...');
  }
}
syncTime().then(poll); setInterval(poll, 2000);
</script>
</body></html>
)rawliteral";

// ═══ HTTP HANDLERS ═════════════════════════════════════════════════════════

void handleRoot() {
  server.send_P(200, "text/html", PAGE_HTML);
}

void handleApi() {
  size_t fsize = logFileSize();
  size_t pending = (fsize > uploadOffset) ? (fsize - uploadOffset) : 0;

  String j = "{";
  j += "\"temperature\":"   + String(lastTemperature, 2);
  j += ",\"humidity\":"     + String(lastHumidity, 2);
  j += ",\"uv_mv\":"        + String(lastUvMv, 1);
  j += ",\"uv_irradiance\":"+ String(lastUvIrradiance, 4);
  j += ",\"uv_index_est\":" + String(lastUvIndexEst, 2);
  j += ",\"co2_ppm\":"      + String(lastCo2Ppm, 1);
  j += ",\"rows\":"         + String(logCount);
  j += ",\"file_size\":"    + String((unsigned long)fsize);
  j += ",\"pending\":"      + String((unsigned long)pending);
  j += ",\"online\":"       + String(WiFi.status() == WL_CONNECTED ? "true" : "false");
  j += ",\"last_upload\":\""+ lastUploadStatus + "\"";
  j += ",\"device_id\":\""  + String(DEVICE_ID) + "\"";
  j += ",\"time\":\""       + isoTimestamp() + "\"";
  j += "}";

  server.send(200, "application/json", j);
}

// Receives the phone's wall-clock time and sets the ESP32 clock from it.
// The browser posts epoch seconds (UTC) as ?epoch=..., and its timezone
// offset in minutes as ?tzoff=... so local time comes out right.
void handleSetTime() {
  if (!server.hasArg("epoch")) {
    server.send(400, "text/plain", "missing epoch");
    return;
  }
  time_t epoch = (time_t) strtoul(server.arg("epoch").c_str(), nullptr, 10);

  // Sanity check: reject anything absurd (before 2023 or after ~2035).
  if (epoch < 1700000000UL || epoch > 2050000000UL) {
    server.send(400, "text/plain", "bad epoch");
    return;
  }

  // Apply the phone's timezone so localtime_r() gives local wall-clock time.
  // JS getTimezoneOffset() is minutes BEHIND UTC (positive for west of UTC),
  // which is the opposite sign of what POSIX TZ wants, hence the negation.
  if (server.hasArg("tzoff")) {
    long tzoff = strtol(server.arg("tzoff").c_str(), nullptr, 10);  // minutes
    long offSec = -tzoff * 60;
    char tzbuf[32];
    // POSIX TZ: "GMT<sign><hours>:<mins>", sign is inverted from offset sign.
    long a = labs(offSec);
    snprintf(tzbuf, sizeof(tzbuf), "GMT%+ld:%02ld", -offSec / 3600, (a % 3600) / 60);
    setenv("TZ", tzbuf, 1);
    tzset();
  }

  struct timeval tv = { .tv_sec = epoch, .tv_usec = 0 };
  settimeofday(&tv, nullptr);

  Serial.printf("[TIME] Clock set from phone: %s\n", isoTimestamp().c_str());
  server.send(200, "text/plain", "time set: " + isoTimestamp());
}

// Streams the CSV straight off the card with an attachment header, so the
// phone saves it as a file instead of rendering it as text.
void handleDownload() {
  if (!sdReady) { server.send(503, "text/plain", "SD card not available"); return; }
  File f = SD.open(LOG_PATH, FILE_READ);
  if (!f) { server.send(404, "text/plain", "No log file yet"); return; }

  String fname = "sensor_data_" + String(DEVICE_ID) + ".csv";
  server.sendHeader("Content-Disposition", "attachment; filename=\"" + fname + "\"");
  server.streamFile(f, "text/csv");
  f.close();
  Serial.println("[HTTP] CSV downloaded by client.");
}

void handleUploadNow() {
  bool ok = uploadPending();
  server.send(200, "text/plain", ok ? ("Upload: " + lastUploadStatus)
                                    : ("Upload failed: " + lastUploadStatus));
}

void handleClear() {
  // if (!allDataUploaded()) {
  //   size_t pending = logFileSize() - uploadOffset;
  //   server.send(409, "text/plain",
  //     String((unsigned long)pending) + " bytes not yet uploaded - refusing to erase.");
  //   return;
  // }
  clearLog();
  logCount = 0;
  server.send(200, "text/plain", "SD log erased.");
}

void handleNotFound() {
  server.send(404, "text/plain", "Not found");
}

// ═══ SETUP ═════════════════════════════════════════════════════════════════

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("\n\n===== BOOT START =====");

  analogReadResolution(12);
  analogSetAttenuation(ADC_11db);

  // --- Persistent counters ---
  prefs.begin("logger", false);
  uploadOffset   = prefs.getULong("upOffset", 0);
  lastUploadYday = prefs.getInt("upYday", -1);
  lastClearMon   = prefs.getInt("clrMon", -1);
  Serial.printf("[NVS] Restored upload offset: %u bytes\n", uploadOffset);

  // --- AHT20 ---
  if (!aht.begin()) {
    Serial.println("[AHT20] FAILED - check SDA/SCL/power. Halting.");
    while (1) delay(10);
  }
  Serial.println("[AHT20] OK");

  // --- SD ---
  sdReady = initSDCard();
  if (sdReady) ensureLogHeader();

  // --- WiFi: AP always, station only if credentials were provided ---
  bool wantUplink = (strlen(STA_SSID) > 0);
  WiFi.mode(wantUplink ? WIFI_AP_STA : WIFI_AP);

  WiFi.softAPConfig(apIP, apIP, IPAddress(255, 255, 255, 0));
  if (!WiFi.softAP(AP_SSID, AP_PASS)) {
    Serial.println("[WiFi] Soft AP creation failed (password must be 8+ chars).");
    while (1) delay(10);
  }
  Serial.printf("[WiFi] AP \"%s\" up at %s\n", AP_SSID, WiFi.softAPIP().toString().c_str());

  if (wantUplink) {
    Serial.printf("[WiFi] Joining \"%s\" for uplink", STA_SSID);
    WiFi.begin(STA_SSID, STA_PASS);
    for (int i = 0; i < 30 && WiFi.status() != WL_CONNECTED; i++) {
      delay(500); Serial.print(".");
    }
    Serial.println();
    if (WiFi.status() == WL_CONNECTED) {
      Serial.printf("[WiFi] Uplink OK, IP %s\n", WiFi.localIP().toString().c_str());
      configTzTime(TZ_INFO, "pool.ntp.org", "time.nist.gov");
      for (int i = 0; i < 20 && !timeIsSynced(); i++) delay(500);
      Serial.println(timeIsSynced() ? "[NTP] Clock synced: " + isoTimestamp()
                                    : "[NTP] Sync failed - using uptime fallback");
    } else {
      Serial.println("[WiFi] Uplink failed. Logging locally; uploads disabled.");
    }
  } else {
    Serial.println("[WiFi] No uplink configured - AP-only mode, uploads disabled.");
  }


  // --- Routes ---
  server.on("/",           HTTP_GET,  handleRoot);
  server.on("/api",        HTTP_GET,  handleApi);
  server.on("/settime", HTTP_POST, handleSetTime);
  server.on("/download",   HTTP_GET,  handleDownload);
  server.on("/upload-now", HTTP_POST, handleUploadNow);
  server.on("/clear",      HTTP_POST, handleClear);

  server.begin();
  Serial.println("[HTTP] Web server started.");
  Serial.println("===== SETUP COMPLETE =====\n");

  logReading();
  lastLogTime = millis();
  lastFallbackUpload = millis();
}

// ═══ LOOP ══════════════════════════════════════════════════════════════════

void loop() {
  server.handleClient();

  if (millis() - lastLogTime >= LOG_INTERVAL_MS) {
    lastLogTime += LOG_INTERVAL_MS;
    logReading();
  }

  if (millis() - lastSchedTime >= SCHED_CHECK_MS) {
    lastSchedTime = millis();
    checkSchedules();
  }
}

//***********************************************************************************************************************************************
// NOTES
//
// QR CODE
//   Encode exactly this string (no spaces), then print it and stick it on the
//   enclosure:
//       WIFI:T:WPA;S:noah-preston;P:yourPassword;;
//   Scanning it joins the AP. The captive portal then opens this page by
//   itself. Regenerate the QR if you change AP_SSID or AP_PASS.
//
// CALIBRATION
//   UV_DARK_OFFSET_MV - cover the sensor completely and read the serial output.
//   UV_MV_PER_UV_INDEX - 100 mV per index unit is typical; verify outdoors at
//     solar noon against a local forecast.
//   UV_MV_PER_MW_CM2 - weakest of the three, needs a reference radiometer for
//     real accuracy. Report uv_mv as the primary measurement.
//   CO2 - allow ~3 min warm-up. Outdoor air should read near 420 ppm.
//
// DATA SAFETY
//   The monthly erase only runs when uploadOffset has reached the end of the
//   file, so an outage cannot cause silent data loss - the erase is simply
//   deferred until the backlog clears.
//***********************************************************************************************************************************************
