'use strict'

const EventEmitter = require('events')
const crypto = require('./crypto')
const now = require('./now')
const env = require('./env')
const validate = require('./validate')
const request = require('./request')
const metrics = require('./metrics')
const plugins = require('../../plugins')
const hostname = require('./hostname')
const Loader = require('./loader')
const scopes = require('../../../../../ext/scopes')
const exporter = require('./exporter')
const pkg = require('./pkg')
const startupLog = require('./startup-log')
const semver = require('semver')

const emitter = new EventEmitter()

const hasSupportedAsyncLocalStorage = semver.satisfies(process.versions.node, '>=14.5 || ^12.19.0')

const platform = {
  _config: {},
  configure (config) {
    this._config = config
  },
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
  metrics,
  plugins,
  startupLog,
  hostname,
  on: emitter.on.bind(emitter),
  off: emitter.removeListener.bind(emitter),
  Loader,
  getScope (scope) {
    if (scope === scopes.ASYNC_RESOURCE) {
      return require('../../scope/async_resource')
    } else if (scope === scopes.ASYNC_LOCAL_STORAGE || (!scope && hasSupportedAsyncLocalStorage)) {
      return require('../../scope/async_local_storage')
    } else {
      return require('../../scope/async_hooks')
    }
  },
  exporter
}

process.once('beforeExit', () => emitter.emit('exit'))

module.exports = platform
