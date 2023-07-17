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

module.exports = {
  enableAllAnalyzers,
  disableAllAnalyzers
}
