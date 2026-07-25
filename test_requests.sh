#!/usr/bin/env bash
# Reproduces the device's upload behavior against a running server, including
# the awkward edge cases from the build spec. Run with bash (Git Bash on
# Windows works fine).
#
# Usage: HOST=https://your-app.onrender.com API_KEY=... ./test_requests.sh
# Defaults to localhost for local testing against `uvicorn server:app`.

HOST="${HOST:-http://127.0.0.1:8000}"
API_KEY="${API_KEY:-dev-key}"
DEVICE_ID="esp32-node-01"

echo "== health check =="
curl -i "$HOST/health"
echo -e "\n"

echo "== normal batch (expect 200, stored:1) =="
curl -i -X POST "$HOST/api/readings" \
  -H "Content-Type: text/csv" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Device-Id: $DEVICE_ID" \
  --data-binary $'2026-07-25T14:30:05,3600,22.54,45.10,142.0,0.7100,1.42,418.0\r\n'
echo -e "\n"

echo "== edge case: empty timestamp (leading comma) + co2 == -1 (expect 200, stored:1) =="
curl -i -X POST "$HOST/api/readings" \
  -H "Content-Type: text/csv" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Device-Id: $DEVICE_ID" \
  --data-binary $',3620,22.61,45.02,141.8,0.7090,1.42,-1.0\r\n'
echo -e "\n"

echo "== duplicate re-POST of the first row (expect 200, stored:0 -- deduped) =="
curl -i -X POST "$HOST/api/readings" \
  -H "Content-Type: text/csv" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Device-Id: $DEVICE_ID" \
  --data-binary $'2026-07-25T14:30:05,3600,22.54,45.10,142.0,0.7100,1.42,418.0\r\n'
echo -e "\n"

echo "== stray header line mixed into a batch (expect 200, stored:1, header line skipped) =="
curl -i -X POST "$HOST/api/readings" \
  -H "Content-Type: text/csv" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Device-Id: $DEVICE_ID" \
  --data-binary $'timestamp,uptime_s,temperature_c,humidity_pct,uv_mv,uv_irradiance_mw_cm2,uv_index_est,co2_ppm\r\n2026-07-25T14:31:05,3660,22.60,45.20,142.5,0.7125,1.43,419.0\r\n'
echo -e "\n"

echo "== bad key (expect 401) =="
curl -i -X POST "$HOST/api/readings" \
  -H "Content-Type: text/csv" -H "X-API-Key: wrong" \
  -H "X-Device-Id: $DEVICE_ID" \
  --data-binary $'2026-07-25T14:32:05,3720,22.60,45.20,142.5,0.7125,1.43,419.0\r\n'
echo -e "\n"

echo "== malformed line, wrong field count (expect 400) =="
curl -i -X POST "$HOST/api/readings" \
  -H "Content-Type: text/csv" \
  -H "X-API-Key: $API_KEY" \
  -H "X-Device-Id: $DEVICE_ID" \
  --data-binary $'2026-07-25T14:33:05,3780,22.60\r\n'
echo -e "\n"

echo "== missing X-Device-Id header (expect 400/422) =="
curl -i -X POST "$HOST/api/readings" \
  -H "Content-Type: text/csv" \
  -H "X-API-Key: $API_KEY" \
  --data-binary $'2026-07-25T14:34:05,3840,22.60,45.20,142.5,0.7125,1.43,419.0\r\n'
echo -e "\n"

echo "== read back last 5 rows for this device (expect 200, JSON array) =="
curl -i "$HOST/api/readings?device_id=$DEVICE_ID&limit=5" \
  -H "X-API-Key: $API_KEY"
echo -e "\n"

echo "== simulated DB outage: point DATABASE_URL at something unreachable and re-run the"
echo "   'normal batch' request above -- expect 500, and confirm no row was written once"
echo "   the DB is back (the device would retry this same batch again on its own)."
