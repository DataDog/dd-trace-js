'use strict'

// THIS FILE WILL DISSAPPEAR ONCE ORCHESTRION-JS WORKS !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

const {
  channel,
  addHook
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

addHook({ name: 'log4js', file: 'lib/logger.js', versions: ['>=6'] }, Logger => {
  const logCh = channel('apm:log4js:log')
  shimmer.wrap(Logger.prototype, '_log', _log => {
    return function wrapped_log (level, data) {
      if (logCh.hasSubscribers && Array.isArray(data)) {
        for (let i = 0; i < data.length; i++) {
          if (data[i] && typeof data[i] === 'object' && !Array.isArray(data[i]) && !(data[i] instanceof Error)) {
            const payload = { message: data[i] }
            logCh.publish(payload)
            data[i] = payload.message
            break
          }
        }
      }
      return _log.apply(this, arguments)
    }
  })
  return Logger
})
