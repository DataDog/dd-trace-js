FROM node:16-alpine AS build

ARG npm_pkg
ARG UID=10000

RUN addgroup -g 10000 -S datadog \
    && adduser -u ${UID} -S datadog -G datadog

WORKDIR /operator-build
COPY . .

RUN npm install ./dd-trace.tgz

USER ${UID}

ADD copy-lib.sh /operator-build/copy-lib.sh
