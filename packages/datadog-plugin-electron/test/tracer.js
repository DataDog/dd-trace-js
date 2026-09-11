'use strict'

/* eslint-disable no-console */

const logger = globalThis.logger = {
  debug: (...args) => console.debug(...args),
  info: (...args) => console.info(...args),
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
}

const tracer = require('../../dd-trace')
  .init({
    service: 'test',
    env: 'tester',
    logger,
    flushInterval: 0,
    plugins: false,
  })
  .use('electron', true)

const extract = tracer._tracer.extract
tracer._tracer.extract = function (format, carrier) {
  if (carrier === undefined) process.send?.({ name: 'extract-with-undefined' })
  return extract.call(this, format, carrier)
}
