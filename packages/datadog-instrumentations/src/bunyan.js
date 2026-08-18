'use strict'

const wrapLogger = require('./helpers/bunyan')
const { addHook } = require('./helpers/instrument')

addHook({ name: 'bunyan', versions: ['>=1'] }, Logger => {
  wrapLogger(Logger, 'bunyan')
  return Logger
})
