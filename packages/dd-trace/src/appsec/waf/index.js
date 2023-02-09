'use strict'

const WAFManager = require('./waf_manager')

function init (rules, config) {
  if (!waf.wafManager) {
    waf.wafManager = new WAFManager(rules, config)
  }
}

function destroy () {
  if (waf.wafManager) {
    waf.wafManager.destroy()
    waf.wafManager = null
  }
}

const waf = {
  init,
  destroy,
  wafManager: null
}

module.exports = waf
