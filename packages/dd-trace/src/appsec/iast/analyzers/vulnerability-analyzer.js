'use strict'

const { storage } = require('../../../../../datadog-core')
const { getFirstNonDDPathAndLine } = require('../path-line')
const { addVulnerability } = require('../vulnerability-reporter')
const { getIastContext } = require('../iast-context')
const overheadController = require('../overhead-controller')
const { SinkIastPlugin } = require('../iast-plugin')
const { getOriginalPathAndLineFromSourceMap } = require('../taint-tracking/rewriter')

class Analyzer extends SinkIastPlugin {
  constructor (type) {
    super()
    this._type = type
  }

  _isVulnerable (value, context) {
    return false
  }

  _isExcluded (location) {
    return false
  }

  _report (value, context, meta) {
    const evidence = this._getEvidence(value, context, meta)
    this._reportEvidence(value, context, evidence)
  }

  _reportEvidence (value, context, evidence) {
    const location = this._getLocation(value)
    if (!this._isExcluded(location)) {
      const locationSourceMap = this._replaceLocationFromSourceMap(location)
      const spanId = context && context.rootSpan && context.rootSpan.context().toSpanId()
      const vulnerability = this._createVulnerability(this._type, evidence, spanId, locationSourceMap)
      addVulnerability(context, vulnerability)
    }
  }

  _reportIfVulnerable (value, context, meta) {
    if (this._isVulnerable(value, context) && this._checkOCE(context, value)) {
      this._report(value, context, meta)
      return true
    }
    return false
  }

  _getEvidence (value) {
    return { value }
  }

  _getLocation () {
    return getFirstNonDDPathAndLine(this._getExcludedPaths())
  }

  _replaceLocationFromSourceMap (location) {
    if (location) {
      const { path, line, column } = getOriginalPathAndLineFromSourceMap(location)
      if (path) {
        location.path = path
      }
      if (line) {
        location.line = line
      }
      if (column) {
        location.column = column
      }
    }
    return location
  }

  _getExcludedPaths () {}

  _isInvalidContext (store, iastContext) {
    return store && !iastContext
  }

  analyze (value, store = storage.getStore(), meta) {
    const iastContext = getIastContext(store)
    if (this._isInvalidContext(store, iastContext)) return

    this._reportIfVulnerable(value, iastContext, meta)
  }

  analyzeAll (...values) {
    const store = storage.getStore()
    const iastContext = getIastContext(store)
    if (this._isInvalidContext(store, iastContext)) return

    for (let i = 0; i < values.length; i++) {
      const value = values[i]
      if (this._isVulnerable(value, iastContext)) {
        if (this._checkOCE(iastContext, value)) {
          this._report(value, iastContext)
        }
        break
      }
    }
  }

  _checkOCE (context) {
    return overheadController.hasQuota(overheadController.OPERATIONS.REPORT_VULNERABILITY, context)
  }

  _createVulnerability (type, evidence, spanId, location) {
    if (type && evidence) {
      const _spanId = spanId || 0
      return {
        type,
        evidence,
        location: {
          spanId: _spanId,
          ...location
        },
        hash: this._createHash(this._createHashSource(type, evidence, location))
      }
    }
    return null
  }

  _createHashSource (type, evidence, location) {
    return location ? `${type}:${location.path}:${location.line}` : type
  }

  _createHash (hashSource) {
    let hash = 0
    let offset = 0
    const size = hashSource.length
    for (let i = 0; i < size; i++) {
      hash = ((hash << 5) - hash) + hashSource.charCodeAt(offset++)
    }
    return hash
  }

  addSub (iastSubOrChannelName, handler) {
    const iastSub = typeof iastSubOrChannelName === 'string'
      ? { channelName: iastSubOrChannelName }
      : iastSubOrChannelName

    super.addSub({ tag: this._type, ...iastSub }, handler)
  }
}

module.exports = Analyzer
