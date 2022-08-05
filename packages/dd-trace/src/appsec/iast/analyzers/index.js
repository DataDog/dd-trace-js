'use strict'

const analyzers = {
  'weakHashAnalyzer': require('./weak-hash-analyzer')
}

function enableAllAnalyzers () {
  for (const analyzer in analyzers) {
    analyzer.config(true)
  }
}

function disableAllAnalyzers () {
  for (const analyzer in analyzers) {
    analyzer.config(false)
  }
}

module.exports = {
  enableAllAnalyzers,
  disableAllAnalyzers
}
