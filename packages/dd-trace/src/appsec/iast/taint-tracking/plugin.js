'use strict'

const { SourceIastPlugin } = require('../iast-plugin')
const { getIastContext } = require('../iast-context')
const { storage } = require('../../../../../datadog-core')
const { taintObject, newTaintedString, getRanges } = require('./operations')
const {
  HTTP_REQUEST_BODY,
  HTTP_REQUEST_COOKIE_VALUE,
  HTTP_REQUEST_COOKIE_NAME,
  HTTP_REQUEST_HEADER_VALUE,
  HTTP_REQUEST_HEADER_NAME,
  HTTP_REQUEST_PARAMETER,
  HTTP_REQUEST_PATH_PARAM,
  HTTP_REQUEST_URI
} = require('./source-types')
const { EXECUTED_SOURCE } = require('../telemetry/iast-metric')

const REQ_HEADER_TAGS = EXECUTED_SOURCE.formatTags(HTTP_REQUEST_HEADER_VALUE, HTTP_REQUEST_HEADER_NAME)
const REQ_URI_TAGS = EXECUTED_SOURCE.formatTags(HTTP_REQUEST_URI)

class TaintTrackingPlugin extends SourceIastPlugin {
  constructor () {
    super()
    this._type = 'taint-tracking'
  }

  onConfigure () {
    this.addSub(
      { channelName: 'datadog:body-parser:read:finish', tag: HTTP_REQUEST_BODY },
      ({ req }) => {
        const iastContext = getIastContext(storage.getStore())
        if (iastContext && iastContext.body !== req.body) {
          this._taintTrackingHandler(HTTP_REQUEST_BODY, req, 'body', iastContext)
          iastContext.body = req.body
        }
      }
    )

    this.addSub(
      { channelName: 'datadog:qs:parse:finish', tag: HTTP_REQUEST_PARAMETER },
      ({ qs }) => this._taintTrackingHandler(HTTP_REQUEST_PARAMETER, qs)
    )

    this.addSub(
      { channelName: 'apm:express:middleware:next', tag: HTTP_REQUEST_BODY },
      ({ req }) => {
        if (req && req.body && typeof req.body === 'object') {
          const iastContext = getIastContext(storage.getStore())
          if (iastContext && iastContext.body !== req.body) {
            this._taintTrackingHandler(HTTP_REQUEST_BODY, req, 'body', iastContext)
            iastContext.body = req.body
          }
        }
      }
    )

    this.addSub(
      { channelName: 'datadog:cookie:parse:finish', tag: [HTTP_REQUEST_COOKIE_VALUE, HTTP_REQUEST_COOKIE_NAME] },
      ({ cookies }) => this._cookiesTaintTrackingHandler(cookies)
    )

    this.addSub(
      { channelName: 'datadog:express:process_params:start', tag: HTTP_REQUEST_PATH_PARAM },
      ({ req }) => {
        if (req && req.params && typeof req.params === 'object') {
          this._taintTrackingHandler(HTTP_REQUEST_PATH_PARAM, req, 'params')
        }
      }
    )

    this.addSub(
      { channelName: 'apm:graphql:resolve:start', tag: HTTP_REQUEST_BODY },
      (data) => {
        const iastContext = getIastContext(storage.getStore())
        const source = data.context?.source
        const ranges = source && getRanges(iastContext, source)
        if (ranges?.length) {
          this._taintTrackingHandler(ranges[0].iinfo.type, data.args, null, iastContext)
        }
      }
    )

    // this is a special case to increment INSTRUMENTED_SOURCE metric for header
    this.addInstrumentedSource('http', [HTTP_REQUEST_HEADER_VALUE, HTTP_REQUEST_HEADER_NAME])
  }

  _taintTrackingHandler (type, target, property, iastContext = getIastContext(storage.getStore())) {
    if (!property) {
      taintObject(iastContext, target, type)
    } else if (target[property]) {
      target[property] = taintObject(iastContext, target[property], type)
    }
  }

  _cookiesTaintTrackingHandler (target) {
    const iastContext = getIastContext(storage.getStore())
    // Prevent tainting cookie names since it leads to taint literal string with same value.
    taintObject(iastContext, target, HTTP_REQUEST_COOKIE_VALUE)
  }

  taintHeaders (headers, iastContext) {
    // Prevent tainting header names since it leads to taint literal string with same value.
    this.execSource({
      handler: () => taintObject(iastContext, headers, HTTP_REQUEST_HEADER_VALUE),
      tags: REQ_HEADER_TAGS,
      iastContext
    })
  }

  taintUrl (req, iastContext) {
    this.execSource({
      handler: function () {
        req.url = newTaintedString(iastContext, req.url, HTTP_REQUEST_URI, HTTP_REQUEST_URI)
      },
      tags: REQ_URI_TAGS,
      iastContext
    })
  }

  taintRequest (req, iastContext) {
    this.taintHeaders(req.headers, iastContext)
    this.taintUrl(req, iastContext)
  }
}

module.exports = new TaintTrackingPlugin()
