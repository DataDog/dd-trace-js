'use strict'

const wrapLogger = require('./helpers/bunyan')
const { addHook, channel } = require('./helpers/instrument')

const logSubmissionCh = channel('ci:log-submission:bunyan:log')

addHook({ name: 'bunyan', versions: ['>=1'] }, Logger => {
  wrapLogger(Logger, 'bunyan', logSubmissionCh)
  return Logger
})
