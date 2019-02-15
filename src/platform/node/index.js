'use strict'

const EventEmitter = require('events')
const id = require('./id')
const now = require('./now')
const env = require('./env')
const validate = require('./validate')
const service = require('./service')
const request = require('./request')
const msgpack = require('./msgpack')
const Uint64BE = require('./uint64be')

const emitter = new EventEmitter()

const platform = {
  _config: {},
  name: () => 'nodejs',
  version: () => process.version,
  engine: () => process.jsEngine || 'v8',
  configure (config) {
    this._config = config
  },
  id,
  now,
  env,
  validate,
  service,
  request,
  msgpack,
  Uint64BE,
  on: emitter.on.bind(emitter),
  once: emitter.once.bind(emitter),
  off: emitter.removeListener.bind(emitter)
}

process.once('beforeExit', () => emitter.emit('exit'))

module.exports = platform
