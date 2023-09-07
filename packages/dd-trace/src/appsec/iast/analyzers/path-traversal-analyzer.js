'use strict'

const path = require('path')

const InjectionAnalyzer = require('./injection-analyzer')
const { getIastContext } = require('../iast-context')
const { storage } = require('../../../../../datadog-core')
const { PATH_TRAVERSAL } = require('../vulnerabilities')

const ignoredOperations = ['dir.close', 'close']

class PathTraversalAnalyzer extends InjectionAnalyzer {
  constructor () {
    super(PATH_TRAVERSAL)

    this.exclusionList = [
      path.join('node_modules', 'send') + path.sep
    ]

    this.internalExclusionList = [
      'node:fs',
      'node:internal/fs',
      'node:internal\\fs',
      'fs.js',
      'internal/fs',
      'internal\\fs'
    ]
  }

  onConfigure () {
    this.addSub('apm:fs:operation:start', (obj) => {
      if (ignoredOperations.includes(obj.operation)) return

      const pathArguments = []
      if (obj.dest) {
        pathArguments.push(obj.dest)
      }
      if (obj.existingPath) {
        pathArguments.push(obj.existingPath)
      }
      if (obj.file) {
        pathArguments.push(obj.file)
      }
      if (obj.newPath) {
        pathArguments.push(obj.newPath)
      }
      if (obj.oldPath) {
        pathArguments.push(obj.oldPath)
      }
      if (obj.path) {
        pathArguments.push(obj.path)
      }
      if (obj.prefix) {
        pathArguments.push(obj.prefix)
      }
      if (obj.src) {
        pathArguments.push(obj.src)
      }
      if (obj.target) {
        pathArguments.push(obj.target)
      }
      this.analyze(pathArguments)
    })
  }

  _isExcluded (location) {
    let ret = true
    if (location && location.path) {
      // Exclude from reporting those vulnerabilities which location is from an internal fs call
      if (location.isInternal) {
        ret = this.internalExclusionList.some(elem => location.path.includes(elem))
      } else {
        ret = this.exclusionList.some(elem => location.path.includes(elem))
      }
    }
    return ret
  }

  analyze (value) {
    const iastContext = getIastContext(storage.getStore())
    if (!iastContext) {
      return
    }

    if (value && value.constructor === Array) {
      for (const val of value) {
        if (this._isVulnerable(val, iastContext) && this._checkOCE(iastContext)) {
          this._report(val, iastContext)
          // no support several evidences in the same vulnerability, just report the 1st one
          break
        }
      }
    }
  }
}

module.exports = new PathTraversalAnalyzer()
