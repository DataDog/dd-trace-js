'use strict'

module.exports = {
  '@apollo/server': () => require('../apollo-server'),
  '@apollo/gateway': () => require('../apollo'),
  'apollo-server-core': () => require('../apollo-server-core'),
  '@aws-sdk/smithy-client': () => require('../aws-sdk'),
  '@cucumber/cucumber': () => require('../cucumber'),
  '@playwright/test': () => require('../playwright'),
  '@elastic/elasticsearch': () => require('../elasticsearch'),
  '@elastic/transport': () => require('../elasticsearch'),
  '@google-cloud/pubsub': () => require('../google-cloud-pubsub'),
  '@graphql-tools/executor': () => require('../graphql'),
  '@grpc/grpc-js': () => require('../grpc'),
  '@hapi/hapi': () => require('../hapi'),
  '@jest/core': () => require('../jest'),
  '@jest/reporters': () => require('../jest'),
  '@jest/test-sequencer': () => require('../jest'),
  '@jest/transform': () => require('../jest'),
  '@koa/router': () => require('../koa'),
  '@node-redis/client': () => require('../redis'),
  '@opensearch-project/opensearch': () => require('../opensearch'),
  '@opentelemetry/sdk-trace-node': () => require('../otel-sdk-trace'),
  '@redis/client': () => require('../redis'),
  '@smithy/smithy-client': () => require('../aws-sdk'),
  aerospike: () => require('../aerospike'),
  amqp10: () => require('../amqp10'),
  amqplib: () => require('../amqplib'),
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
  dns: () => require('../dns'),
  elasticsearch: () => require('../elasticsearch'),
  express: () => require('../express'),
  'express-mongo-sanitize': () => require('../express-mongo-sanitize'),
  fastify: () => require('../fastify'),
  'find-my-way': () => require('../find-my-way'),
  fs: () => require('../fs'),
  'generic-pool': () => require('../generic-pool'),
  graphql: () => require('../graphql'),
  grpc: () => require('../grpc'),
  hapi: () => require('../hapi'),
  http: () => require('../http'),
  http2: () => require('../http2'),
  https: () => require('../http'),
  ioredis: () => require('../ioredis'),
  'jest-circus': () => require('../jest'),
  'jest-config': () => require('../jest'),
  'jest-environment-node': () => require('../jest'),
  'jest-environment-jsdom': () => require('../jest'),
  'jest-runtime': () => require('../jest'),
  'jest-worker': () => require('../jest'),
  knex: () => require('../knex'),
  koa: () => require('../koa'),
  'koa-router': () => require('../koa'),
  kafkajs: () => require('../kafkajs'),
  ldapjs: () => require('../ldapjs'),
  'limitd-client': () => require('../limitd-client'),
  lodash: () => require('../lodash'),
  mariadb: () => require('../mariadb'),
  memcached: () => require('../memcached'),
  'microgateway-core': () => require('../microgateway-core'),
  mocha: () => require('../mocha'),
  'mocha-each': () => require('../mocha'),
  vitest: () => require('../vitest'),
  '@vitest': () => require('../vitest'),
  '@vitest/runner': () => require('../vitest'),
  workerpool: () => require('../mocha'),
  moleculer: () => require('../moleculer'),
  mongodb: () => require('../mongodb'),
  'mongodb-core': () => require('../mongodb-core'),
  mongoose: () => require('../mongoose'),
  mquery: () => require('../mquery'),
  mysql: () => require('../mysql'),
  mysql2: () => require('../mysql2'),
  net: () => require('../net'),
  next: () => require('../next'),
  'node:child_process': () => require('../child_process'),
  'node:crypto': () => require('../crypto'),
  'node:dns': () => require('../dns'),
  'node:http': () => require('../http'),
  'node:http2': () => require('../http2'),
  'node:https': () => require('../http'),
  'node:net': () => require('../net'),
  oracledb: () => require('../oracledb'),
  openai: () => require('../openai'),
  paperplane: () => require('../paperplane'),
  'passport-http': () => require('../passport-http'),
  'passport-local': () => require('../passport-local'),
  pg: () => require('../pg'),
  pino: () => require('../pino'),
  'pino-pretty': () => require('../pino'),
  playwright: () => require('../playwright'),
  'promise-js': () => require('../promise-js'),
  promise: () => require('../promise'),
  q: () => require('../q'),
  qs: () => require('../qs'),
  redis: () => require('../redis'),
  restify: () => require('../restify'),
  rhea: () => require('../rhea'),
  router: () => require('../router'),
  'selenium-webdriver': () => require('../selenium'),
  sequelize: () => require('../sequelize'),
  sharedb: () => require('../sharedb'),
  tedious: () => require('../tedious'),
  undici: () => require('../undici'),
  when: () => require('../when'),
  winston: () => require('../winston')
}
