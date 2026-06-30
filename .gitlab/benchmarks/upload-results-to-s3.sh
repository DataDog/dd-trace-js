#!/usr/bin/env bash

# EXTERNAL_S3_URL overrides the default destination prefix (must stay within
# relenv-benchmarking-data). A _READY marker is written last to signal upload
# completion for this sample.
DEST="${EXTERNAL_S3_URL:-s3://relenv-benchmarking-data/dd-trace-js/${CI_COMMIT_SHA}/node-${MAJOR_VERSION}/}"
[[ "$DEST" == s3://relenv-benchmarking-data/* ]] || { echo "EXTERNAL_S3_URL must stay within relenv-benchmarking-data" >&2; exit 1; }

aws s3 cp --recursive --acl bucket-owner-full-control "$ARTIFACTS_DIR/" "$DEST"
aws s3 cp --acl bucket-owner-full-control /dev/null "${DEST}_READY"
