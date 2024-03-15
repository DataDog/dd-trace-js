'use strict'

const setCookiesHeaderInterceptor = require('./set-cookies-header-interceptor')

const basicsAnalizers = {
  'HSTS_HEADER_MISSING_ANALYZER': require('./hsts-header-missing-analyzer'),
  'INSECURE_COOKIE_ANALYZER': require('./insecure-cookie-analyzer'),
  'NO_HTTPONLY_COOKIE_ANALYZER': require('./no-httponly-cookie-analyzer'),
  'NO_SAMESITE_COOKIE_ANALYZER': require('./no-samesite-cookie-analyzer'),
  'WEAK_CIPHER_ANALYZER': require('./weak-cipher-analyzer'),
  'WEAK_HASH_ANALYZER': require('./weak-hash-analyzer'),
  'XCONTENTTYPE_HEADER_MISSING_ANALYZER': require('./xcontenttype-header-missing-analyzer')
}

function enableBasicAnalyzers (tracerConfig) {
  setCookiesHeaderInterceptor.configure({ enabled: true, tracerConfig })
  for (const analyzer in basicsAnalizers) {
    basicsAnalizers[analyzer].configure({ enabled: true, tracerConfig })
  }
}

function disableBasicAnalyzers () {
  setCookiesHeaderInterceptor.configure(false)
  for (const analyzer in basicsAnalizers) {
    basicsAnalizers[analyzer].configure(false)
  }
}

module.exports = {
  enableBasicAnalyzers,
  disableBasicAnalyzers
}


