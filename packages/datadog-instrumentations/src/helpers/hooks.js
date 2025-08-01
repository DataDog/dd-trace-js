'use strict'

module.exports = {
  '@apollo/server': () => require('../apollo-server'),
  '@apollo/gateway': () => require('../apollo'),
  'apollo-server-core': () => require('../apollo-server-core'),
  '@aws-sdk/smithy-client': () => require('../aws-sdk'),
  '@azure/functions': () => require('../azure-functions'),
  '@azure/service-bus': () => require('../azure-service-bus'),
  '@cucumber/cucumber': () => require('../cucumber'),
  '@playwright/test': () => require('../playwright'),
  '@elastic/elasticsearch': () => require('../elasticsearch'),
  '@elastic/transport': () => require('../elasticsearch'),
  '@google-cloud/pubsub': () => require('../google-cloud-pubsub'),
  '@google-cloud/vertexai': () => require('../google-cloud-vertexai'),
  '@graphql-tools/executor': () => require('../graphql'),
  '@grpc/grpc-js': () => require('../grpc'),
  '@hapi/hapi': () => require('../hapi'),
  '@jest/core': () => require('../jest'),
  '@jest/reporters': () => require('../jest'),
  '@jest/test-sequencer': () => require('../jest'),
  '@jest/transform': () => require('../jest'),
  '@koa/router': () => require('../koa'),
  '@langchain/core': { esmFirst: true, fn: () => require('../langchain') },
  '@node-redis/client': () => require('../redis'),
  '@opensearch-project/opensearch': () => require('../opensearch'),
  '@opentelemetry/sdk-trace-node': () => require('../otel-sdk-trace'),
  '@prisma/client': () => require('../prisma'),
  '@redis/client': () => require('../redis'),
  '@smithy/smithy-client': () => require('../aws-sdk'),
  '@vitest/runner': { esmFirst: true, fn: () => require('../vitest') },
  aerospike: () => require('../aerospike'),
  amqp10: () => require('../amqp10'),
  amqplib: () => require('../amqplib'),
  avsc: () => require('../avsc'),
  'aws-sdk': () => require('../aws-sdk'),
  bluebird: () => require('../bluebird'),
  'body-parser': () => require('../body-parser'),
  bunyan: () => require('../bunyan'),
  'cassandra-driver': () => require('../cassandra-driver'),
  child_process: () => require('../child_process'),
  connect: () => require('../connect'),
  cookie: () => require('../cookie'),
  'cookie-parser': () => require('../cookie-parser'),
  couchbase: () => require('../couchbase'),
  crypto: () => require('../crypto'),
  cypress: () => require('../cypress'),
  'dd-trace-api': () => require('../dd-trace-api'),
  dns: () => require('../dns'),
  elasticsearch: () => require('../elasticsearch'),
  express: () => require('../express'),
  'express-mongo-sanitize': () => require('../express-mongo-sanitize'),
  'express-session': () => require('../express-session'),
  fastify: () => require('../fastify'),
  'find-my-way': () => require('../find-my-way'),
  fs: { serverless: false, fn: () => require('../fs') },
  'generic-pool': () => require('../generic-pool'),
  graphql: () => require('../graphql'),
  grpc: () => require('../grpc'),
  handlebars: () => require('../handlebars'),
  hapi: () => require('../hapi'),
  hono: { esmFirst: true, fn: () => require('../hono') },
  http: () => require('../http'),
  http2: () => require('../http2'),
  https: () => require('../http'),
  ioredis: () => require('../ioredis'),
  iovalkey: () => require('../iovalkey'),
  'jest-circus': () => require('../jest'),
  'jest-config': () => require('../jest'),
  'jest-environment-node': () => require('../jest'),
  'jest-environment-jsdom': () => require('../jest'),
  'jest-runtime': () => require('../jest'),
  'jest-worker': () => require('../jest'),
  knex: () => require('../knex'),
  koa: () => require('../koa'),
  'koa-router': () => require('../koa'),
  '@confluentinc/kafka-javascript': () => require('../confluentinc-kafka-javascript'),
  kafkajs: () => require('../kafkajs'),
  langchain: () => require('../langchain'),
  ldapjs: () => require('../ldapjs'),
  'limitd-client': () => require('../limitd-client'),
  lodash: () => require('../lodash'),
  mariadb: () => require('../mariadb'),
  memcached: () => require('../memcached'),
  'microgateway-core': () => require('../microgateway-core'),
  mocha: () => require('../mocha'),
  'mocha-each': () => require('../mocha'),
  moleculer: () => require('../moleculer'),
  mongodb: () => require('../mongodb'),
  'mongodb-core': () => require('../mongodb-core'),
  mongoose: () => require('../mongoose'),
  mquery: () => require('../mquery'),
  multer: () => require('../multer'),
  mysql: () => require('../mysql'),
  mysql2: () => require('../mysql2'),
  net: () => require('../net'),
  next: () => require('../next'),
  'node-serialize': () => require('../node-serialize'),
  'node:child_process': () => require('../child_process'),
  'node:crypto': () => require('../crypto'),
  'node:dns': () => require('../dns'),
  'node:http': () => require('../http'),
  'node:http2': () => require('../http2'),
  'node:https': () => require('../http'),
  'node:net': () => require('../net'),
  'node:url': () => require('../url'),
  'node:vm': () => require('../vm'),
  nyc: () => require('../nyc'),
  oracledb: () => require('../oracledb'),
  openai: { esmFirst: true, fn: () => require('../openai') },
  passport: () => require('../passport'),
  'passport-http': () => require('../passport-http'),
  'passport-local': () => require('../passport-local'),
  pg: () => require('../pg'),
  pino: () => require('../pino'),
  'pino-pretty': () => require('../pino'),
  playwright: () => require('../playwright'),
  'playwright-core': () => require('../playwright'),
  'promise-js': () => require('../promise-js'),
  promise: () => require('../promise'),
  protobufjs: () => require('../protobufjs'),
  pug: () => require('../pug'),
  q: () => require('../q'),
  redis: () => require('../redis'),
  restify: () => require('../restify'),
  rhea: () => require('../rhea'),
  router: () => require('../router'),
  'selenium-webdriver': () => require('../selenium'),
  sequelize: () => require('../sequelize'),
  sharedb: () => require('../sharedb'),
  tedious: () => require('../tedious'),
  undici: () => require('../undici'),
  url: () => require('../url'),
  vitest: { esmFirst: true, fn: () => require('../vitest') },
  vm: () => require('../vm'),
  when: () => require('../when'),
  winston: () => require('../winston'),
  workerpool: () => require('../mocha')
}
