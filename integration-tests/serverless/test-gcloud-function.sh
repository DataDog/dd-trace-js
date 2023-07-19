#!/bin/bash

set -e

DD_TRACE_JS_ROOT_DIR_PATH="${SERVERLESS_INTEGRATION_DIR_PATH}/../../"

yarn --cwd ${DD_TRACE_JS_ROOT_DIR_PATH} pack --filename "${SERVERLESS_INTEGRATION_DIR_PATH}/test-project/dd-trace-integration-test.tgz"

ls "${SERVERLESS_INTEGRATION_DIR_PATH}/test-project/"

STAGE=$(xxd -l 4 -c 4 -p </dev/random)

function cleanup {
    gcloud functions delete dd-trace-js-sls-mini-agent-integration-test-${STAGE} --region us-east1 --gen2 --quiet 
}
trap cleanup EXIT

echo "Deploying integration test cloud function"

gcloud functions deploy dd-trace-js-sls-mini-agent-integration-test-${STAGE} \
    --gen2 \
    --runtime=nodejs18 \
    --region=us-east1 \
    --source "${SERVERLESS_INTEGRATION_DIR_PATH}/test-project/" \
    --entry-point=helloGET \
    --trigger-http \
    --allow-unauthenticated \
    --env-vars-file "${SERVERLESS_INTEGRATION_DIR_PATH}/test-project/.env.yaml"

echo "Calling deployed cloud function"

for i in {0..2};
do
    curl -s "https://us-east1-datadog-sandbox.cloudfunctions.net/dd-trace-js-sls-mini-agent-integration-test-${STAGE}"
done

echo "Waiting 90 seconds before tailing logs"
sleep 90

LOGS=$(gcloud functions logs read dd-trace-js-sls-mini-agent-integration-test-${STAGE} --region us-east1 --gen2 --limit 1000)

echo "$LOGS"

if echo "$LOGS" | grep -q "Successfully buffered traces to be flushed"; then
    echo "Mini Agent received traces"
    exit 0
else
    echo "Mini Agent DID NOT receive traces"
    exit 1
fi
