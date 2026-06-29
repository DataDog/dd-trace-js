'use strict'

const assert = require('node:assert/strict')
const { inspect } = require('node:util')

const { after, afterEach, before, beforeEach, describe, it } = require('mocha')

const agent = require('../../plugins/agent')
const { getWebSpan } = require('../utils')
const { storage } = require('../../../../datadog-core')
const iast = require('../../../src/appsec/iast')
const rewriter = require('../../../src/appsec/iast/taint-tracking/rewriter')
const overheadController = require('../../../src/appsec/iast/overhead-controller')
const vulnerabilityReporter = require('../../../src/appsec/iast/vulnerability-reporter')
const { getIastContext } = require('../../../src/appsec/iast/iast-context')
const { getRanges } = require('../../../src/appsec/iast/taint-tracking/operations')
const {
  HTTP_REQUEST_HEADER_VALUE,
  HTTP_REQUEST_URI,
} = require('../../../src/appsec/iast/taint-tracking/source-types')
const { getConfigFresh } = require('../../helpers/config')

function sourceTypeOf (value) {
  const iastContext = getIastContext(storage('legacy').getStore())
  const ranges = getRanges(iastContext, value)
  return ranges?.[0]?.iinfo.type
}

describe('IAST HTTP/2 server', () => {
  let http2
  let server
  let port
  // Installed per test; runs inside the request's async context.
  let handler

  before(() => {
    return agent.load(['http2', 'http'], { client: false }, { flushInterval: 1 }).then(() => {
      http2 = require('node:http2')
    })
  })

  beforeEach(() => {
    overheadController.clearGlobalRouteMap()
    vulnerabilityReporter.clearCache()
    const config = getConfigFresh({
      iast: {
        enabled: true,
        requestSampling: 100,
        maxConcurrentRequests: 100,
        maxContextOperations: 100,
      },
    })
    iast.enable(config)
    rewriter.enable(config)
  })

  afterEach(() => {
    iast.disable()
    rewriter.disable()
    handler = undefined
    server?.close()
    server = undefined
  })

  after(() => {
    return agent.close({ ritmReset: false })
  })

  function request (path, headers = {}) {
    return new Promise((resolve, reject) => {
      const client = http2.connect(`http://localhost:${port}`).on('error', reject)
      const req = client.request({ ':path': path, ':method': 'GET', ...headers })
      req.on('error', reject)
      req.on('end', () => {
        client.close()
        resolve()
      })
      req.resume()
      req.end()
    })
  }

  function listen (createServer) {
    return new Promise(resolve => {
      server = createServer()
      server.listen(0, 'localhost', () => {
        port = server.address().port
        resolve()
      })
    })
  }

  function getWebSpanFrom (traces) {
    const span = getWebSpan(traces)
    assert.strictEqual(span.metrics['_dd.iast.enabled'], 1, 'IAST was not armed for the request')
    return span
  }

  function assertVulnerability (traces, type) {
    const span = getWebSpanFrom(traces)
    assert.ok('_dd.iast.json' in span.meta, `No IAST report on span: ${inspect(span.meta)}`)
    const { vulnerabilities } = JSON.parse(span.meta['_dd.iast.json'])
    assert.ok(
      vulnerabilities.some(vulnerability => vulnerability.type === type),
      `No ${type} reported: ${inspect(vulnerabilities)}`
    )
  }

  describe('compatibility API (createServer(handler))', () => {
    beforeEach(() => listen(() => http2.createServer((req, res) => {
      handler(req, res)
      if (!res.headersSent) res.writeHead(200)
      res.end()
    })))

    it('taints the request header values', done => {
      let headerType
      handler = (req) => { headerType = sourceTypeOf(req.headers['x-custom']) }
      agent.assertSomeTraces(traces => {
        getWebSpanFrom(traces)
        assert.strictEqual(headerType, HTTP_REQUEST_HEADER_VALUE)
      }).then(done, done)
      request('/', { 'x-custom': 'aCustomValue' }).catch(done)
    })

    it('taints the request url', done => {
      let urlType
      handler = (req) => { urlType = sourceTypeOf(req.url) }
      agent.assertSomeTraces(traces => {
        getWebSpanFrom(traces)
        assert.strictEqual(urlType, HTTP_REQUEST_URI)
      }).then(done, done)
      request('/a-path').catch(done)
    })

    it('reports a response-side vulnerability (cookie without HttpOnly)', done => {
      handler = (req, res) => res.setHeader('set-cookie', 'session=abc')
      agent.assertSomeTraces(traces => assertVulnerability(traces, 'NO_HTTPONLY_COOKIE')).then(done, done)
      request('/').catch(done)
    })
  })

  describe('core API (server.on(\'stream\'))', () => {
    beforeEach(() => listen(() => {
      const coreServer = http2.createServer()
      coreServer.on('stream', (stream, headers) => {
        handler({ headers, url: headers[':path'] }, stream)
        if (!stream.headersSent) stream.respond({ ':status': 200 })
        stream.end()
      })
      return coreServer
    }))

    it('taints the request header values', done => {
      let headerType
      handler = (req) => { headerType = sourceTypeOf(req.headers['x-custom']) }
      agent.assertSomeTraces(traces => {
        getWebSpanFrom(traces)
        assert.strictEqual(headerType, HTTP_REQUEST_HEADER_VALUE)
      }).then(done, done)
      request('/', { 'x-custom': 'aCustomValue' }).catch(done)
    })

    // On the core API user code reads the `:path` pseudo-header directly; it is
    // tainted in place on the shared headers object as a header value. The
    // HTTP_REQUEST_URI taint applies to the adapter's `req.url`, which only the
    // tracer's own URL sinks observe, never user code.
    it('taints the :path pseudo-header', done => {
      let pathType
      handler = (req) => { pathType = sourceTypeOf(req.headers[':path']) }
      agent.assertSomeTraces(traces => {
        getWebSpanFrom(traces)
        assert.strictEqual(pathType, HTTP_REQUEST_HEADER_VALUE)
      }).then(done, done)
      request('/a-path').catch(done)
    })

    it('reports a response-side vulnerability (cookie without HttpOnly)', done => {
      handler = (req, stream) => stream.respond({ ':status': 200, 'set-cookie': 'session=abc' })
      agent.assertSomeTraces(traces => assertVulnerability(traces, 'NO_HTTPONLY_COOKIE')).then(done, done)
      request('/').catch(done)
    })

    it('reports no response-side vulnerability when respond carries no headers', done => {
      handler = (req, stream) => stream.respond()
      agent.assertSomeTraces(traces => {
        const span = getWebSpanFrom(traces)
        const iastJson = span.meta['_dd.iast.json'] || ''
        assert.ok(!iastJson.includes('NO_HTTPONLY_COOKIE'), `Unexpected report: ${iastJson}`)
      }).then(done, done)
      request('/').catch(done)
    })
  })
})
