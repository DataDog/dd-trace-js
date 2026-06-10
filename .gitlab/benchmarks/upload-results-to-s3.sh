#!/usr/bin/env bash

aws s3 cp --recursive --acl bucket-owner-full-control $ARTIFACTS_DIR/ s3://relenv-benchmarking-data/dd-trace-js/${CI_COMMIT_SHA}/node-${MAJOR_VERSION}/
