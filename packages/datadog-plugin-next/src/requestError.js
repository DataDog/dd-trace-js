'use strict'

const { parseRumSessionId } = require('./utils/parseSessionCookie')

/**
 * Handler for Next.js `onRequestError` instrumentation hook.
 *
 * Wire this up in your `instrumentation.ts`:
 * ```js
 * const { datadogOnRequestError } = require('dd-trace/next')
 * export const onRequestError = datadogOnRequestError
 * ```
 *
 * Creates an error span with route context, error details, and RUM session correlation.
 *
 * @param {Object} error - { message, stack?, digest? }
 * @param {Object} request - { path, method, headers }
 * @param {Object} context - { routerKind, routePath, routeType, renderSource? }
 */
function datadogOnRequestError (error, request, context) {
  const tracer = global._ddtrace
  if (!tracer) return

  const span = tracer.startSpan('nextjs.server_error', {
    tags: {
      'resource.name': `${request.method} ${context.routePath}`,
      'http.method': request.method,
      'http.url': request.path,
      'error': true,
      'error.message': error.message,
      'error.stack': error.stack,
      'error.type': (error.constructor && error.constructor.name) || 'Error',
      'nextjs.router_kind': context.routerKind,
      'nextjs.route_path': context.routePath,
      'nextjs.route_type': context.routeType,
      'span.kind': 'server'
    }
  })

  if (context.renderSource) {
    span.setTag('nextjs.render_source', context.renderSource)
  }

  if (error.digest) {
    span.setTag('nextjs.error_digest', error.digest)
  }

  // Extract RUM session ID from _dd_s cookie for client<>server correlation
  const cookieHeader = request.headers && request.headers.cookie
  if (cookieHeader) {
    const ddsCookieMatch = cookieHeader.match(/(?:^|;\s*)_dd_s=([^;]*)/)
    if (ddsCookieMatch) {
      const sessionId = parseRumSessionId(ddsCookieMatch[1])
      if (sessionId) {
        span.setTag('rum.session_id', sessionId)
      }
    }
  }

  span.finish()
}

module.exports = { datadogOnRequestError }
