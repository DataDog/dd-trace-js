'use strict'
const Analyzer = require('./vulnerability-analyzer')
const { isTainted, getRanges } = require('../taint-tracking/operations')

class PathTraversalAnalyzer extends Analyzer {
  constructor () {
    super('PATH_TRAVERSAL')
    this.addSub('datadog:fs:access', path => this.analyze(path))
  }

  _isVulnerable (path, ctx) {
    if (typeof path === 'string') {
      return isTainted(ctx, path)
    } else {
      return false
    }
  }

  _getEvidence (value, ctx) {
    const ranges = getRanges(ctx, value)
    return { value, ranges }
  }
}

module.exports = new PathTraversalAnalyzer()
