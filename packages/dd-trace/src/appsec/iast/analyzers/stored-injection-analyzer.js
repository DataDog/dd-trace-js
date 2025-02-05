'use strict'

const InjectionAnalyzer = require('./injection-analyzer')

class StoredInjectionAnalyzer extends InjectionAnalyzer {
  _areRangesVulnerable (ranges) {
    return ranges?.length > 0
  }
}

module.exports = StoredInjectionAnalyzer
