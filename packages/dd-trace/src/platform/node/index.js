'use strict'

const EventEmitter = require('events')
const crypto = require('./crypto')
const now = require('./now')
const validate = require('./validate')
const request = require('./request')
const hostname = require('./hostname')
const pkg = require('./pkg')

const emitter = new EventEmitter()

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
  tags: () => ({}),
  validate,
  service: () => process.env['AWS_LAMBDA_FUNCTION_NAME'] || pkg.name,
  appVersion: () => pkg.version,
  request,
  hostname,
  on: emitter.on.bind(emitter),
  off: emitter.removeListener.bind(emitter)
}

process.once('beforeExit', () => emitter.emit('exit'))

module.exports = platform
