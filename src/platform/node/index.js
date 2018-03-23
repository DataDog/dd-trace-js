'use strict'

const id = require('./id')
const now = require('./now')
const env = require('./env')
const request = require('./request')
const context = require('./context')
const msgpack = require('./msgpack')

module.exports = {
  name: () => 'nodejs',
  version: () => process.version,
  engine: () => process.jsEngine || 'v8',
  id,
  now,
  env,
  request,
  context,
  msgpack
}
