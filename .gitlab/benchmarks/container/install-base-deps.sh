#!/usr/bin/env bash

set -ex

apt-get update && apt-get install --no-install-recommends -y \
	wget curl ca-certificates valgrind \
	git openssh-client hwinfo jq procps \
	software-properties-common build-essential libnss3-dev

# Prebuilt, relocatable CPython from python-build-standalone (the same builds uv ships).
# Avoids a slow from-source pyenv compile and stays version-pinned + checksum-verified.
# Pinned to 3.9.x: the Benchmarking Platform tooling (bp-runner, benchmark-analyzer,
# github-tools) targets Python 3.9 across the fleet; 3.9.23 is the final 3.9 release
# and the last one python-build-standalone publishes. x86_64 only; this image is
# built for linux/amd64 (sirun ships no arm64 binary).
wget -O /tmp/python.tar.gz https://github.com/astral-sh/python-build-standalone/releases/download/20250902/cpython-3.9.23+20250902-x86_64-unknown-linux-gnu-install_only.tar.gz
echo "9038680028e006d13ea1ff68fdcab0a5494d2026cdd2dbdfb067c5b80b6272f1  /tmp/python.tar.gz" | sha256sum -c -
tar -xzf /tmp/python.tar.gz -C /opt
rm /tmp/python.tar.gz

pip3 install awscli==1.45.21 virtualenv==21.4.2 setuptools==82.0.1
curl -sSL https://install.python-poetry.org | POETRY_HOME=/etc/poetry python3 - --version 2.4.1

# Bootstrap bp-install so the Dockerfile can install the Benchmarking Platform
# packages (bp-runner, benchmark-analyzer, github-tools) the same way the rest of
# the fleet does. Mirrors dd-trace-go's container/install-base-deps.sh.
if [ ! -d "/tmp/benchmarking-platform-tools" ]; then
  if [ -n "$CI_JOB_TOKEN" ]; then
    git clone https://gitlab-ci-token:${CI_JOB_TOKEN}@gitlab.ddbuild.io/DataDog/benchmarking-platform-tools /tmp/benchmarking-platform-tools
  else
    mkdir -p ~/.ssh && ssh-keyscan -t rsa github.com >> ~/.ssh/known_hosts
    git clone git@github.com:DataDog/benchmarking-platform-tools /tmp/benchmarking-platform-tools
  fi
fi

mkdir -p /app
cp -r /tmp/benchmarking-platform-tools/images/templates/linux/bp-install /app/bp-install
