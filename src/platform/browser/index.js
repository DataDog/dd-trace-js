'use strict'

const id = require('./id')
const now = require('./now')
const env = require('./env')
const request = require('./request')
const context = require('./context')
const msgpack = require('./msgpack')

module.exports = {
  name: () => 'browser',
  version: () => navigator.userAgent,
  engine: () => 'browser',
  id,
  now,
  env,
  request,
  context,
  msgpack
}
