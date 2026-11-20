'use strict'

const tracer = require('dd-trace')

tracer.init({
  startupLogs: false,
  url: process.env.DD_TRACE_AGENT_URL,
  flushInterval: 10,
})

const { buildSchema, graphql } = require('graphql')

const finish = require('../finish')

const schema = buildSchema('type Query { hello: String }')

graphql({ schema, source: '{ hello }', rootValue: { hello: () => 'world' } }).then(finish)
