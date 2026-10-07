'use strict'

// Initialize before loading HTTP so requests exercise the native instrumentation.
// eslint-disable-next-line import/order
const tracer = require('../..').init({ flushInterval: 100 })

const http = require('node:http')

const { SpanKind } = require('@opentelemetry/api')

tracer.use('http', {
  client: {
    service: 'wire-client',
    hooks: {
      request (span, request) {
        const path = request.path
        span.setTag('resource.name', `${request.method} ${path}`)
        span.setTag('http.endpoint', path)
      },
    },
  },
  server: {
    service: 'wire-server',
    hooks: {
      request (span, request) {
        span.setTag('resource.name', `${request.method} ${request.url}`)
        span.setTag('http.endpoint', '/native-endpoint')
        if (request.url === '/503') span.setTag('http.route', '/native-route')
      },
    },
  },
})

const provider = new tracer.TracerProvider()
provider.register()
const bridge = provider.getTracer('wire-bridge')

/**
 * @param {string} name
 * @param {Record<string, unknown>} tags
 */
function manual (name, tags) {
  const span = tracer.startSpan(name)
  span.setTag('resource.name', name)
  span.setTag('span.kind', 'client')
  for (const [key, value] of Object.entries(tags)) span.setTag(key, value)
  span.finish()
}

/**
 * @param {string} name
 * @param {Record<string, string | number>} attributes
 */
function canonical (name, attributes) {
  const span = bridge.startSpan(name, { kind: SpanKind.CLIENT, attributes })
  span.end()
}

async function main () {
  // The IPC channel holds the child until both real wire pipelines have delivered.
  process.once('message', () => process.disconnect())

  const server = http.createServer((request, response) => {
    response.statusCode = Number(request.url.slice(1))
    response.end('wire')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    for (const [method, path] of [['GET', '/404'], ['GET', '/503'], ['PURGE', '/201']]) {
      await new Promise((resolve, reject) => {
        const request = http.request({ hostname: '127.0.0.1', port, method, path }, response => {
          response.resume()
          response.once('end', resolve)
          response.once('error', reject)
        })
        request.once('error', reject)
        request.end()
      })
    }
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }

  manual('legacy-malformed', { 'http.method': 'GET', 'http.status_code': '500oops' })
  manual('legacy-exponent', { 'http.method': 'GET', 'http.status_code': '1e2' })
  manual('invalid-legacy', {
    'http.method': 'GET', 'http.status_code': 'bogus', 'http.response.status_code': '204',
  })
  manual('invalid-legacy-metric', {
    'http.method': 'GET',
    'http.status_code': 'bogus',
    'http.response.status_code': '0204',
    'http.response': { status_code: 205 },
  })
  manual('falsy-legacy', {
    'http.method': 'GET', 'http.status_code': '', 'http.response.status_code': '204',
  })
  manual('derived-wins', {
    'http.method': 'GET',
    'http.status_code': '203',
    'http.response.status_code': '204',
    'http.response': { status_code: 205 },
    'network.destination.port': 8080,
    'server.port': '81',
    server: { port: 82 },
  })
  manual('invalid-derived-port', {
    'http.method': 'GET',
    'network.destination.port': Infinity,
    'server.port': '81',
    server: { port: 82 },
  })
  manual('meta-wins', {
    'http.response.status_code': '204',
    'http.response': { status_code: 205 },
    'server.port': '81',
    server: { port: 82 },
  })
  manual('metric-fallback', {
    'http.response.status_code': '0204',
    'http.response': { status_code: 205 },
    'server.port': '01',
    server: { port: 82 },
  })
  manual('invalid-metric', {
    'http.response.status_code': '204',
    'http.response': { status_code: Infinity },
    'server.port': '81',
    server: { port: Infinity },
  })
  manual('both-invalid', {
    'http.response.status_code': '1e2',
    'http.response': { status_code: Number.MAX_SAFE_INTEGER + 1 },
    'server.port': '1.5',
    server: { port: Infinity },
  })
  manual('BREW /endpoint', {
    'span.kind': 'server', 'http.method': 'BREW', 'http.status_code': '503', 'http.endpoint': '/endpoint',
  })
  manual('GET /route', {
    'span.kind': 'server',
    'http.method': 'GET',
    'http.status_code': '503',
    'http.endpoint': '/endpoint',
    'http.route': '/route',
    error: new RangeError('wire exception'),
  })

  manual('GET /exception-404', {
    'span.kind': 'server',
    'http.method': 'GET',
    'http.status_code': '404',
    error: new RangeError('wire exception'),
  })
  for (const error of [false, true]) {
    manual('GET /partition', { 'http.method': 'GET', 'http.status_code': '204', error })
  }

  canonical('canonical-max', {
    'http.response.status_code': String(Number.MAX_SAFE_INTEGER),
    'server.port': Number.MAX_SAFE_INTEGER,
  })
  canonical('canonical-min', {
    'http.response.status_code': Number.MIN_SAFE_INTEGER,
    'server.port': String(Number.MIN_SAFE_INTEGER),
  })
  canonical('canonical-zero', { 'http.response.status_code': '0', 'server.port': 0 })
  canonical('canonical-negative', { 'http.response.status_code': -1, 'server.port': '-1' })
  for (const [name, value] of [
    ['leading-zero', '0204'], ['negative-zero', '-0'], ['whitespace', ' 204'], ['decimal', '204.0'],
    ['plus', '+204'], ['exponent', '1e2'], ['unsafe-string', '9007199254740992'],
    ['unsafe-number', Number.MAX_SAFE_INTEGER + 1], ['unsafe-negative-string', '-9007199254740992'],
    ['unsafe-negative-number', Number.MIN_SAFE_INTEGER - 1], ['fraction', 204.5], ['infinite', Infinity], ['nan', NaN],
  ]) {
    canonical(`invalid-${name}`, { 'http.response.status_code': value, 'server.port': value })
  }
  process.send({ port })
}

main().catch(() => {
  // Avoid leaking environment, child state, or exception stacks through the test runner.
  process.stderr.write('HTTP wire fixture failed\n')
  process.exitCode = 1
  process.disconnect?.()
})
