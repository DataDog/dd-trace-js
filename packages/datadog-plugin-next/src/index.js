'use strict'

const ServerPlugin = require('../../dd-trace/src/plugins/server')
const { storage } = require('../../datadog-core')
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')
const { COMPONENT } = require('../../dd-trace/src/constants')
const web = require('../../dd-trace/src/plugins/util/web')

class NextPlugin extends ServerPlugin {
  static get id () {
    return 'next'
  }

  constructor (...args) {
    super(...args)
    this._requests = new WeakMap()
    this.addSub('apm:next:page:load', message => this.pageLoad(message))
  }

  bindStart ({ req, res }) {
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

    this._requests.set(span, req)

    return { ...store, span }
  }

  error ({ span, error }) {
    this.addError(error, span)
  }

  finish ({ req, res, nextRequest = {} }) {
    const store = storage.getStore()

    if (!store) return

    const span = store.span
    const error = span.context()._tags['error']

    if (!this.config.validateStatus(res.statusCode) && !error) {
      span.setTag('error', req.error || nextRequest.error || true)
      web.addError(req, req.error || nextRequest.error || true)
    }

    span.addTags({
      'http.status_code': res.statusCode
    })

    this.config.hooks.request(span, req, res)

    span.finish()
  }

  pageLoad ({ page, isAppPath = false, isStatic = false }) {
    const store = storage.getStore()

    if (!store) return

    const span = store.span
    const req = this._requests.get(span)

    // Only use error page names if there's not already a name
    const current = span.context()._tags['next.page']
    if (current && ['/404', '/500', '/_error', '/_not-found'].includes(page)) {
      return
    }

    // remove ending /route or /page for appDir projects
    if (isAppPath) page = page.substring(0, page.lastIndexOf('/'))

    // handle static resource
    if (isStatic) {
      page = req.url.includes('_next/static')
        ? '/_next/static/*'
        : '/public/*'
    }

    span.addTags({
      [COMPONENT]: this.constructor.id,
      'resource.name': `${req.method} ${page}`.trim(),
      'next.page': page
    })

    web.setRoute(req, page)
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

  return Object.assign({}, config, { hooks, validateStatus })
}

function getHooks (config) {
  const noop = () => {}
  const request = (config.hooks && config.hooks.request) || noop

  return { request }
}

module.exports = NextPlugin
