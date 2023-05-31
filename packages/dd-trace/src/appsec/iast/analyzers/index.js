'use strict'

const analyzers = require('./analyzers')

function enableAllAnalyzers () {
  for (const analyzer in analyzers) {
    analyzers[analyzer].configure(true)
  }
}

function disableAllAnalyzers () {
  for (const analyzer in analyzers) {
    analyzers[analyzer].configure(false)
  }
}

module.exports = {
  enableAllAnalyzers,
  disableAllAnalyzers
}
