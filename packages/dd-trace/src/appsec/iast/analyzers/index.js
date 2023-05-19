'use strict'

const analyzers = require('./analyzers')
const enabledAnalyzers = {}
function enableAllAnalyzers () {
  for (const analyzerName in analyzers) {
    const analyzer = analyzers[analyzerName]
    analyzer.configure(true)
    enabledAnalyzers[analyzerName] = analyzer
  }
}

function disableAllAnalyzers () {
  for (const analyzer in analyzers) {
    analyzers[analyzer].configure(false)
  }
}

const optOutAnalyzers = ['WEAK_CIPHER_ANALYZER', 'WEAK_HASH_ANALYZER', 'INSECURE_COOKIE_ANALYZER']
function enableOptOutAnalyzers () {
  optOutAnalyzers.forEach(analyzerName => {
    const analyzer = analyzers[analyzerName]
    analyzer.configure(true)
    enabledAnalyzers[analyzerName] = analyzer
  })
}

function disableOptOutAnalyzers () {
  optOutAnalyzers.forEach(analyzerName => {
    const analyzer = analyzers[analyzerName]
    analyzer.configure(false)
    enabledAnalyzers[analyzerName] = undefined
  })
}

const httpResponseAnalyzers = ['INSECURE_COOKIE_ANALYZER']
function getHttpResponseAnalyzers () {
  const analyzers = []
  httpResponseAnalyzers.forEach(analyzerName => {
    const analyzer = enabledAnalyzers[analyzerName]
    if (analyzer) {
      analyzers.push(analyzer)
    }
  })
  return analyzers
}

module.exports = {
  enableAllAnalyzers,
  enableOptOutAnalyzers,
  disableAllAnalyzers,
  disableOptOutAnalyzers,
  getHttpResponseAnalyzers
}
