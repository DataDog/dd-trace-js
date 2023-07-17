'use strict'

const Analyzer = require('./vulnerability-analyzer')

const SC_MOVED_PERMANENTLY = 301
const SC_MOVED_TEMPORARILY = 302
const SC_NOT_MODIFIED = 304
const SC_TEMPORARY_REDIRECT = 307
const SC_NOT_FOUND = 404
const SC_GONE = 410
const SC_INTERNAL_SERVER_ERROR = 500

const IGNORED_RESPONSE_STATUS_LIST = [SC_MOVED_PERMANENTLY, SC_MOVED_TEMPORARILY, SC_NOT_MODIFIED,
  SC_TEMPORARY_REDIRECT, SC_NOT_FOUND, SC_GONE, SC_INTERNAL_SERVER_ERROR]
const HTML_CONTENT_TYPES = ['text/html', 'application/xhtml+xml']

class MissingHeaderAnalyzer extends Analyzer {
  constructor (type, headerName) {
    super(type)

    this.headerName = headerName
  }

  onConfigure () {
    this.addSub({
      channelName: 'datadog:iast:response-end',
      moduleName: 'http'
    }, (data) => this.analyze(data))
  }

  _getLocation () {
    return undefined
  }

  _checkOCE (context) {
    return true
  }

  _createHashSource (type, evidence, location) {
    return `${type}:${this.config.tracerConfig.service}`
  }

  _getEvidence ({ res }) {
    return { value: res.getHeader(this.headerName) }
  }

  _isVulnerable ({ req, res }, context) {
    if (!IGNORED_RESPONSE_STATUS_LIST.includes(res.statusCode) && this._isResponseHtml(res)) {
      return this._isVulnerableFromRequestAndResponse(req, res)
    }
    return false
  }

  _isVulnerableFromRequestAndResponse (req, res) {
    return false
  }

  _isResponseHtml (res) {
    const contentType = res.getHeader('content-type')
    return contentType && HTML_CONTENT_TYPES.some(htmlContentType => {
      return htmlContentType === contentType || contentType.startsWith(htmlContentType + ';')
    })
  }
}

module.exports = { MissingHeaderAnalyzer }
