'use strict'

const id = require('./id')
const now = require('./now')
const env = require('./env')
const load = require('./load')
const service = require('./service')
const request = require('./request')
const msgpack = require('./msgpack')

module.exports = {
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
  load,
  service,
  request,
  msgpack
}
