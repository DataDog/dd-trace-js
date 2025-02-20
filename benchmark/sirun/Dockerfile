# The version of this file in master is used across all PRs regardless of upstream branch
FROM --platform=linux/amd64 ubuntu:22.04

RUN apt-get update && apt-get install --no-install-recommends -y \
	wget curl ca-certificates valgrind \
	git hwinfo jq procps \
	software-properties-common build-essential libnss3-dev zlib1g-dev libgdbm-dev libncurses5-dev libssl-dev libffi-dev libreadline-dev libsqlite3-dev libbz2-dev

RUN git clone --depth 1 https://github.com/pyenv/pyenv.git --branch "v2.4.1" --single-branch /pyenv
ENV PYENV_ROOT "/pyenv"
ENV PATH "/pyenv/shims:/pyenv/bin:$PATH"
RUN eval "$(pyenv init -)"
RUN pyenv install 3.9.6 && pyenv global 3.9.6
RUN pip3 install awscli virtualenv setuptools
RUN curl -sSL https://install.python-poetry.org | POETRY_HOME=/etc/poetry python3 -

# nvm works much better with bash than sh
SHELL ["/bin/bash", "--login", "-c"]

WORKDIR /app

ENV NVM_DIR /usr/local/nvm

RUN wget -O sirun.tar.gz https://github.com/DataDog/sirun/releases/download/v0.1.10/sirun-v0.1.10-x86_64-unknown-linux-musl.tar.gz \
	&& tar -xzf sirun.tar.gz \
	&& rm sirun.tar.gz \
	&& mv sirun /usr/bin/sirun

# This list of installed Node.js versions should include all versions used by any active release line
RUN mkdir -p /usr/local/nvm \
	&& wget -q -O - https://raw.githubusercontent.com/nvm-sh/nvm/v0.35.3/install.sh | bash \
	&& . $NVM_DIR/nvm.sh \
	&& nvm install --no-progress 18.16.1 \
	&& nvm install --no-progress 20.4.0 \
	&& nvm install --no-progress 22.10.0 \
	&& nvm alias default 22 \
	&& nvm use 22

RUN mkdir /opt/insecure-bank-js
RUN git clone --depth 1 https://github.com/hdiv/insecure-bank-js.git /opt/insecure-bank-js

WORKDIR /opt/insecure-bank-js
RUN git checkout 2003d9085a6e9a679e31fd88719e4de030d6855f
RUN . $NVM_DIR/nvm.sh \
    && npm ci \
    && npm cache clean --force

WORKDIR /app
