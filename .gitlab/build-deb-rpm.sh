#!/bin/bash

if [ -n "$CI_COMMIT_TAG" ] && [ -z "$JS_PACKAGE_VERSION" ]; then
  JS_PACKAGE_VERSION=${CI_COMMIT_TAG##v}
fi

echo -n $JS_PACKAGE_VERSION > auto_inject-node.version

source common_build_functions.sh

# Extract package to a dir to make changes
fpm --input-type npm \
  --npm-package-name-prefix "" \
  --npm-registry http://localhost:4873
  --output-type dir --prefix "" \
  --version "$JS_PACKAGE_VERSION" \
  --verbose \
  --name dd-trace dd-trace

cp auto_inject-node.version dd-trace.dir/lib/version

# Build packages
fpm_wrapper "datadog-apm-library-js" "$JS_PACKAGE_VERSION" \
  --input-type dir \
  --url "https://github.com/DataDog/dd-trace-js" \
  --description "Datadog APM client library for Javascript" \
  --license "BSD-3-Clause" \
  --chdir=dd-trace.dir/lib \
  --prefix "$LIBRARIES_INSTALL_BASE/nodejs" \
  .=.
