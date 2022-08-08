'use strict'

module.exports = {
  '@cucumber/cucumber': () => require('../cucumber'),
  '@elastic/elasticsearch': () => require('../elasticsearch'),
  '@elastic/transport': () => require('../elasticsearch'),
  '@google-cloud/pubsub': () => require('../google-cloud-pubsub'),
  '@grpc/grpc-js': () => require('../grpc'),
  '@hapi/hapi': () => require('../hapi'),
  '@koa/router': () => require('../koa'),
  '@node-redis/client': () => require('../redis'),
  'amqp10': () => require('../amqp10'),
  'amqplib': () => require('../amqplib'),
  'aws-sdk': () => require('../aws-sdk'),
  'bluebird': () => require('../bluebird'),
  'bunyan': () => require('../bunyan'),
  'cassandra-driver': () => require('../cassandra-driver'),
  'connect': () => require('../connect'),
  'couchbase': () => require('../couchbase'),
  'cypress': () => require('../cypress'),
  'dns': () => require('../dns'),
  'elasticsearch': () => require('../elasticsearch'),
  'express': () => require('../express'),
  'fastify': () => require('../fastify'),
  'find-my-way': () => require('../find-my-way'),
  'graphql': () => require('../graphql'),
  'grpc': () => require('../grpc'),
  'hapi': () => require('../hapi'),
  'http': () => require('../http'),
  'http2': () => require('../http2'),
  'https': () => require('../http'),
  'ioredis': () => require('../ioredis'),
  'jest-environment-node': () => require('../jest'),
  'jest-environment-jsdom': () => require('../jest'),
  'jest-jasmine2': () => require('../jest'),
  'koa': () => require('../koa'),
  'koa-router': () => require('../koa'),
  'kafkajs': () => require('../kafkajs'),
  'limitd-client': () => require('../limitd-client'),
  'memcached': () => require('../memcached'),
  'microgateway-core': () => require('../microgateway-core'),
  'mocha': () => require('../mocha'),
  'mocha-each': () => require('../mocha'),
  'moleculer': () => require('../moleculer'),
  'mongodb': () => require('../mongodb-core'),
  'mongodb-core': () => require('../mongodb-core'),
  'mongoose': () => require('../mongoose'),
  'mysql': () => require('../mysql'),
  'mysql2': () => require('../mysql2'),
  'net': () => require('../net'),
  'next': () => require('../next'),
  'oracledb': () => require('../oracledb'),
  'paperplane': () => require('../paperplane'),
  'pg': () => require('../pg'),
  'pino': () => require('../pino'),
  'pino-pretty': () => require('../pino'),
  'promise-js': () => require('../promise-js'),
  'promise': () => require('../promise'),
  'q': () => require('../q'),
  'redis': () => require('../redis'),
  'restify': () => require('../restify'),
  'rhea': () => require('../rhea'),
  'router': () => require('../router'),
  'sharedb': () => require('../sharedb'),
  'tedious': () => require('../tedious'),
  'when': () => require('../when'),
  'winston': () => require('../winston')
}
