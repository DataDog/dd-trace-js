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
  HTTP_REQUEST_URI,
  SQL_ROW_VALUE
} = require('./source-types')
const { EXECUTED_SOURCE } = require('../telemetry/iast-metric')

const REQ_HEADER_TAGS = EXECUTED_SOURCE.formatTags(HTTP_REQUEST_HEADER_VALUE, HTTP_REQUEST_HEADER_NAME)
const REQ_URI_TAGS = EXECUTED_SOURCE.formatTags(HTTP_REQUEST_URI)

class TaintTrackingPlugin extends SourceIastPlugin {
  constructor () {
    super()
    this._type = 'taint-tracking'
    this._taintedURLs = new WeakMap()
  }

  configure (config) {
    super.configure(config)

    let rowsToTaint = this.iastConfig?.dbRowsToTaint
    if (typeof rowsToTaint !== 'number') {
      rowsToTaint = 1
    }
    this._rowsToTaint = rowsToTaint
  }

  onConfigure () {
    const onRequestBody = ({ req }) => {
      const iastContext = getIastContext(storage('legacy').getStore())
      if (iastContext && iastContext.body !== req.body) {
        this._taintTrackingHandler(HTTP_REQUEST_BODY, req, 'body', iastContext)
        iastContext.body = req.body
      }
    }

    this.addSub(
      { channelName: 'datadog:body-parser:read:finish', tag: HTTP_REQUEST_BODY },
      onRequestBody
    )

    this.addSub(
      { channelName: 'datadog:multer:read:finish', tag: HTTP_REQUEST_BODY },
      onRequestBody
    )

    this.addSub(
      { channelName: 'datadog:query:read:finish', tag: HTTP_REQUEST_PARAMETER },
      ({ query }) => this._taintTrackingHandler(HTTP_REQUEST_PARAMETER, query)
    )

    this.addSub(
      { channelName: 'datadog:express:query:finish', tag: HTTP_REQUEST_PARAMETER },
      ({ query }) => this._taintTrackingHandler(HTTP_REQUEST_PARAMETER, query)
    )

    this.addSub(
      { channelName: 'apm:express:middleware:next', tag: HTTP_REQUEST_BODY },
      ({ req }) => {
        if (req && req.body !== null && typeof req.body === 'object') {
          const iastContext = getIastContext(storage('legacy').getStore())
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
      { channelName: 'datadog:sequelize:query:finish', tag: SQL_ROW_VALUE },
      ({ result }) => this._taintDatabaseResult(result, 'sequelize')
    )

    this.addSub(
      { channelName: 'apm:pg:query:finish', tag: SQL_ROW_VALUE },
      ({ result }) => this._taintDatabaseResult(result, 'pg')
    )

    this.addSub(
      { channelName: 'datadog:express:process_params:start', tag: HTTP_REQUEST_PATH_PARAM },
      ({ req }) => {
        if (req && req.params !== null && typeof req.params === 'object') {
          this._taintTrackingHandler(HTTP_REQUEST_PATH_PARAM, req, 'params')
        }
      }
    )

    this.addSub(
      { channelName: 'datadog:router:param:start', tag: HTTP_REQUEST_PATH_PARAM },
      ({ req }) => {
        if (req && req.params !== null && typeof req.params === 'object') {
          this._taintTrackingHandler(HTTP_REQUEST_PATH_PARAM, req, 'params')
        }
      }
    )

    this.addSub(
      { channelName: 'apm:graphql:resolve:start', tag: HTTP_REQUEST_BODY },
      (data) => {
        const iastContext = getIastContext(storage('legacy').getStore())
        const source = data.context?.source
        const ranges = source && getRanges(iastContext, source)
        if (ranges?.length) {
          this._taintTrackingHandler(ranges[0].iinfo.type, data.args, null, iastContext)
        }
      }
    )

    const urlResultTaintedProperties = ['host', 'origin', 'hostname']
    this.addSub(
      { channelName: 'datadog:url:parse:finish' },
      ({ input, base, parsed, isURL }) => {
        const iastContext = getIastContext(storage('legacy').getStore())
        let ranges

        if (base) {
          ranges = getRanges(iastContext, base)
        } else {
          ranges = getRanges(iastContext, input)
        }

        if (ranges?.length) {
          if (isURL) {
            this._taintedURLs.set(parsed, ranges[0])
          } else {
            urlResultTaintedProperties.forEach(param => {
              this._taintTrackingHandler(ranges[0].iinfo.type, parsed, param, iastContext)
            })
          }
        }
      }
    )

    this.addSub(
      { channelName: 'datadog:url:getter:finish' },
      (context) => {
        if (!urlResultTaintedProperties.includes(context.property)) return

        const origRange = this._taintedURLs.get(context.urlObject)
        if (!origRange) return

        const iastContext = getIastContext(storage('legacy').getStore())
        if (!iastContext) return

        context.result =
          newTaintedString(iastContext, context.result, origRange.iinfo.parameterName, origRange.iinfo.type)
      })

    // this is a special case to increment INSTRUMENTED_SOURCE metric for header
    this.addInstrumentedSource('http', [HTTP_REQUEST_HEADER_VALUE, HTTP_REQUEST_HEADER_NAME])
  }

  _taintTrackingHandler (type, target, property, iastContext = getIastContext(storage('legacy').getStore())) {
    if (!property) {
      taintObject(iastContext, target, type)
    } else if (target[property]) {
      target[property] = taintObject(iastContext, target[property], type)
    }
  }

  _cookiesTaintTrackingHandler (target) {
    const iastContext = getIastContext(storage('legacy').getStore())
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

  _taintDatabaseResult (result, dbOrigin, iastContext = getIastContext(storage('legacy').getStore()), name) {
    if (!iastContext) return result

    if (this._rowsToTaint === 0) return result

    if (Array.isArray(result)) {
      for (let i = 0; i < result.length && i < this._rowsToTaint; i++) {
        const nextName = name ? `${name}.${i}` : '' + i
        result[i] = this._taintDatabaseResult(result[i], dbOrigin, iastContext, nextName)
      }
    } else if (result && typeof result === 'object') {
      if (dbOrigin === 'sequelize' && result.dataValues) {
        result.dataValues = this._taintDatabaseResult(result.dataValues, dbOrigin, iastContext, name)
      } else {
        for (const key in result) {
          const nextName = name ? `${name}.${key}` : key
          result[key] = this._taintDatabaseResult(result[key], dbOrigin, iastContext, nextName)
        }
      }
    } else if (typeof result === 'string') {
      result = newTaintedString(iastContext, result, name, SQL_ROW_VALUE)
    }

    return result
  }
}

module.exports = new TaintTrackingPlugin()
