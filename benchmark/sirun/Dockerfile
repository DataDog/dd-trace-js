FROM --platform=linux/amd64 debian:buster-slim

RUN apt-get update && apt-get install --no-install-recommends -y \
	wget ca-certificates valgrind \
	    git hwinfo jq procps awscli \
		procps python3 python3-pip python3-venv python3-dev

RUN pip3 install setuptools
RUN pip3 install awscli
RUN pip3 install poetry
RUN pip3 install virtualenv
RUN pip3 install ez_setup

# nvm works much better with bash than sh
SHELL ["/bin/bash", "--login", "-c"]

WORKDIR /app

ENV NVM_DIR /usr/local/nvm

RUN wget -O sirun.tar.gz https://github.com/DataDog/sirun/releases/download/v0.1.9/sirun-v0.1.9-x86_64-unknown-linux-gnu.tar.gz \
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

# TODO: Need to clone baseline branch and candidate branch
COPY . /app

# using Node.js v18 for the global yarn package
RUN npm install --global yarn \
	&& yarn install --ignore-engines \
	&& PLUGINS="bluebird|q|graphql" yarn services
