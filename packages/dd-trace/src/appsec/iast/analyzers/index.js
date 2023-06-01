'use strict'

const analyzers = require('./analyzers')
const setCookiesHeaderInterceptor = require('./set-cookies-header-interceptor')

function enableAllAnalyzers () {
  setCookiesHeaderInterceptor.configure(true)
  for (const analyzer in analyzers) {
    analyzers[analyzer].configure(true)
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
