'use strict'

const { storage } = require('../../../../datadog-core')
const log = require('../../log')

const waf = {
  wafManager: null,
  init,
  destroy,
  update,
  run: noop,
  disposeContext: noop
}

function init (rules, config) {
  destroy()

  // dirty require to make startup faster for serverless
  const WAFManager = require('./waf_manager')

  waf.wafManager = new WAFManager(rules, config)

  waf.run = run
  waf.disposeContext = disposeContext
}

function destroy () {
  if (waf.wafManager) {
    waf.wafManager.destroy()
    waf.wafManager = null
  }

  waf.run = noop
  waf.disposeContext = noop
}

function update (newRules) {
  // TODO: check race conditions between Appsec enable/disable and WAF updates, the whole RC state management in general
  if (!waf.wafManager) throw new Error('Cannot update disabled WAF')

  try {
    waf.wafManager.update(newRules)
  } catch (err) {
    log.error('Could not apply rules from remote config')
    throw err
  }
}

function run (data, req) {
  if (!req) {
    const store = storage.getStore()
    if (!store || !store.req) {
      log.warn('Request object not available in waf.run')
      return
    }

    req = store.req
  }

  const wafContext = waf.wafManager.getWAFContext(req)

  return wafContext.run(data)
}

function disposeContext (req) {
  const wafContext = waf.wafManager.getWAFContext(req)

  if (wafContext && !wafContext.ddwafContext.disposed) {
    wafContext.dispose()
  }
}

function noop () {}

module.exports = waf
