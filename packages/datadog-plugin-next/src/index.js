'use strict'

const ServerPlugin = require('../../dd-trace/src/plugins/server')
const { storage } = require('../../datadog-core')
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')
const { COMPONENT } = require('../../dd-trace/src/constants')
const web = require('../../dd-trace/src/plugins/util/web')

const errorPages = ['/404', '/500', '/_error', '/_not-found', '/_not-found/page']

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
    if (!span) {
      const store = storage.getStore()
      if (!store) return

      span = store.span
    }

    this.addError(error, span)
  }

  finish ({ req, res, nextRequest = {} }) {
    const store = storage.getStore()

    if (!store) return

    const span = store.span
    const error = span.context()._tags.error
    const requestError = req.error || nextRequest.error

    if (requestError) {
      // prioritize user-set errors from API routes
      span.setTag('error', requestError)
      web.addError(req, requestError)
    } else if (error) {
      // general error handling
      span.setTag('error', error)
      web.addError(req, requestError || error)
    } else if (!this.config.validateStatus(res.statusCode)) {
      // where there's no error, we still need to validate status
      span.setTag('error', true)
      web.addError(req, true)
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

    // safeguard against missing req in complicated timeout scenarios
    if (!req) return

    // Only use error page names if there's not already a name
    const current = span.context()._tags['next.page']
    const isErrorPage = errorPages.includes(page)

    if (current && isErrorPage) {
      return
    }

    // remove ending /route or /page for appDir projects
    // need to check if not an error page too, as those are marked as app directory
    // in newer versions
    if (isAppPath && !isErrorPage) page = page.substring(0, page.lastIndexOf('/'))

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
