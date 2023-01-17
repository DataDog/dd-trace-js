'use strict'
const InjectionAnalyzer = require('./injection-analyzer')

class LdapInjectionAnalyzer extends InjectionAnalyzer {
  constructor () {
    super('LDAP_INJECTION')
    this.addSub('datadog:ldapjs:client:search', ({ base, filter }) => this.analyzeAll(base, filter))
  }
}

module.exports = new LdapInjectionAnalyzer()
