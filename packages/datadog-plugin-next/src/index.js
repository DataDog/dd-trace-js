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

    // TODO figure out why this doesn't seem to bubble up with static files
    // web.request span seems to finish early
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

    // This is for static files whose 'page' includes the whole file path
    // For normal page matches, like /api/hello/[name] and a req.url like /api/hello/world,
    // nothing should happen
    // For page matches like /User/something/public/text.txt and req.url like /text.txt,
    // it should disregard the extra absolute path Next.js sometimes sets
    if (page.includes(req.url)) page = req.url

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

  return Object.assign({}, config, { hooks, validateStatus })
}

function getHooks (config) {
  const noop = () => {}
  const request = (config.hooks && config.hooks.request) || noop

  return { request }
}

module.exports = NextPlugin
