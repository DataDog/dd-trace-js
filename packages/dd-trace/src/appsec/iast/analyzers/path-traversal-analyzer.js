'use strict'
const { getIastContext } = require('../iast-context')
const { storage } = require('../../../../../datadog-core')
const InjectionAnalyzer = require('./injection-analyzer')

class PathTraversalAnalyzer extends InjectionAnalyzer {
  constructor () {
    super('PATH_TRAVERSAL')
    this.addSub('datadog:fs:access', obj => this.analyze(obj.arguments))
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
