'use strict'

const tracerPath = require.resolve('../../../index')

process.on('message', () => {
  process.send({ tracerLoaded: require.cache[tracerPath] !== undefined }, () => process.disconnect())
})
