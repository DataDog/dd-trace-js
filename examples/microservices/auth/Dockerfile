FROM node:8-alpine

RUN apk add --no-cache tini git

ENV NODE_ENV=production

WORKDIR /usr/src/app

COPY package.json yarn.lock /usr/src/app/
RUN yarn --pure-lockfile && yarn cache clean

COPY src /usr/src/app/src/
COPY server.js /usr/src/app/

EXPOSE 8080
USER node

ENTRYPOINT ["/sbin/tini", "--"]
CMD [ "node", "server" ]
