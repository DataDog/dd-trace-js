'use strict'

const EventEmitter = require('events')
const crypto = require('./crypto')
const now = require('./now')
const env = require('./env')
const validate = require('./validate')
const request = require('./request')
const msgpack = require('./msgpack')
const metrics = require('./metrics')
const plugins = require('../../plugins')
const hostname = require('./hostname')
const Loader = require('./loader')
const scopes = require('../../../../../ext/scopes')
const exporter = require('./exporter')
const pkg = require('./pkg')

const emitter = new EventEmitter()

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
  service: () => process.env['AWS_LAMBDA_FUNCTION_NAME'] || pkg.name,
  appVersion: () => pkg.version,
  request,
  msgpack,
  metrics,
  plugins,
  hostname,
  on: emitter.on.bind(emitter),
  off: emitter.removeListener.bind(emitter),
  Loader,
  getScope (scope) {
    if (scope === scopes.ASYNC_LOCAL_STORAGE) {
      return require('../../scope/async_local_storage')
    }
    return require('../../scope/async_hooks')
  },
  exporter
}

process.once('beforeExit', () => emitter.emit('exit'))

module.exports = platform
