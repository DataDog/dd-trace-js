'use strict'

const { childProcessExecutionTracingChannel } = require('../channels')
const { RULE_TYPES, handleResult } = require('./utils')
const { storage } = require('../../../../datadog-core')
const addresses = require('../addresses')
const waf = require('../waf')

let config

function enable (_config) {
  config = _config

  childProcessExecutionTracingChannel.subscribe({
    start: analyzeCommandInjection
  })
}

function disable () {
  if (childProcessExecutionTracingChannel.start.hasSubscribers) {
    childProcessExecutionTracingChannel.unsubscribe({
      start: analyzeCommandInjection
    })
  }
}

function analyzeCommandInjection ({ file, fileArgs, shell, abortController }) {
  if (!file || !shell) return

  const store = storage.getStore()
  const req = store?.req
  if (!req) return

  const commandParams = fileArgs ? [file, ...fileArgs] : file

  const persistent = {
    [addresses.SHELL_COMMAND]: commandParams
  }

  const result = waf.run({ persistent }, req, RULE_TYPES.COMMAND_INJECTION)

  const res = store?.res
  handleResult(result, req, res, abortController, config)
}

module.exports = {
  enable,
  disable
}
