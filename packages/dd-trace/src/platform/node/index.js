'use strict'

const EventEmitter = require('events')
const crypto = require('./crypto')
const now = require('./now')
const env = require('./env')
const validate = require('./validate')
const service = require('./service')
const request = require('./request')
const msgpack = require('./msgpack')
const metrics = require('./metrics')
const plugins = require('../../plugins')
const hostname = require('./hostname')
const Loader = require('./loader')
const Scope = require('../../scope/async_hooks')
const AgentExporter = require('../../exporters/agent')
const LogExporter = require('../../exporters/log')

const emitter = new EventEmitter()

const inAWSLambda = env('AWS_LAMBDA_FUNCTION_NAME') !== undefined
const Exporter = inAWSLambda ? LogExporter : AgentExporter

const platform = {
  _config: {},
  name: () => 'nodejs',
  version: () => process.version,
  engine: () => process.jsEngine || 'v8',
  crypto,
  now,
  env,
  tags: () => ({}),
  validate,
  service,
  request,
  msgpack,
  metrics,
  plugins,
  hostname,
  on: emitter.on.bind(emitter),
  off: emitter.removeListener.bind(emitter),
  Loader,
  Scope,
  Exporter
}

process.once('beforeExit', () => emitter.emit('exit'))

module.exports = platform
