#!/usr/bin/env bash
# Emits a steady trickle of OTLP traces and logs, for watching the console with
# something moving in it. Not a load generator — one small trace per tick.
#
#   tools/generate-telemetry.sh [seconds-between-ticks] [endpoint]
set -u

INTERVAL="${1:-2}"
ENDPOINT="${2:-http://localhost:4318}"

SERVICES=(checkout-api payments inventory)
OPERATIONS=(GET_/cart POST_/checkout GET_/inventory POST_/charge GET_/health)

hex() { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }

tick=0
while true; do
  tick=$((tick + 1))
  service="${SERVICES[$((RANDOM % ${#SERVICES[@]}))]}"
  operation="${OPERATIONS[$((RANDOM % ${#OPERATIONS[@]}))]}"
  trace_id="$(hex 16)"
  root_id="$(hex 8)"
  child_id="$(hex 8)"
  now="$(date +%s)000000000"

  # Every eleventh trace fails, so the error tile and the Error filter have
  # something to show without drowning the healthy case.
  if (( tick % 11 == 0 )); then status=2; severity=17; severity_text="ERROR"; else status=1; severity=9; severity_text="INFO"; fi

  root_ms=$(( (RANDOM % 400) + 20 ))
  child_ms=$(( (RANDOM % root_ms) + 1 ))

  curl -s -o /dev/null -X POST "$ENDPOINT/v1/traces" -H 'Content-Type: application/json' -d "{
    \"resourceSpans\": [{
      \"resource\": {\"attributes\": [
        {\"key\": \"service.name\", \"value\": {\"stringValue\": \"$service\"}},
        {\"key\": \"deployment.environment\", \"value\": {\"stringValue\": \"dev\"}}
      ]},
      \"scopeSpans\": [{
        \"scope\": {\"name\": \"generator\"},
        \"spans\": [
          {\"traceId\": \"$trace_id\", \"spanId\": \"$root_id\", \"name\": \"${operation//_/ }\",
           \"kind\": 2, \"startTimeUnixNano\": \"$now\",
           \"endTimeUnixNano\": \"$((now + root_ms * 1000000))\",
           \"attributes\": [{\"key\": \"http.route\", \"value\": {\"stringValue\": \"${operation#*_}\"}}],
           \"status\": {\"code\": $status}},
          {\"traceId\": \"$trace_id\", \"spanId\": \"$child_id\", \"parentSpanId\": \"$root_id\",
           \"name\": \"db.query\", \"kind\": 3, \"startTimeUnixNano\": \"$((now + 1000000))\",
           \"endTimeUnixNano\": \"$((now + child_ms * 1000000))\",
           \"attributes\": [{\"key\": \"db.system\", \"value\": {\"stringValue\": \"postgresql\"}}],
           \"status\": {\"code\": 1}}
        ]
      }]
    }]
  }"

  curl -s -o /dev/null -X POST "$ENDPOINT/v1/logs" -H 'Content-Type: application/json' -d "{
    \"resourceLogs\": [{
      \"resource\": {\"attributes\": [
        {\"key\": \"service.name\", \"value\": {\"stringValue\": \"$service\"}},
        {\"key\": \"deployment.environment\", \"value\": {\"stringValue\": \"dev\"}}
      ]},
      \"scopeLogs\": [{
        \"logRecords\": [{
          \"timeUnixNano\": \"$now\", \"observedTimeUnixNano\": \"$now\",
          \"severityNumber\": $severity, \"severityText\": \"$severity_text\",
          \"body\": {\"stringValue\": \"${operation//_/ } completed in ${root_ms}ms\"},
          \"traceId\": \"$trace_id\", \"spanId\": \"$root_id\"
        }]
      }]
    }]
  }"

  sleep "$INTERVAL"
done
