# Self-contained dd-trace-js microbenchmarks image. Built for linux/amd64 only:
# sirun publishes no arm64 binary and CPython is pinned to the x86_64 build, so the
# build-benchmark-ci-images job pins BASE_CI_IMAGE_PLATFORM=linux/amd64 (see
# .gitlab/benchmarks/gitlab-ci.yml). Pinned to the 24.04 manifest-list digest.
FROM ubuntu:24.04@sha256:786a8b558f7be160c6c8c4a54f9a57274f3b4fb1491cf65146521ae77ff1dc54

ARG CI_JOB_TOKEN

ENV DEBIAN_FRONTEND=noninteractive
ENV NVM_DIR=/usr/local/nvm
ENV PATH="/opt/python/bin:/app:/app/bp-runner/:/app/benchmark-github-tools/:/app/benchmark-analyzer/:$PATH"

# nvm works much better with bash than sh
SHELL ["/bin/bash", "--login", "-c"]

WORKDIR /app

# Base OS packages, CPython, awscli, poetry, and the bp-install bootstrap.
COPY ./install-base-deps.sh ./install-base-deps.sh
RUN --mount=type=ssh ./install-base-deps.sh

# Node.js and sirun versions are pinned in dd-trace-js (single source of truth):
# node-<major> in the plugin versions manifest, and benchmark/sirun/.sirun-version.
# The image bakes master's pins as a warm cache; runall.sh reinstalls the per-PR pin
# at runtime when it differs, so a bump is effective before the next image rebuild.
# A pin a branch only introduces is absent from master until it lands, so a 404 must
# not fail the build: the bake steps below skip when a file is missing and runall.sh
# installs the per-PR pin at runtime regardless.
RUN raw=https://raw.githubusercontent.com/DataDog/dd-trace-js/master; \
	curl -fsSL "$raw/benchmark/sirun/.sirun-version" -o /tmp/.sirun-version || true; \
	curl -fsSL "$raw/packages/dd-trace/test/plugins/versions/package.json" -o /tmp/versions.json || true

RUN if [ -s /tmp/.sirun-version ]; then \
		read -r SIRUN_VERSION SIRUN_SHA256 < /tmp/.sirun-version \
		&& wget -O sirun.tar.gz "https://github.com/DataDog/sirun/releases/download/v${SIRUN_VERSION}/sirun-v${SIRUN_VERSION}-x86_64-unknown-linux-musl.tar.gz" \
		&& echo "${SIRUN_SHA256}  sirun.tar.gz" | sha256sum -c - \
		&& tar -xzf sirun.tar.gz \
		&& rm sirun.tar.gz \
		&& mv sirun /usr/bin/sirun \
		&& printf '%s' "$SIRUN_VERSION" > /opt/baked-sirun-version; \
	fi

# Node.js majors the benchmark matrix runs (skip 18/22); exact patch from the manifest.
RUN mkdir -p /usr/local/nvm \
	&& wget -q -O /tmp/nvm-install.sh https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.4/install.sh \
	&& echo "4b7412c49960c7d31e8df72da90c1fb5b8cccb419ac99537b737028d497aba4f  /tmp/nvm-install.sh" | sha256sum -c - \
	&& bash /tmp/nvm-install.sh \
	&& rm /tmp/nvm-install.sh \
	&& . $NVM_DIR/nvm.sh \
	&& if [ -s /tmp/versions.json ]; then \
		for major in 20 24 26; do \
			version=$(sed -n "s/.*\"node-${major}\": *\"npm:node@\([0-9.]*\)\".*/\1/p" /tmp/versions.json); \
			[ -n "$version" ] || { echo "No node-${major} pin in versions manifest" >&2; exit 1; }; \
			nvm install --no-progress "$version"; \
		done \
		&& nvm alias default 24 \
		&& nvm use 24; \
	fi

RUN mkdir /opt/insecure-bank-js
RUN git clone --depth 1 https://github.com/hdiv/insecure-bank-js.git /opt/insecure-bank-js

WORKDIR /opt/insecure-bank-js
RUN git checkout 5755d091e6a5dc965a8e7c6d4fb79b2f0ea06d9a
RUN . $NVM_DIR/nvm.sh \
    && npm ci \
    && npm cache clean --force

WORKDIR /app

# Benchmarking Platform tooling (bp-runner, analyzer, github-tools).
RUN --mount=type=ssh bp-install bp-runner benchmark-analyzer github-tools
