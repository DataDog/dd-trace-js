'use strict'

const { NO_SQL_MONGODB_INJECTION } = require('../vulnerabilities')
module.exports = {
  'COMMAND_INJECTION_ANALYZER': require('./command-injection-analyzer'),
  'HSTS_HEADER_MISSING_ANALYZER': require('./hsts-header-missing-analyzer'),
  'INSECURE_COOKIE_ANALYZER': require('./insecure-cookie-analyzer'),
  'LDAP_ANALYZER': require('./ldap-injection-analyzer'),
  'NO_HTTPONLY_COOKIE_ANALYZER': require('./no-httponly-cookie-analyzer'),
  'NO_SAMESITE_COOKIE_ANALYZER': require('./no-samesite-cookie-analyzer'),
  'NO_SQL_MONGODB_INJECTION': require('./nosql-injection-mongodb-analyzer'),
  'PATH_TRAVERSAL_ANALYZER': require('./path-traversal-analyzer'),
  'SQL_INJECTION_ANALYZER': require('./sql-injection-analyzer'),
  'SSRF': require('./ssrf-analyzer'),
  'UNVALIDATED_REDIRECT_ANALYZER': require('./unvalidated-redirect-analyzer'),
  'WEAK_CIPHER_ANALYZER': require('./weak-cipher-analyzer'),
  'WEAK_HASH_ANALYZER': require('./weak-hash-analyzer'),
  'XCONTENTTYPE_HEADER_MISSING_ANALYZER': require('./xcontenttype-header-missing-analyzer')
}
