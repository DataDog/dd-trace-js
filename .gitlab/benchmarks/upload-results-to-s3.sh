#!/usr/bin/env bash

# EXTERNAL_S3_URL: optional override for the upload destination prefix.
# When unset, results go to the default relenv-benchmarking-data path.
# When set, must start with 's3://relenv-benchmarking-data/' to prevent
# exfiltration to an arbitrary bucket.
#
# After upload, a '_READY' marker object is written to the destination prefix
# to signal to downstream pollers that the upload for this sample is complete.

DEFAULT_S3_URL="s3://relenv-benchmarking-data/dd-trace-js/${CI_COMMIT_SHA}/node-${MAJOR_VERSION}/"

if [ -n "${EXTERNAL_S3_URL}" ]; then
  if [[ "${EXTERNAL_S3_URL}" != s3://relenv-benchmarking-data/* ]]; then
    echo "ERROR: EXTERNAL_S3_URL must start with 's3://relenv-benchmarking-data/'" >&2
    exit 1
  fi
  DESTINATION="${EXTERNAL_S3_URL}"
else
  DESTINATION="${DEFAULT_S3_URL}"
fi

aws s3 cp --recursive --acl bucket-owner-full-control "$ARTIFACTS_DIR/" "${DESTINATION}"

aws s3 cp --acl bucket-owner-full-control /dev/null "${DESTINATION}_READY"
