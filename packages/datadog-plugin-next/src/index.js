'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')
const { storage } = require('../../datadog-core')
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')

class NextPlugin extends Plugin {
  static get name () {
    return 'next'
  }

  constructor (...args) {
    super(...args)

    this._requests = new WeakMap()

    this.addSub('apm:next:request:start', ({ req, res }) => {
      const store = storage.getStore()
      const childOf = store ? store.span : store
      const span = this.tracer.startSpan('next.request', {
        childOf,
        tags: {
          'service.name': this.config.service || this.tracer._service,
          'resource.name': 'test',
          'span.type': 'web',
          'span.kind': 'server',
          'http.method': req.method
        }
      })

      analyticsSampler.sample(span, this.config.measured, true)

      this.enter(span, store)

      this._requests.set(span, req)
    })

    this.addSub('apm:next:request:error', this.addError)

    this.addSub('apm:next:request:finish', ({ req, res }) => {
      const store = storage.getStore()

      if (!store) return

      const span = store.span
      const error = span.context()._tags['error']

      if (!this.config.validateStatus(res.statusCode) && !error) {
        span.setTag('error', true)
      }

      span.addTags({
        'http.status_code': res.statusCode
      })

      this.config.hooks.request(span, req, res)

      span.finish()
    })

    this.addSub('apm:next:page:load', ({ page }) => {
      const store = storage.getStore()

      if (!store) return

      const span = store.span
      const req = this._requests.get(span)

      span.addTags({
        'resource.name': `${req.method} ${page}`.trim(),
        'next.page': page
      })
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
