'use strict'

const ServerPlugin = require('../../dd-trace/src/plugins/server')
const { storage } = require('../../datadog-core')
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')
const { COMPONENT, SVC_SRC_KEY } = require('../../dd-trace/src/constants')
const { SERVER } = require('../../../ext/kinds')
const { getStatusValidator } = require('../../dd-trace/src/plugins/util/http-error-statuses')
const {
  HTTP_STATUS_ERROR,
  INSTRUMENTATION_HTTP_RESOURCE,
  runHttpRequestHook,
  setInstrumentationHttpResource,
} = require('../../dd-trace/src/plugins/util/http-otel-semantics')
const { getQsObfuscator } = require('../../dd-trace/src/plugins/util/url')
const web = require('../../dd-trace/src/plugins/util/web')
const addOtelRequestTags = require('./request-tags')

const errorPages = new Set(['/404', '/500', '/_error', '/_not-found', '/_not-found/page'])

class NextPlugin extends ServerPlugin {
  static id = 'next'

  constructor (...args) {
    super(...args)
    this.addSub('apm:next:page:load', message => this.pageLoad(message))
  }

  bindStart ({ req, res }) {
    const store = storage('legacy').getStore()
    const childOf = store ? store.span : store
    const { name: schemaServiceName, source: schemaServiceSource } = this.serviceName()
    const serviceName = this.config.service || schemaServiceName
    let serviceSource = this.config.service ? 'opt.plugin' : schemaServiceSource
    if (!serviceName || serviceName === this.tracer._service) serviceSource = undefined

    const span = this.tracer.startSpan(this.operationName(), {
      childOf,
      tags: {
        [COMPONENT]: this.constructor.id,
        'service.name': serviceName,
        'resource.name': req.method,
        ...(this.config.DD_TRACE_OTEL_SEMANTICS_ENABLED && {
          [INSTRUMENTATION_HTTP_RESOURCE]: req.method,
        }),
        'span.type': 'web',
        'span.kind': 'server',
        'http.method': req.method,
        ...(serviceSource === undefined ? undefined : { [SVC_SRC_KEY]: serviceSource }),
      },
      integrationName: this.constructor.id,
    })

    // Next.js does not populate these request tags through web.addRequestTags.
    // Capture them under the flag so the shared OTel conversion can derive the
    // canonical url.*, server.*, and network.peer.address attributes.
    addOtelRequestTags(span, this.config, req)

    this.stampIntegrationService(span, serviceName)

    analyticsSampler.sample(span, this.config.measured, true)

    return { ...store, span, req }
  }

  error ({ span, error }) {
    if (!span) {
      const store = storage('legacy').getStore()
      if (!store) return

      span = store.span
    }

    this.addError(error, span)
  }

  finish ({ req, res, nextRequest = {} }) {
    const store = storage('legacy').getStore()

    if (!store) return

    const span = store.span
    const error = span.context().getTag('error')
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
      if (this.config.DD_TRACE_OTEL_SEMANTICS_ENABLED) {
        span.setTag(HTTP_STATUS_ERROR, 'true')
      }
      web.addError(req, true)
    }

    span.addTags({
      'http.status_code': res.statusCode,
    })

    runHttpRequestHook(span, this.config.hooks.request, req, res)

    span.finish()
  }

  pageLoad ({ page, isAppPath = false, isStatic = false }) {
    const store = storage('legacy').getStore()

    if (!store) return

    const { span, req } = store

    // safeguard against missing req in complicated timeout scenarios
    if (!req) return

    // Only use error page names if there's not already a name
    const current = span.context().getTag('next.page')
    const isErrorPage = errorPages.has(page)

    if (current && isErrorPage) {
      return
    }

    // remove ending /route or /page for appDir projects
    // need to check if not an error page too, as those are marked as app directory
    // in newer versions
    if (isAppPath && !isErrorPage) page = page.slice(0, Math.max(0, page.lastIndexOf('/')))

    // handle static resource
    if (isStatic) {
      page = req.url.includes('_next/static')
        ? '/_next/static/*'
        : '/public/*'
    }

    const resource = `${req.method} ${page}`.trim()
    span.setTag(COMPONENT, this.constructor.id)
    span.setTag('next.page', page)
    if (this.config.DD_TRACE_OTEL_SEMANTICS_ENABLED) {
      setInstrumentationHttpResource(span, resource)
    } else {
      span.setTag('resource.name', resource)
    }
    web.setRoute(req, page)
  }

  configure (config) {
    return super.configure(normalizeConfig(config))
  }
}

function normalizeConfig (config) {
  const hooks = getHooks(config)
  const validateStatus = getStatusValidator(config, SERVER)
  const queryStringObfuscation = getQsObfuscator(config)

  return { ...config, hooks, validateStatus, queryStringObfuscation }
}

const noop = () => {}

function getHooks (config) {
  const request = config.hooks?.request ?? noop

  return { request }
}

module.exports = NextPlugin
