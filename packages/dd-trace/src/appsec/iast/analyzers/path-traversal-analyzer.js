'use strict'
const Analyzer = require('./vulnerability-analyzer')
const { isTainted, getRanges } = require('../taint-tracking/operations')

class PathTraversalAnalyzer extends Analyzer {
  constructor () {
    super('PATH_TRAVERSAL')
    this.addSub('datadog:fs:access', path => this.analyze(path))
    this.evidence = ''
  }

  _isVulnerable (pathArray, ctx) {
    let ret = false
    if (typeof pathArray !== 'object' || pathArray.constructor !== Array) {
      return ret
    }

    for (const value of pathArray) {
      if (typeof value === 'string') {
        ret = isTainted(ctx, value)
        if (ret) {
          // Return the first vulnerable argument
          this.evidence = value
          break
        }
      }
    }

    return ret
  }

  _getEvidence (ctx) {
    const value = this.evidence
    const ranges = getRanges(ctx, value)
    return { value, ranges }
  }
}

module.exports = new PathTraversalAnalyzer()
