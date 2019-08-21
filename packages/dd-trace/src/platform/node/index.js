'use strict'

const EventEmitter = require('events')
const id = require('./id')
const uuid = require('./uuid')
const now = require('./now')
const env = require('./env')
const validate = require('./validate')
const service = require('./service')
const request = require('./request')
const msgpack = require('./msgpack')
const metrics = require('./metrics')
const Uint64BE = require('./uint64be')
const hostname = require('./hostname')
const plugins = require('../../plugins')
const Loader = require('./loader')
const Scope = require('../../scope/async_hooks')
const Exporter = require('../../exporters/agent')

const emitter = new EventEmitter()

const platform = {
  _config: {},
  name: () => 'nodejs',
  version: () => process.version,
  engine: () => process.jsEngine || 'v8',
  configure (config) {
    this._config = config
  },
  runtime () {
    return {
      id: () => {
        return this._config._runtimeId || (this._config._runtimeId = this.uuid())
      }
    }
  },
  id,
  uuid,
  now,
  env,
  validate,
  service,
  request,
  msgpack,
  metrics,
  Uint64BE,
  hostname,
  plugins,
  on: emitter.on.bind(emitter),
  once: emitter.once.bind(emitter),
  off: emitter.removeListener.bind(emitter),
  Loader,
  Scope,
  Exporter
}

process.once('beforeExit', () => emitter.emit('exit'))

module.exports = platform
