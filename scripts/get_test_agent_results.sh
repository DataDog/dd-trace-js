#!/bin/bash

RESPONSE=$(curl -s -w "\n%{http_code}" -o response.txt http://127.0.0.1:9126/test/trace_check/failures?return_all=true)
RESPONSE_CODE=$(echo "$RESPONSE" | awk 'END {print $NF}')

SUMMARY_RESPONSE=$(curl -s -w "\n%{http_code}" -o summary_response.txt http://127.0.0.1:9126/test/trace_check/summary?return_all=true)
SUMMARY_RESPONSE_CODE=$(echo "$SUMMARY_RESPONSE" | awk 'END {print $NF}')

if [[ $RESPONSE_CODE -eq 200 ]]; then
  echo $"All APM Test Agent Check Traces returned successful! (HTTP 200)\n"
  cat response.txt
  echo $"APM Test Agent Check Traces Summary Results:\n"
  cat summary_response.txt | jq '.'
else
  echo "APM Test Agent Check Traces failed with response code: $RESPONSE_CODE"
  echo $"APM Test Agent Check Traces Summary Results:\n"
  cat summary_response.txt | jq '.'
  echo $"Failures:\n"
  cat response.txt
  exit 1
fi