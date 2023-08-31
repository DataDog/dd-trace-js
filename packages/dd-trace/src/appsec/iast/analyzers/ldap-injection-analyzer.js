'use strict'
const InjectionAnalyzer = require('./injection-analyzer')
const { LDAP_INJECTION } = require('../vulnerabilities')
const { getNodeModulesPaths } = require('../path-line')

const EXCLUDED_PATHS = getNodeModulesPaths('ldapjs-promise')

class LdapInjectionAnalyzer extends InjectionAnalyzer {
  constructor () {
    super(LDAP_INJECTION)
  }

  onConfigure () {
    this.addSub('datadog:ldapjs:client:search', ({ base, filter }) => this.analyzeAll(base, filter))
  }

  _getExcludedPaths () {
    return EXCLUDED_PATHS
  }
}

module.exports = new LdapInjectionAnalyzer()
