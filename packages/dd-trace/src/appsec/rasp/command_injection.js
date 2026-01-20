'use strict'

const { childProcessExecutionTracingChannel } = require('../channels')
const { storage } = require('../../../../datadog-core')
const addresses = require('../addresses')
const waf = require('../waf')
const { RULE_TYPES, handleResult } = require('./utils')

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
  const req = getValue(store && store.req)
  if (!req) return

  const ephemeral = {}
  const raspRule = { type: RULE_TYPES.COMMAND_INJECTION }
  const params = fileArgs ? [file, ...fileArgs] : file

  if (shell) {
    ephemeral[addresses.SHELL_COMMAND] = params
    raspRule.variant = 'shell'
  } else {
    const commandParams = Array.isArray(params) ? params : [params]
    ephemeral[addresses.EXEC_COMMAND] = commandParams
    raspRule.variant = 'exec'
  }

  const result = waf.run({ ephemeral }, req, raspRule)

  const res = getValue(store && store.res)
  handleResult(result, req, res, abortController, config, raspRule)
}

function getValue (maybeWeakRef) {
  return maybeWeakRef && typeof maybeWeakRef.deref === 'function' ? maybeWeakRef.deref() : maybeWeakRef
}

module.exports = {
  enable,
  disable
}
