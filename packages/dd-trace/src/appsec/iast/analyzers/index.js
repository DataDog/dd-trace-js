'use strict'

const analyzers = require('./analyzers')
const setCookiesHeaderInterceptor = require('./set-cookies-header-interceptor')

function enableAllAnalyzers (tracerConfig) {
  setCookiesHeaderInterceptor.configure({ enabled: true, tracerConfig })
  for (const analyzer in analyzers) {
    analyzers[analyzer].configure({ enabled: true, tracerConfig })
  }
}

function disableAllAnalyzers () {
  setCookiesHeaderInterceptor.configure(false)
  for (const analyzer in analyzers) {
    analyzers[analyzer].configure(false)
  }
}

function enableOptOutAnalyzers (tracerConfig) {
  analyzers.HSTS_HEADER_MISSING_ANALYZER.configure({ enabled: true, tracerConfig })
  analyzers.XCONTENTTYPE_HEADER_MISSING_ANALYZER.configure({ enabled: true, tracerConfig })

  setCookiesHeaderInterceptor.configure({ enabled: true, tracerConfig })
  analyzers.NO_HTTPONLY_COOKIE_ANALYZER.configure({ enabled: true, tracerConfig })
  analyzers.INSECURE_COOKIE_ANALYZER.configure({ enabled: true, tracerConfig })
  analyzers.NO_SAMESITE_COOKIE_ANALYZER.configure({ enabled: true, tracerConfig })
}

module.exports = {
  enableAllAnalyzers,
  enableOptOutAnalyzers,
  disableAllAnalyzers
}
