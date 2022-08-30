FROM node:16 AS build

ARG npm_pkg

WORKDIR /operator-build
COPY . .

RUN npm install ./dd-trace.tgz

ADD copy-lib.sh /operator-build/copy-lib.sh
