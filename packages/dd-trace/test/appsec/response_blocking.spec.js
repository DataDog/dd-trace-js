'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { describe, it, beforeEach, afterEach, before, after } = require('mocha')
const sinon = require('sinon')

const agent = require('../plugins/agent')
const appsec = require('../../src/appsec')
const { getConfigFresh } = require('../helpers/config')
const WafContext = require('../../src/appsec/waf/waf_context_wrapper')

const HttpRequest = require('../setup/helpers/http-client')
const { blockedTemplateJson, setTestBlockingTemplates } = require('./utils')
const blockingResponse = JSON.parse(blockedTemplateJson)

describe('HTTP Response Blocking', () => {
  let server
  let responseHandler
  let httpRequest
  let tracer

  before(async () => {
    tracer = await agent.load('http', undefined, { inferredProxyServicesEnabled: true })

    const http = require('http')

    server = new http.Server((req, res) => {
      // little polyfill, older versions of node don't have setHeaders()
      if (typeof res.setHeaders !== 'function') {
        res.setHeaders = headers => headers.forEach((v, k) => res.setHeader(k, v))
      }

      if (responseHandler) {
        responseHandler(req, res)
      } else {
        res.writeHead(200)
        res.end('OK')
      }
    })

    await new Promise((resolve, reject) => {
      server.listen(0, 'localhost')
        .once('listening', (...args) => {
          const port = (/** @type {import('net').AddressInfo} */ (server.address())).port

          httpRequest = HttpRequest.create(({
            baseURL: `http://localhost:${port}`,
            validateStatus: null,
          }))

          resolve(...args)
        })
        .once('error', reject)
    })

    appsec.enable(getConfigFresh({
      inferredProxyServicesEnabled: true,
      appsec: {
        enabled: true,
        rules: path.join(__dirname, 'response_blocking_rules.json'),
        rasp: {
          enabled: false, // disable rasp to not trigger waf.run executions due to lfi
        },
        apiSecurity: {
          enabled: false,
        },
      },
    }))
    setTestBlockingTemplates()
  })

  beforeEach(() => {
    sinon.spy(WafContext.prototype, 'run')
  })

  afterEach(() => {
    sinon.restore()
    responseHandler = null
  })

  after(() => {
    appsec.disable()
    server?.close()
    return agent.close()
  })

  it('should block with implicit statusCode + setHeader() + end()', async () => {
    responseHandler = (req, res) => {
      res.statusCode = 404
      res.setHeader('k', '404')
      res.end('end')
    }

    const res = await httpRequest.get('/')

    assertBlocked(res)
  })

  it('should export the AppSec finding with the inferred proxy before an open child span finishes', async () => {
    /** @type {{ child?: import('../../src/opentracing/span') }} */
    const spans = {}
    let serverSpanId
    responseHandler = (req, res) => {
      const parent = tracer.scope().active()
      serverSpanId = parent.context().toSpanId()
      spans.child = tracer.startSpan('open-child', { childOf: parent })
      res.statusCode = 404
      res.setHeader('k', '404')
      res.end('end')
    }

    let findingTraceId
    try {
      const [res] = await Promise.all([
        httpRequest.get('/', {
          headers: {
            'x-dd-proxy': 'aws-apigateway',
            'x-dd-proxy-request-time-ms': '1729780025473',
            'x-dd-proxy-path': '/',
            'x-dd-proxy-httpmethod': 'GET',
            'x-dd-proxy-domain-name': 'example.com',
            'x-dd-proxy-stage': 'test',
          },
        }),
        agent.assertSomeTraces(traces => {
          const trace = traces.find(spans => spans.some(span => span.span_id.toString() === serverSpanId))
          assert.ok(trace)
          assert.equal(trace.length, 2)
          const [proxySpan, serverSpan] = trace
          assert.equal(proxySpan.name, 'aws.apigateway')
          assert.equal(serverSpan.span_id.toString(), serverSpanId)
          assert.equal(serverSpan.parent_id, proxySpan.span_id)
          assert.ok(proxySpan.meta['_dd.appsec.json'])
          assert.ok(serverSpan.meta['_dd.appsec.json'])
          findingTraceId = serverSpan.trace_id.toString()
        }),
      ])

      assertBlocked(res)
      assert.ok(spans.child)

      const childReceived = agent.assertSomeTraces(traces => {
        const span = traces.flat().find(span => span.name === 'open-child')
        assert.ok(span)
        assert.equal(span.trace_id.toString(), findingTraceId)
        assert.equal(span.parent_id.toString(), serverSpanId)
      })
      spans.child.finish()
      await childReceived
    } finally {
      spans.child?.finish()
    }
  })

  it('should keep a clean request buffered until its open child span finishes', async () => {
    /** @type {{ child?: import('../../src/opentracing/span') }} */
    const spans = {}
    let serverSpanId
    responseHandler = (req, res) => {
      const parent = tracer.scope().active()
      serverSpanId = parent.context().toSpanId()
      spans.child = tracer.startSpan('open-child', { childOf: parent })
      res.end('OK')
    }

    try {
      const res = await httpRequest.get('/')
      assert.equal(res.status, 200)
      assert.ok(spans.child)

      const traceReceived = agent.assertSomeTraces(traces => {
        const trace = traces.find(spans => spans.some(span => span.name === 'open-child'))
        assert.ok(trace)
        const serverSpan = trace.find(span => span.span_id.toString() === serverSpanId)
        assert.ok(serverSpan)
        assert.equal(serverSpan.meta['_dd.appsec.json'], undefined)
      })
      spans.child.finish()
      await traceReceived
    } finally {
      spans.child?.finish()
    }
  })

  it('should block with setHeader() + setHeaders() + writeHead() headers', async () => {
    responseHandler = (req, res) => {
      res.setHeaders(new Map(Object.entries({ a: 'bad1', b: 'good' })))
      res.setHeader('c', 'bad2')
      res.writeHead(200, { d: 'bad3' })
      res.end('end')
    }

    const res = await httpRequest.get('/')

    assertBlocked(res)
  })

  it('should block with setHeader() + array writeHead() ', async () => {
    responseHandler = (req, res) => {
      res.setHeader('a', 'bad1')
      res.writeHead(200, 'OK', ['b', 'bad2', 'c', 'bad3'])
      res.end('end')
    }

    const res = await httpRequest.get('/')

    assertBlocked(res)
  })

  it('should not block with array writeHead() when attack is in the header name and not in header value', async () => {
    responseHandler = (req, res) => {
      res.writeHead(200, 'OK', ['a', 'bad1', 'b', 'bad2', 'bad3', 'c'])
      res.end('end')
    }

    const res = await httpRequest.get('/')

    assert.equal(res.status, 200)
    assert.deepStrictEqual([
      'a',
      'b',
      'bad3',
      'connection',
      'date',
      'transfer-encoding',
    ], Object.keys(cloneHeaders(res.headers)).sort())
    assert.deepEqual(res.data, 'end')
  })

  it('should block with implicit statusCode + setHeader() + flushHeaders()', async () => {
    responseHandler = (req, res) => {
      res.statusCode = 404
      res.setHeader('k', '404')
      res.flushHeaders()
      res.end('end')
    }

    const res = await httpRequest.get('/')

    assertBlocked(res)
  })

  it('should block with implicit statusCode + setHeader() + write()', async () => {
    responseHandler = (req, res) => {
      res.statusCode = 404
      res.setHeader('k', '404')
      res.write('write')
      res.end('end')
    }

    const res = await httpRequest.get('/')

    assertBlocked(res)
  })

  it('should block with implicit statusCode + setHeader() + stream pipe', async () => {
    responseHandler = (req, res) => {
      res.statusCode = 404
      res.setHeader('k', '404')
      streamFile(res)
    }

    const res = await httpRequest.get('/')

    assertBlocked(res)
  })

  it('should block with writeHead() + write()', async () => {
    responseHandler = (req, res) => {
      res.writeHead(404, { k: '404' })
      res.write('write')
      res.end('end')
    }

    const res = await httpRequest.get('/')

    assertBlocked(res)
  })

  it('should block with every methods combined', async () => {
    responseHandler = (req, res) => {
      res.setHeaders(new Map(Object.entries({ a: 'bad1', b: 'good' })))
      res.setHeader('c', 'bad2')
      res.setHeader('d', 'good')
      res.writeHead(200, 'OK', { d: 'good', e: 'bad3' })
      res.flushHeaders()
      res.write('write')
      res.addTrailers({ k: 'v' })
      streamFile(res)
    }

    const res = await httpRequest.get('/')

    assertBlocked(res)
  })

  it('should not block with every methods combined but no attack', async () => {
    responseHandler = (req, res) => {
      res.setHeaders(new Map(Object.entries({ a: 'good', b: 'good' })))
      res.setHeader('c', 'good')
      res.setHeader('d', 'good')
      res.writeHead(201, 'OK', { d: 'good', e: 'good' })
      res.flushHeaders()
      res.write('write')
      res.addTrailers({ k: 'v' })
      streamFile(res)
    }

    const res = await httpRequest.get('/')

    assert.equal(res.status, 201)
    assert.deepStrictEqual([
      'a',
      'b',
      'c',
      'connection',
      'd',
      'date',
      'e',
      'transfer-encoding',
    ], Object.keys(cloneHeaders(res.headers)).sort())
    assert.deepEqual(res.data, 'writefileend')
  })

  it('should ignore subsequent response writes after blocking', async () => {
    responseHandler = (req, res) => {
      res.statusCode = 404
      res.setHeader('k', '404')
      res.flushHeaders()
      res.writeHead(200, { k: '200' })
      res.write('write1')
      setTimeout(() => {
        res.write('write2')
        res.end('end')
      }, 1000)
    }

    const res = await httpRequest.get('/')

    assertBlocked(res)
  })
})

function cloneHeaders (headers) {
  // clone the headers accessor to a flat object
  // and delete the keep-alive header as it's not always present
  headers = Object.fromEntries(Object.entries(headers))
  delete headers['keep-alive']

  return headers
}

function assertBlocked (res) {
  assert.equal(res.status, 403)
  assert.deepStrictEqual([
    'connection',
    'content-length',
    'content-type',
    'date',
  ], Object.keys(cloneHeaders(res.headers)).sort())
  assert.deepEqual(res.data, blockingResponse)

  sinon.assert.callCount(WafContext.prototype.run, 2)
}

function streamFile (res) {
  const stream = fs.createReadStream(path.join(__dirname, 'streamtest.txt'), { encoding: 'utf8' })
  stream.pipe(res, { end: false })
  stream.on('end', () => res.end('end'))
}
