'use strict'

module.exports = {
  COMMAND_INJECTION: 'COMMAND_INJECTION',
  CODE_INJECTION: 'CODE_INJECTION',
  HARDCODED_PASSWORD: 'HARDCODED_PASSWORD',
  HARDCODED_SECRET: 'HARDCODED_SECRET',
  HSTS_HEADER_MISSING: 'HSTS_HEADER_MISSING',
  INSECURE_COOKIE: 'INSECURE_COOKIE',
  LDAP_INJECTION: 'LDAP_INJECTION',
  NO_HTTPONLY_COOKIE: 'NO_HTTPONLY_COOKIE',
  NO_SAMESITE_COOKIE: 'NO_SAMESITE_COOKIE',
  NOSQL_MONGODB_INJECTION: 'NOSQL_MONGODB_INJECTION',
  PATH_TRAVERSAL: 'PATH_TRAVERSAL',
  SQL_INJECTION: 'SQL_INJECTION',
  SSRF: 'SSRF',
  TEMPLATE_INJECTION: 'TEMPLATE_INJECTION',
  UNVALIDATED_REDIRECT: 'UNVALIDATED_REDIRECT',
  UNTRUSTED_DESERIALIZATION: 'UNTRUSTED_DESERIALIZATION',
  WEAK_CIPHER: 'WEAK_CIPHER',
  WEAK_HASH: 'WEAK_HASH',
  WEAK_RANDOMNESS: 'WEAK_RANDOMNESS',
  XCONTENTTYPE_HEADER_MISSING: 'XCONTENTTYPE_HEADER_MISSING'
}
