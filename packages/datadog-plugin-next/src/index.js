'use strict'

const ServerPlugin = require('../../dd-trace/src/plugins/server')
const { storage } = require('../../datadog-core')
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')
const { COMPONENT, SVC_SRC_KEY } = require('../../dd-trace/src/constants')
const web = require('../../dd-trace/src/plugins/util/web')
const { HTTP_ROUTE, RESOURCE_NAME } = require('../../../ext/tags')

const errorPages = new Set(['/404', '/500', '/_error', '/_not-found', '/_not-found/page'])
const reusedNextRequestStores = new WeakSet()
const nextParentRoutes = new WeakMap()

/**
 * @typedef {Record<string, unknown> & {
 *   span: import('../../dd-trace/src/opentracing/span'),
 *   req: import('node:http').IncomingMessage
 * }} NextRequestStore
 *
 * @typedef {object} NextRequest
 * @property {unknown} [error]
 *
 * @typedef {object} NextRequestContext
 * @property {import('node:http').IncomingMessage} req
 * @property {import('node:http').ServerResponse} res
 * @property {NextRequest} [nextRequest]
 * @property {boolean} [finishOnResponse]
 * @property {NextRequestStore} [currentStore]
 *
 * @typedef {object} NextErrorContext
 * @property {import('../../dd-trace/src/opentracing/span')} [span]
 * @property {NextRequestStore} [currentStore]
 * @property {unknown} error
 */

class NextPlugin extends ServerPlugin {
  static id = 'next'

  constructor (...args) {
    super(...args)
    this.addSub('apm:next:page:load', message => this.pageLoad(message))
  }

  /** @param {NextRequestContext} ctx */
  bindStart (ctx) {
    const { req } = ctx
    const store = storage('legacy').getStore()
    const parentSpan = store?.span
    if (parentSpan?._integrationName === this.constructor.id) {
      const reusedStore = { ...store, span: parentSpan, req }
      reusedNextRequestStores.add(reusedStore)
      return reusedStore
    }

    const childOf = parentSpan || web.extractIncomingServerContext(this.tracer, req.headers)
    const { name: schemaServiceName, source: schemaServiceSource } = this.serviceName()
    const serviceName = this.config.service || schemaServiceName
    let serviceSource = this.config.service ? 'opt.plugin' : schemaServiceSource
    if (!serviceName || serviceName === this.tracer._service) serviceSource = undefined

    const tags = {
      [COMPONENT]: this.constructor.id,
      'service.name': serviceName,
      'resource.name': req.method,
      'span.type': 'web',
      'span.kind': 'server',
      'http.method': req.method,
    }
    if (serviceSource !== undefined) tags[SVC_SRC_KEY] = serviceSource

    const span = this.tracer.startSpan(this.operationName(), {
      childOf,
      tags,
      integrationName: this.constructor.id,
    })

    this.stampIntegrationService(span, serviceName)

    analyticsSampler.sample(span, this.config.measured, true)

    const httpParentSpan = parentSpan?._integrationName === 'http' ? parentSpan : undefined
    const currentStore = { ...store, span, req, httpParentSpan }
    if (ctx.finishOnResponse) ctx.currentStore = currentStore
    return currentStore
  }

  /** @param {NextErrorContext} ctx */
  error ({ currentStore, span, error }) {
    span ||= currentStore?.span
    if (!span) {
      const store = storage('legacy').getStore()
      if (!store) return

      span = store.span
    }

    this.addError(error, span)
  }

  /** @param {NextRequestContext} ctx */
  finish (ctx) {
    const { req, res, nextRequest = {} } = ctx
    const store = ctx.currentStore ?? storage('legacy').getStore()

    if (!store) return
    if (reusedNextRequestStores.has(store)) return

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
      web.addError(req, true)
    }

    span.addTags({
      'http.status_code': res.statusCode,
    })

    this.config.hooks.request(span, req, res)

    span.finish()
  }

  pageLoad ({ page, isAppPath = false, isStatic = false, isFilesystemPath = isAppPath }) {
    const store = storage('legacy').getStore()

    if (!store) return

    const { span, req, httpParentSpan } = store

    // safeguard against missing req in complicated timeout scenarios
    if (!req) return

    // Only use error page names if there's not already a name
    const current = span.context().getTag('next.page')
    const isErrorPage = errorPages.has(page)

    if (current && isErrorPage) {
      return
    }

    // Compiled runtimes may publish a normalized pathname rather than a filesystem path.
    if (isFilesystemPath && !isErrorPage) {
      if (isAppPath) page = normalizeAppPath(page)
      page = normalizeIndexPage(page)
    }

    // handle static resource
    if (isStatic) {
      page = req.url.includes('_next/static')
        ? '/_next/static/*'
        : '/public/*'
    }

    span.addTags({
      [COMPONENT]: this.constructor.id,
      'resource.name': `${req.method} ${page}`.trim(),
      'next.page': page,
    })
    web.setRouteOrEndpointTag(req)
    setHttpParentRoute(httpParentSpan, req.method, page, isStatic)
    web.setRoute(req, page)
  }

  configure (config) {
    return super.configure(web.normalizeConfig(config))
  }
}

function normalizeIndexPage (page) {
  if (typeof page !== 'string') return page
  if (page === '/index') return '/'
  if (page.endsWith('/index')) return page.slice(0, -'/index'.length) || '/'
  return page
}

function normalizeAppPath (page) {
  if (typeof page !== 'string') return page

  for (const suffix of ['/page', '/route']) {
    if (page === suffix) return '/'
    if (page.endsWith(suffix)) return page.slice(0, -suffix.length) || '/'
  }

  return page
}

function setHttpParentRoute (span, method, page, isStatic) {
  if (!span) return
  const currentRoute = span.context().getTag(HTTP_ROUTE)

  // Only refine a route that Next itself set; static resources are fallbacks.
  if (currentRoute && (nextParentRoutes.get(span) !== currentRoute || isStatic)) return

  span.setTag(HTTP_ROUTE, page)
  span.setTag(RESOURCE_NAME, `${method} ${page}`.trim())
  nextParentRoutes.set(span, page)
}
module.exports = NextPlugin
