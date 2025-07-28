'use strict'

const config = {
  validateStatus: code => false,
  hooks: {
    request: (span, req) => {
      // to count the number of times this hook has run between all processes
      const times = Number(process.env.TIMES_HOOK_CALLED) + 1
      process.env.TIMES_HOOK_CALLED = times + 1
      span.setTag('times_hook_called', String(times))

      span.setTag('req', req.constructor.name)
      span.setTag('foo', 'bar')
    }
  }
}

module.exports = require('../../..').init({
  service: 'test',
  flushInterval: 0,
  plugins: false
}).use('next', process.env.WITH_CONFIG ? config : true).use('http')
