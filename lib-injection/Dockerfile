FROM node:16-alpine AS build

ARG npm_pkg
ARG UID=10000

RUN addgroup -g 10000 -S datadog \
    && adduser -u ${UID} -S datadog -G datadog

WORKDIR /operator-build
COPY . .

RUN chmod 755 npm_dd_trace.sh
RUN ./npm_dd_trace.sh

USER ${UID}

ADD copy-lib.sh /operator-build/copy-lib.sh
