'use strict'
const InjectionAnalyzer = require('./injection-analyzer')
const { LDAP_INJECTION } = require('../vulnerabilities')

class LdapInjectionAnalyzer extends InjectionAnalyzer {
  constructor () {
    super(LDAP_INJECTION)
  }

  onConfigure () {
    this.addSub('datadog:ldapjs:client:search', ({ base, filter }) => this.analyzeAll(base, filter))
  }
}

module.exports = new LdapInjectionAnalyzer()
