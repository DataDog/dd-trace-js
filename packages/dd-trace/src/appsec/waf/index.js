'use strict'

const WAFManager = require('./waf_manager')
const { storage } = require('../../../../datadog-core')
const log = require('../../log')

const waf = {
  wafManager: null,
  init,
  destroy,
  run: noop,
  disposeContext: noop
}

function init (rules, config) {
  destroy()

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

  if (wafContext) {
    wafContext.dispose()
  }
}

function noop () {}

module.exports = waf
