'use strict'

const ServerPlugin = require('../../dd-trace/src/plugins/server')
const { storage } = require('../../datadog-core')
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')
const { COMPONENT } = require('../../dd-trace/src/constants')
const web = require('../../dd-trace/src/plugins/util/web')
const urlFilter = require('../../dd-trace/src/plugins/util/urlfilter')

class NextPlugin extends ServerPlugin {
  static get id () {
    return 'next'
  }

  constructor (...args) {
    super(...args)
    this._requests = new WeakMap()
    this.addSub('apm:next:page:load', message => this.pageLoad(message))
  }

  bindStart (message) {
    const { req, authority, options, headers = {} } = message
    const sessionDetails = extractSessionDetails(authority, options)
    const path = headers[HTTP2_HEADER_PATH] || '/'
    const pathname = path.split(/[?#]/)[0]
    const uri = `${sessionDetails.protocol}//${sessionDetails.host}:${sessionDetails.port}${pathname}`
    const allowed = this.config.filter(uri)

    const store = storage.getStore()
    const childOf = store ? store.span : store
    const span = this.tracer.startSpan(this.operationName(), {
      childOf,
      tags: {
        [COMPONENT]: this.constructor.id,
        'service.name': this.config.service || this.serviceName(),
        'resource.name': req.method,
        'span.type': 'web',
        'span.kind': 'server',
        'http.method': req.method
      }
    })

    analyticsSampler.sample(span, this.config.measured, true)

    // TODO: Figure out a better way to do this for any span.
    if (!allowed) {
      span._spanContext._trace.record = false
    }

    this._requests.set(span, req)

    return { ...store, span }
  }

  error ({ span, error }) {
    this.addError(error, span)
  }

  finish ({ req, res }) {
    const store = storage.getStore()

    if (!store) return

    const span = store.span
    const error = span.context()._tags['error']
    const page = span.context()._tags['next.page']

    if (!this.config.validateStatus(res.statusCode) && !error) {
      span.setTag('error', true)
    }

    span.addTags({
      'http.status_code': res.statusCode
    })

    if (page) web.setRoute(req, page)

    this.config.hooks.request(span, req, res)

    span.finish()
  }

  pageLoad ({ page }) {
    const store = storage.getStore()

    if (!store) return

    const span = store.span
    const req = this._requests.get(span)

    // Only use error page names if there's not already a name
    const current = span.context()._tags['next.page']
    if (current && (page === '/404' || page === '/500' || page === '/_error')) {
      return
    }

    span.addTags({
      [COMPONENT]: this.constructor.id,
      'resource.name': `${req.method} ${page}`.trim(),
      'next.page': page
    })
  }

  configure (config) {
    return super.configure(normalizeConfig(config))
  }
}

function normalizeConfig (config) {
  const hooks = getHooks(config)
  const validateStatus = typeof config.validateStatus === 'function'
    ? config.validateStatus
    : code => code < 500
  const filter = getFilter(config)

  return Object.assign({}, config, {
    hooks,
    filter,
    validateStatus
  })
}

function getHooks (config) {
  const noop = () => {}
  const request = (config.hooks && config.hooks.request) || noop

  return { request }
}

function getFilter (config) {
  config = Object.assign({}, config, {
    blocklist: config.blocklist || []
  })

  return urlFilter.getFilter(config)
}

function extractSessionDetails (options) {
  if (typeof options === 'string') {
    return new URL(options).host
  }

  const host = options.hostname || options.host || 'localhost'
  const port = options.port

  return { host, port }
}

module.exports = NextPlugin
