'use strict'

const { channel } = require('dc-polyfill')

const ServerPlugin = require('../../dd-trace/src/plugins/server')
const { storage } = require('../../datadog-core')
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')
const { COMPONENT, SVC_SRC_KEY } = require('../../dd-trace/src/constants')
const web = require('../../dd-trace/src/plugins/util/web')
const { HTTP_ROUTE, RESOURCE_NAME } = require('../../../ext/tags')

const errorPages = new Set(['/404', '/500', '/_error', '/_not-found', '/_not-found/page'])
const reusedNextRequestStores = new WeakSet()
const nextParentRoutes = new WeakMap()
const requestMeta = Symbol.for('NextInternalRequestMeta')
const finishChannel = channel('apm:next:request:finish')

/**
 * @typedef {Record<string, unknown> & {
 *   span: import('../../dd-trace/src/opentracing/span'),
 *   req: import('node:http').IncomingMessage,
 *   backgroundRevalidationRequest?: import('node:http').IncomingMessage
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
 * @property {unknown} [error]
 *
 * @typedef {object} NextErrorContext
 * @property {import('../../dd-trace/src/opentracing/span')} [span]
 * @property {NextRequestStore} [currentStore]
 * @property {import('node:http').IncomingMessage} [req]
 * @property {unknown} error
 */

class NextPlugin extends ServerPlugin {
  static id = 'next'

  constructor (...args) {
    super(...args)
    this.addBind('apm:next:request:background-revalidation', req => ({
      ...storage('legacy').getStore(),
      span: undefined,
      backgroundRevalidationRequest: req,
    }))
    this.addSub('apm:next:page:load', message => this.pageLoad(message))
    for (const operation of ['imageRequest', 'imageRequestWithMiddleware']) {
      const prefix = `tracing:orchestrion:next:${operation}`
      this.addBind(`${prefix}:start`, ctx => {
        const args = ctx.arguments
        const pathname = (args[3] || args[2])?.pathname
        if (!pathname?.startsWith('/_next/image')) return storage('legacy').getStore()
        if (operation === 'imageRequestWithMiddleware' && args[0][requestMeta]?.middlewareInvoke) {
          return storage('legacy').getStore()
        }

        ctx.req = args[0].originalRequest || args[0]
        ctx.res = args[1].originalResponse || args[1]
        ctx.currentStore = this.bindStart(ctx)
        return ctx.currentStore
      })
      this.addSub(`${prefix}:start`, ctx => {
        if (ctx.currentStore) this.pageLoad({ page: '/_next/image' })
      })
      this.addSub(`${prefix}:asyncEnd`, ctx => {
        if (!ctx.currentStore) return
        if (ctx.error && !ctx.res.destroyed && !reusedNextRequestStores.has(ctx.currentStore)) {
          ctx.res.once('close', () => finishChannel.publish(ctx))
        } else {
          this.finish(ctx)
        }
      })
    }
  }

  /** @param {NextRequestContext} ctx */
  bindStart (ctx) {
    const { req } = ctx
    const store = storage('legacy').getStore()
    const parentSpan = store?.span
    if (parentSpan?._integrationName === this.constructor.id) {
      const reusedStore = { ...store, span: parentSpan, req }
      reusedNextRequestStores.add(reusedStore)
      if (ctx.finishOnResponse) ctx.currentStore = reusedStore
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
  error ({ currentStore, span, req, error }) {
    const store = currentStore ?? storage('legacy').getStore()
    if (req && store?.backgroundRevalidationRequest === req) return

    span ||= store?.span
    if (span) this.addError(error, span)
  }

  /** @param {NextRequestContext} ctx */
  finish (ctx) {
    const { req, res, nextRequest = {} } = ctx
    const store = ctx.currentStore ?? storage('legacy').getStore()

    if (!store || reusedNextRequestStores.has(store)) return

    const span = store.span
    const error = ctx.error ?? span.context().getTag('error')
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

    // Nested requests, static loads, and error pages must preserve the matched route.
    const current = span.context().getTag('next.page')
    const isErrorPage = errorPages.has(page)

    if (current && (isErrorPage || isStatic || reusedNextRequestStores.has(store))) {
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
