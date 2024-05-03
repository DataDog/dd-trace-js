#!/bin/bash

#We build the npm package setting the snapshot version and then we use it to build the deb and rpm packages

yarn install
content=`cat ./package.json | tr '\n' ' '`
current_version=$(jq '.version' <<< "$content" )
current_version=$(echo "$current_version" | tr -d '"')
current_version+="$CI_VERSION_SUFFIX"
npm version --no-git-tag-version $current_version
npm pack
export JS_PACKAGE_VERSION=$current_version
cp dd-trace-$JS_PACKAGE_VERSION.tgz packaging/dd-trace-$JS_PACKAGE_VERSION.tgz
echo "Generating Version: $JS_PACKAGE_VERSION"
cd packaging
echo -n $JS_PACKAGE_VERSION > auto_inject-node.version

source common_build_functions.sh

# Extract package to a dir to make changes
fpm --input-type npm \
  --npm-package-name-prefix "" \
  --output-type dir --prefix "" \
  --verbose \
  --name dd-trace ./dd-trace-$JS_PACKAGE_VERSION.tgz

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

