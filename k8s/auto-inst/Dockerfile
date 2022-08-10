FROM node:16 AS build

ARG npm_pkg

WORKDIR /operator-build
COPY . .

RUN npm install ${npm_pkg}

ADD copy-lib.sh /operator-build/copy-lib.sh
