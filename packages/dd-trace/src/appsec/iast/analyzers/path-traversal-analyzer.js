'use strict'
const Analyzer = require('./vulnerability-analyzer')
const { isTainted, getRanges } = require('../taint-tracking/operations')

class PathTraversalAnalyzer extends Analyzer {
  constructor () {
    super('PATH_TRAVERSAL')
    this.addSub('datadog:fs:access', path => this.analyze(path))
  }

  _isVulnerable (value, ctx) {
    let ret = false
    if (typeof value === 'string') {
      ret = isTainted(ctx, value)
    }
    return ret
  }

  _getEvidence (value, ctx) {
    const ranges = getRanges(ctx, value)
    return { value, ranges }
  }
}

module.exports = new PathTraversalAnalyzer()
