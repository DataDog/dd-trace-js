'use strict'

module.exports = {
  'COMMAND_INJECTION_ANALYZER': require('./command-injection-analyzer'),
  'INSECURE_COOKIE_ANALYZER': require('./insecure-cookie-analyzer'),
  'LDAP_ANALYZER': require('./ldap-injection-analyzer'),
  'PATH_TRAVERSAL_ANALYZER': require('./path-traversal-analyzer'),
  'SQL_INJECTION_ANALYZER': require('./sql-injection-analyzer'),
  'SSRF': require('./ssrf-analyzer'),
  'WEAK_CIPHER_ANALYZER': require('./weak-cipher-analyzer'),
  'WEAK_HASH_ANALYZER': require('./weak-hash-analyzer')
}
