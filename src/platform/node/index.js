'use strict'

const id = require('./id')
const now = require('./now')
const env = require('./env')
const load = require('./load')
const service = require('./service')
const request = require('./request')
const context = require('./context')
const msgpack = require('./msgpack')
const instrumenter = require('./instrumenter')

module.exports = {
  name: () => 'nodejs',
  version: () => process.version,
  engine: () => process.jsEngine || 'v8',
  id,
  now,
  env,
  load,
  service,
  request,
  context,
  msgpack,
  instrumenter
}
