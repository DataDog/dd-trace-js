FROM --platform=linux/amd64 debian:buster-slim

RUN apt-get update && apt-get install --no-install-recommends -y \
	wget ca-certificates valgrind nano

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
	&& nvm install --no-progress 14 \
	&& nvm install --no-progress 16 \
	&& nvm install --no-progress 18 \
	&& nvm alias default 18 \
	&& nvm use 18

COPY . /app

# using the Node.js v18 for the global yarn package
RUN npm install --global yarn \
	&& yarn install --ignore-engines \
	&& PLUGINS="bluebird|q" yarn services
