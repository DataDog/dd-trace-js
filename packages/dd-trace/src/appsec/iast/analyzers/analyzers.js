module.exports = {
  'WEAK_CIPHER_ANALYZER': require('./weak-cipher-analyzer'),
  'WEAK_HASH_ANALYZER': require('./weak-hash-analyzer'),
  'SQL_INJECTION_ANALYZER': require('./sql-injection-analyzer'),
  'PATH_TRAVERSAL_ANALYZER': require('./path-traversal-analyzer'),
  'COMMAND_INJECTION_ANALYZER': require('./command-injection-analyzer'),
  'LDAP_ANALYZER': require('./ldap-injection-analyzer')
}
