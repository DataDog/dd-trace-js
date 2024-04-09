#!/bin/bash
set -e

echo CI=$1
echo MONOTONIC_ID=$2
echo GIT_REF=$3
echo GIT_COMMIT_SHA=$4

#Get last tag version/ last release number
git fetch --depth=500
LAST_TAG_VERSION=$(git tag --sort=taggerdate | grep -E '[0-9]'  | tail -1 | cut -c 2-)

git_branch="${3#refs/heads/}"
echo git_branch="${git_branch}"
git_branch_hash=$(echo -n "$git_branch" | sha256sum| cut -c1-6)
echo git_branch_hash="${git_branch_hash}"

#git_short_sha=${4:0:8}
git_short_sha=$(echo -n "$4" | sha256sum| cut -c1-6)
echo git_short_sha=$git_short_sha

PRE=dev
echo PRE="${PRE}"

# Set component values:
# - PRE is `dev` to denote being a development version and
#   act as a categorizer.
# - BUILD starts with git branch sha for grouping, prefixed by `b`.
# - BUILD has CI run id for traceability, prefixed by `gha` or `glci`
#   for identification.
# - BUILD has commit next for traceability, prefixed git-describe
#   style by `g` for identification.
BUILD="b${git_branch_hash}.${1}${2}.g${git_short_sha}"
echo BUILD="${BUILD}"
#export JS_PACKAGE_VERSION=${LAST_TAG_VERSION}.$PRE.${BUILD}
export JS_PACKAGE_VERSION="2.21.0.9999"

echo "JS_PACKAGE_VERSION has value: ${JS_PACKAGE_VERSION}" 
echo "JS_PACKAGE_VERSION=$JS_PACKAGE_VERSION" >> package_version.env
