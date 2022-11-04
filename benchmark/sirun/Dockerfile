FROM --platform=linux/amd64 debian:buster-slim

RUN apt-get update && apt-get install --no-install-recommends -y \
	wget curl ca-certificates valgrind \
	    git hwinfo jq procps \
      software-properties-common build-essential libnss3-dev zlib1g-dev libgdbm-dev libncurses5-dev libssl-dev libffi-dev libreadline-dev libsqlite3-dev libbz2-dev

RUN git clone --depth 1 https://github.com/pyenv/pyenv.git --branch "v2.0.4" --single-branch /pyenv
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

RUN wget -O sirun.tar.gz https://github.com/DataDog/sirun/releases/download/v0.1.10/sirun-v0.1.10-x86_64-unknown-linux-gnu.tar.gz \
	&& tar -xzf sirun.tar.gz \
	&& rm sirun.tar.gz \
	&& mv sirun /usr/bin/sirun

RUN mkdir -p /usr/local/nvm \
	&& wget -q -O - https://raw.githubusercontent.com/nvm-sh/nvm/v0.35.3/install.sh | bash \
	&& . $NVM_DIR/nvm.sh \
	&& nvm install --no-progress 14.20.1 \
	&& nvm install --no-progress 16.17.1 \
	&& nvm install --no-progress 18.10.0 \
	&& nvm alias default 18 \
	&& nvm use 18
