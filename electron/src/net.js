'use strict'

const { tracingChannel } = require('dc-polyfill')

const requestCh = tracingChannel('apm:electron:net:request')

function getTracer () {
  // eslint-disable-next-line n/no-missing-require
  return require('dd-trace')
}

requestCh.start.subscribe(ctx => {
  const tracer = getTracer()
  const args = ctx.args
  let options = args[0]

  if (typeof options === 'string') {
    options = args[0] = { url: options }
  } else if (!options) {
    options = args[0] = {}
  }

  const headers = options.headers || {}

  let parsed
  try {
    parsed = typeof options === 'string'
      ? new URL(options)
      : options.url
        ? new URL(options.url)
        : options
  } catch {
    parsed = options
  }

  const method = (options.method || parsed?.method || 'GET').toUpperCase()
  const urlStr = options.url || (parsed?.href) || ''

  const span = tracer.startSpan('http.request', {
    tags: {
      'span.kind': 'client',
      'span.type': 'http',
      component: 'electron',
      'resource.name': method,
      'http.method': method,
      'http.url': urlStr,
    },
  })

  ctx._span = span
  ctx.currentStore = tracer.scope().activate(span)

  // Inject trace headers into the request
  const carrier = {}
  tracer.inject(span, 'http_headers', carrier)

  options.headers = options.headers || {}
  for (const name of Object.keys(carrier)) {
    if (!headers[name]) {
      options.headers[name] = carrier[name]
    }
  }
})

requestCh.asyncStart.subscribe(ctx => {
  const { _span: span, res } = ctx

  if (!span) return

  const responseHead = res?._responseHead
  const statusCode = responseHead?.statusCode

  if (statusCode !== undefined) {
    span.setTag('http.status_code', String(statusCode))
  }

  span.finish()
  ctx._span = undefined
})

requestCh.error.subscribe(ctx => {
  if (ctx._span) {
    ctx._span.setTag('error', ctx.error)
  }
})

requestCh.end.subscribe(ctx => {
  // finished in asyncStart after response headers arrive; nothing to do here
})
