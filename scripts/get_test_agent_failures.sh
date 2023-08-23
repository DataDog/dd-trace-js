#!/bin/bash

RESPONSE=$(curl -s -w "\n%{http_code}" -o response.txt http://127.0.0.1:9126/test/trace_check/failures)
RESPONSE_CODE=$(echo "$RESPONSE" | awk 'END {print $NF}')

if [[ $RESPONSE_CODE -eq 200 ]]; then
  echo "All APM Test Agent Check Traces returned successful! (HTTP 200)"
  cat response.txt
else
  echo "APM Test Agent Check Traces failed with response code: $RESPONSE_CODE"
  echo "Failures:"
  cat response.txt
  exit 1
fi