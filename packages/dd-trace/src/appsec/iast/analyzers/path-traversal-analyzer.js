'use strict'
const Analyzer = require('./vulnerability-analyzer')
const { getIastContext } = require('../iast-context')
const { storage } = require('../../../../../datadog-core')
const { isTainted, getRanges } = require('../taint-tracking/operations')

class PathTraversalAnalyzer extends Analyzer {
  constructor () {
    super('PATH_TRAVERSAL')
    this.addSub('datadog:fs:access', obj => this.analyze(obj.arguments))
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

  analyze (value) {
    const iastContext = getIastContext(storage.getStore())
    if (!iastContext) {
      return
    }

    if (value && value.constructor === Array) {
      for (const val of value) {
        if (this._isVulnerable(val, iastContext)) {
          this._report(val, iastContext)
          // no support several evidences in the same vulnerability, just report the 1st one
          break
        }
      }
    }
  }
}

module.exports = new PathTraversalAnalyzer()
