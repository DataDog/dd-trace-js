FROM node:16 AS build

ARG npm_pkg

WORKDIR /operator-build
COPY . .

RUN npm install ${npm_pkg}

ADD copy-dd-trace.sh /operator-build/copy-dd-trace.sh
