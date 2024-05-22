#!/bin/bash

set -e

# Safety checks to make sure we have required values
if [ -z "$CI_COMMIT_TAG" ]; then
  echo "Error: CI_COMMIT_TAG was not provided"
  exit 1
fi

if [ -z "$CI_COMMIT_SHA" ]; then
  echo "Error: CI_COMMIT_SHA was not provided"
  exit 1
fi

if [ -z "$IMG_DESTINATION_BASE" ]; then
  echo "Error: IMG_DESTINATION_BASE. This should be set to the destination docker image, excluding the tag name, e.g. dd-lib-dotnet-init"
  exit 1
fi

# If this is a pre-release release, we don't publish
if echo "$CI_COMMIT_TAG" | grep -q "-" > /dev/null; then
  echo "Error: This is a pre-release version, should not publish images: $CI_COMMIT_TAG"
  exit 1
fi

# Calculate the tags we use for floating major and minor versions
MAJOR_MINOR_VERSION="$(sed -nE 's/^(v[0-9]+\.[0-9]+)\.[0-9]+$/\1/p' <<< ${CI_COMMIT_TAG})"
MAJOR_VERSION="$(sed -nE 's/^(v[0-9]+)\.[0-9]+\.[0-9]+$/\1/p' <<< ${CI_COMMIT_TAG})"

# Make sure we have all the tags
git fetch --tags

# We need to determine whether this is is the latest tag and whether it's the latest major or not
# So we fetch all tags and sort them to find both the latest, and the latest in this major.
# 'sort' technically gets prerelease versions in the wrong order here, but we explicitly
# exclude them anyway, as they're ignored for the purposes of determining the 'latest' tags.
LATEST_TAG="$(git tag | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V -r | head -n 1)"
LATEST_MAJOR_TAG="$(git tag -l "$MAJOR_VERSION.*" | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V -r | head -n 1)"
echo "This tag: $CI_COMMIT_TAG"
echo "Latest repository tag: $LATEST_TAG"
echo "Latest repository tag for this major: $LATEST_MAJOR_TAG"
echo "---------"

# GNU sort -C (silent) reports via exit code whether the data is already in sorted order
# We use this to check whether the current tag is greater than (or equal to) the latest tag 
if printf '%s\n' "$LATEST_TAG" "$CI_COMMIT_TAG" | sort -C -V; then
  # The current tag is the latest in the repository
  IS_LATEST_TAG=1
else
  IS_LATEST_TAG=0
fi

if printf '%s\n' "$LATEST_MAJOR_TAG" "$CI_COMMIT_TAG" | sort -C -V; then
  # The current tag is the latest for this major version in the repository
  IS_LATEST_MAJOR_TAG=1
else
  IS_LATEST_MAJOR_TAG=0
fi

# print everything for debugging purposes
echo "Calculated values:"
echo "MAJOR_MINOR_VERSION=${MAJOR_MINOR_VERSION}"
echo "MAJOR_VERSION=${MAJOR_VERSION}"
echo "IS_LATEST_TAG=${IS_LATEST_TAG}"
echo "IS_LATEST_MAJOR_TAG=${IS_LATEST_MAJOR_TAG}"
echo "---------"

# Final check that everything is ok
# We should have a major_minor version
if [ -z "$MAJOR_MINOR_VERSION" ]; then
  echo "Error: Could not determine major_minor version for stable release, this should not happen"
  exit 1
fi

# if this is a latest major tag, we should have a major version
if [ "$IS_LATEST_MAJOR_TAG" -eq 1 ] && [ -z "$MAJOR_VERSION" ]; then
  echo "Error: Could not determine major version for latest major release, this should not happen"
  exit 1
fi

# Generate the final variables, and save them into build.env so they can be read by the trigger job  
set_image_tags() {
  SUFFIX="$1"
  VARIABLE_SUFFIX="${SUFFIX:+_$SUFFIX}" # add a '_' prefix
  TAG_SUFFIX="${SUFFIX:+-$SUFFIX}" # add a '-' prefix
  
  # We always add this tag, regardless of the version 
  DESTINATIONS="${IMG_DESTINATION_BASE}:${CI_COMMIT_TAG}${TAG_SUFFIX}"
  
  # We always add the major_minor tag (we never release 2.5.2 _after_ 2.5.3, for example)
  DESTINATIONS="${DESTINATIONS},${IMG_DESTINATION_BASE}:${MAJOR_MINOR_VERSION}${TAG_SUFFIX}"
    
  # Only latest-major releases get the major tag
  if [ "$IS_LATEST_MAJOR_TAG" -eq 1 ]; then
    DESTINATIONS="${DESTINATIONS},${IMG_DESTINATION_BASE}:${MAJOR_VERSION}${TAG_SUFFIX}"
  fi
  
  # Only latest releases get the latest tag
  if [ "$IS_LATEST_TAG" -eq 1 ]; then
    DESTINATIONS="${DESTINATIONS},${IMG_DESTINATION_BASE}:latest${TAG_SUFFIX}"
  fi
  
  # Save the value to the build.env file
  echo "IMG_DESTINATIONS${VARIABLE_SUFFIX}=${DESTINATIONS}"
  echo "IMG_DESTINATIONS${VARIABLE_SUFFIX}=${DESTINATIONS}" >> build.env
}

# Calculate the non-suffixed tags
set_image_tags

# For each suffix, calculate the tags 
for ADDITIONAL_TAG_SUFFIX in ${ADDITIONAL_TAG_SUFFIXES//,/ }
do
    set_image_tags "$ADDITIONAL_TAG_SUFFIX"
done