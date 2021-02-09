'use strict'

const EventEmitter = require('events')
const crypto = require('./crypto')
const validate = require('./validate')
const pkg = require('./pkg')

const emitter = new EventEmitter()

const platform = {
  _config: {},
  configure (config) {
    this._config = config
  },
  crypto,
  validate,
  service: () => process.env['AWS_LAMBDA_FUNCTION_NAME'] || pkg.name,
  appVersion: () => pkg.version,
  on: emitter.on.bind(emitter),
  off: emitter.removeListener.bind(emitter)
}

process.once('beforeExit', () => emitter.emit('exit'))

module.exports = platform
