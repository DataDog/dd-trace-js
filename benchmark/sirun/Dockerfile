# The version of this file in master is used across all PRs regardless of upstream branch
# Pinned to the 24.04 manifest-list digest; --platform still selects the linux/amd64 variant.
FROM --platform=linux/amd64 ubuntu:24.04@sha256:786a8b558f7be160c6c8c4a54f9a57274f3b4fb1491cf65146521ae77ff1dc54

RUN apt-get update && apt-get install --no-install-recommends -y \
	wget curl ca-certificates valgrind \
	git hwinfo jq procps \
	software-properties-common build-essential libnss3-dev

# Prebuilt, relocatable CPython from python-build-standalone (the same builds uv ships).
# Avoids a slow from-source pyenv compile and stays version-pinned + checksum-verified.
RUN wget -O /tmp/python.tar.gz https://github.com/astral-sh/python-build-standalone/releases/download/20260602/cpython-3.14.5+20260602-x86_64-unknown-linux-gnu-install_only.tar.gz \
	&& echo "962cc1605e3f82410e5a2dfa3070265693681c56fc1aa1f30967723605c5d38f  /tmp/python.tar.gz" | sha256sum -c - \
	&& tar -xzf /tmp/python.tar.gz -C /opt \
	&& rm /tmp/python.tar.gz
ENV PATH "/opt/python/bin:$PATH"
RUN pip3 install awscli==1.45.21 virtualenv==21.4.2 setuptools==82.0.1
RUN curl -sSL https://install.python-poetry.org | POETRY_HOME=/etc/poetry python3 - --version 2.4.1

# nvm works much better with bash than sh
SHELL ["/bin/bash", "--login", "-c"]

WORKDIR /app

ENV NVM_DIR /usr/local/nvm

RUN wget -O sirun.tar.gz https://github.com/DataDog/sirun/releases/download/v0.1.11/sirun-v0.1.11-x86_64-unknown-linux-musl.tar.gz \
	&& echo "5f779a5b974dc758b92a7595136e9dbe2bebeaa74daa9d6d9fe0e61961638358  sirun.tar.gz" | sha256sum -c - \
	&& tar -xzf sirun.tar.gz \
	&& rm sirun.tar.gz \
	&& mv sirun /usr/bin/sirun

# This list of installed Node.js versions should include all versions used by our sirun benchmarks
RUN mkdir -p /usr/local/nvm \
	&& wget -q -O /tmp/nvm-install.sh https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.4/install.sh \
	&& echo "4b7412c49960c7d31e8df72da90c1fb5b8cccb419ac99537b737028d497aba4f  /tmp/nvm-install.sh" | sha256sum -c - \
	&& bash /tmp/nvm-install.sh \
	&& rm /tmp/nvm-install.sh \
	&& . $NVM_DIR/nvm.sh \
	&& nvm install --no-progress 20.20.2 \
	&& nvm install --no-progress 24.15.0 \
	&& nvm install --no-progress 26.1.0 \
	&& nvm alias default 24 \
	&& nvm use 24

RUN mkdir /opt/insecure-bank-js
RUN git clone --depth 1 https://github.com/hdiv/insecure-bank-js.git /opt/insecure-bank-js

WORKDIR /opt/insecure-bank-js
RUN git checkout 5755d091e6a5dc965a8e7c6d4fb79b2f0ea06d9a
RUN . $NVM_DIR/nvm.sh \
    && npm ci \
    && npm cache clean --force

WORKDIR /app
