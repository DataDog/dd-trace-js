#!/usr/bin/env bash

# BP_EXTERNAL_S3_URL overrides the default destination prefix (must stay within
# relenv-benchmarking-data) so an external orchestrator can collect results
# under a prefix it controls.
DEST="${BP_EXTERNAL_S3_URL:-s3://relenv-benchmarking-data/dd-trace-js/${CI_COMMIT_SHA}/node-${MAJOR_VERSION}/}"
[[ "$DEST" == s3://relenv-benchmarking-data/* ]] || { echo "BP_EXTERNAL_S3_URL must stay within relenv-benchmarking-data" >&2; exit 1; }

aws s3 cp --recursive --acl bucket-owner-full-control "$ARTIFACTS_DIR/" "$DEST"
