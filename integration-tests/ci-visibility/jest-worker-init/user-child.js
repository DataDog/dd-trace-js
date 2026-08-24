'use strict'

const path = require('node:path')

const initPath = require.resolve('dd-trace/ci/init')
const tracerPath = require.resolve(path.join(path.dirname(initPath), '..', 'packages', 'dd-trace'))

process.send({
  messageListenerCount: process.listenerCount('message'),
  tracerLoaded: require.cache[tracerPath] !== undefined,
})
