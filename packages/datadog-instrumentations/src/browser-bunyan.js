'use strict'

const wrapLogger = require('./helpers/bunyan')
const { addHook } = require('./helpers/instrument')

addHook({ name: 'browser-bunyan', versions: ['>=1'] }, browserBunyan => {
  // Published versions generate `_emit` through different bundle shapes,
  // so Orchestrion has no stable function to match.
  wrapLogger(browserBunyan.Logger, 'browser-bunyan')
  return browserBunyan
})
