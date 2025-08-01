'use strict'
const InjectionAnalyzer = require('./injection-analyzer')
const { LDAP_INJECTION } = require('../vulnerabilities')
const { getNodeModulesPaths } = require('../path-line')
const { storage } = require('../../../../../datadog-core')

const EXCLUDED_PATHS = getNodeModulesPaths('ldapjs-promise')

class LdapInjectionAnalyzer extends InjectionAnalyzer {
  constructor () {
    super(LDAP_INJECTION)
  }

  onConfigure () {
    this.addSub('datadog:ldapjs:client:search', ({ base, filter }) => this.analyzeAll(base, filter))
    this.addBind('datadog:ldapjs:function:bind:start', (ctx) => {
      ctx.parentStore = storage('legacy').getStore()
      return ctx.parentStore
    })
    this.addBind('datadog:ldapjs:function:bind:finish', (ctx) => {
      return ctx.parentStore
    })
  }

  _getExcludedPaths () {
    return EXCLUDED_PATHS
  }
}

module.exports = new LdapInjectionAnalyzer()
