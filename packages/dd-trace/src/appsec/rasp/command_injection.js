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
  if (!file) return

  const store = storage('legacy').getStore()
  const req = store?.req
  if (!req) return

  const persistent = {}
  const raspRule = { type: RULE_TYPES.COMMAND_INJECTION }
  const params = fileArgs ? [file, ...fileArgs] : file

  if (shell) {
    persistent[addresses.SHELL_COMMAND] = params
    raspRule.variant = 'shell'
  } else {
    const commandParams = Array.isArray(params) ? params : [params]
    persistent[addresses.EXEC_COMMAND] = commandParams
    raspRule.variant = 'exec'
  }

  const result = waf.run({ persistent }, req, raspRule)

  const res = store?.res
  handleResult(result, req, res, abortController, config)
}

module.exports = {
  enable,
  disable
}
