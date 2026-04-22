'use strict'

const shimmer = require('../../datadog-shimmer')
const { addHook } = require('./helpers/instrument')
const { createCallbackInstrumentor } = require('./helpers/callback-instrumentor')

const asyncMethods = [
  'brotliCompress',
  'brotliDecompress',
  'deflate',
  'deflateRaw',
  'gunzip',
  'gzip',
  'inflate',
  'inflateRaw',
  'unzip',
]

addHook({ name: 'zlib' }, zlib => {
  const instrument = createCallbackInstrumentor('apm:zlib:operation')
  for (const method of asyncMethods) {
    if (typeof zlib[method] === 'function') {
      shimmer.wrap(zlib, method, instrument(() => ({ operation: method })))
    }
  }
  return zlib
})
