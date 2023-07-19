#!/bin/bash

set -e

DD_TRACE_JS_ROOT_DIR_PATH="${SERVERLESS_INTEGRATION_DIR_PATH}/../../"

yarn --cwd ${DD_TRACE_JS_ROOT_DIR_PATH} pack --filename "${SERVERLESS_INTEGRATION_DIR_PATH}/test-project/dd-trace-integration-test.tgz"

ls "${SERVERLESS_INTEGRATION_DIR_PATH}/test-project/"

STAGE=$(xxd -l 4 -c 4 -p </dev/random)

function cleanup {
    gcloud functions delete dd-trace-js-sls-mini-agent-integration-test-${STAGE} --region us-east1 --gen2 --quiet --project datadog-sandbox 
}
trap cleanup EXIT

echo "Deploying integration test cloud function"

DEPLOY_OUTPUT=$(gcloud functions deploy dd-trace-js-sls-mini-agent-integration-test-${STAGE} \
    --gen2 \
    --runtime=nodejs18 \
    --region=us-east1 \
    --project=datadog-sandbox \
    --source "${SERVERLESS_INTEGRATION_DIR_PATH}/test-project/" \
    --entry-point=helloGET \
    --trigger-http \
    --allow-unauthenticated \
    --env-vars-file "${SERVERLESS_INTEGRATION_DIR_PATH}/test-project/.env.yaml")

INVOKE_URL=$(echo "$DEPLOY_OUTPUT" | awk 'END {print $NF}')

echo "Calling deployed cloud function"

curl -s "${INVOKE_URL}"

echo "Waiting 60 seconds before tailing logs"
sleep 60

LOGS=$(gcloud functions logs read dd-trace-js-sls-mini-agent-integration-test-${STAGE} --region us-east1 --gen2 --limit 1000 --project datadog-sandbox)

echo "$LOGS"

if echo "$LOGS" | grep -q "Successfully buffered traces to be flushed"; then
    echo "Mini Agent received traces"
    exit 0
else
    echo "Mini Agent DID NOT receive traces"
    exit 1
fi
