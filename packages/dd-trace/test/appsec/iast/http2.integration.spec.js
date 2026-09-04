'use strict'

const assert = require('node:assert/strict')
const { closeSync, openSync, readFileSync } = require('node:fs')
const { open } = require('node:fs/promises')
const path = require('node:path')
const { inspect } = require('node:util')

const dc = require('dc-polyfill')
const { after, afterEach, before, beforeEach, describe, it } = require('mocha')
const semver = require('semver')

const { engines, nodeMaxMajor } = require('../../../../../package.json')
const { NODE_MAJOR, NODE_MINOR } = require('../../../../../version')
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
const { isTrue } = require('../../../src/guardrails/util')
const { getConfigFresh } = require('../../helpers/config')

const runtimeSupported = isTrue(process.env.DD_INJECT_FORCE) ||
  semver.satisfies(process.version, `${engines.node} <${nodeMaxMajor}`)
const describeSupported = runtimeSupported ? describe : describe.skip
const supportsRawResponseHeaders = NODE_MAJOR >= 25 ||
  (NODE_MAJOR === 24 && NODE_MINOR >= 7) ||
  (NODE_MAJOR === 22 && NODE_MINOR >= 20)
const describeRawResponseHeaders = supportsRawResponseHeaders ? describe : describe.skip
const serverKey = readFileSync(path.join(__dirname, '../../../../datadog-plugin-http2/test/ssl/test.key'))
const serverCert = readFileSync(path.join(__dirname, '../../../../datadog-plugin-http2/test/ssl/test.crt'))
const responseSetHeaderFinishChannel = dc.channel('datadog:http:server:response:set-header:finish')
const setCookieChannel = dc.channel('datadog:iast:set-cookie')

function sourceTypeOf (value) {
  const iastContext = getIastContext(storage('legacy').getStore())
  const ranges = getRanges(iastContext, value)
  return ranges?.[0]?.iinfo.type
}

/**
 * @param {number} [requestSampling]
 * @param {number} [maxConcurrentRequests]
 */
function enableIast (requestSampling = 100, maxConcurrentRequests = 100) {
  const config = getConfigFresh({
    iast: {
      enabled: true,
      requestSampling,
      maxConcurrentRequests,
      maxContextOperations: 100,
    },
  })
  iast.enable(config)
  rewriter.enable(config)
}

describeSupported('IAST HTTP/2 server', () => {
  let http2
  let server
  let port
  // Installed per test; runs inside the request's async context.
  let handler

  before(async () => {
    await agent.load(['http2', 'http'], { client: false }, { flushInterval: 1 })
    http2 = require('node:http2')
  })

  beforeEach(() => {
    overheadController.clearGlobalRouteMap()
    vulnerabilityReporter.clearCache()
    enableIast()
  })

  afterEach(async () => {
    iast.disable()
    rewriter.disable()
    handler = undefined
    if (server) {
      await new Promise(resolve => server.close(resolve))
    }
    server = undefined
  })

  after(() => {
    return agent.close({ ritmReset: false })
  })

  /**
   * @param {string} path
   * @param {import('node:http2').OutgoingHttpHeaders} [headers]
   * @param {boolean} [secure]
   * @returns {Promise<void>}
   */
  function request (path, headers = {}, secure = false) {
    return new Promise((resolve, reject) => {
      const protocol = secure ? 'https' : 'http'
      const options = secure ? { rejectUnauthorized: false } : undefined
      const client = http2.connect(`${protocol}://localhost:${port}`, options).on('error', reject)
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

  /**
   * @param {(traces: object[][]) => void} assertTraces
   * @param {string} [path]
   */
  function requestAndAssertTraces (assertTraces, path = '/') {
    return Promise.all([
      agent.assertSomeTraces(assertTraces),
      request(path),
    ])
  }

  /**
   * @param {string} path
   * @param {(req: { headers: import('node:http2').IncomingHttpHeaders, url?: string }) => unknown} readValue
   * @param {string | undefined} expectedType
   * @param {import('node:http2').OutgoingHttpHeaders} [headers]
   * @param {number} [expectedEnabled]
   */
  function assertSource (path, readValue, expectedType, headers = {}, expectedEnabled = 1) {
    let actualType
    handler = req => { actualType = sourceTypeOf(readValue(req)) }
    return Promise.all([
      agent.assertSomeTraces(traces => {
        const span = getWebSpan(traces)
        assert.strictEqual(span.metrics['_dd.iast.enabled'], expectedEnabled)
        assert.strictEqual(actualType, expectedType)
      }),
      request(path, headers),
    ])
  }

  describe('compatibility API (createServer(handler))', () => {
    beforeEach(() => listen(() => http2.createServer((req, res) => {
      handler(req, res)
      if (!res.headersSent) res.writeHead(200)
      res.end()
    })))

    it('taints the request header values', async () => {
      await assertSource('/', req => req.headers['x-custom'], HTTP_REQUEST_HEADER_VALUE, {
        'x-custom': 'aCustomValue',
      })
    })

    it('taints the request url', async () => {
      await assertSource('/a-path', req => req.url, HTTP_REQUEST_URI)
    })

    it('reports a response-side vulnerability (cookie without HttpOnly)', async () => {
      handler = (req, res) => res.setHeader('set-cookie', 'session=abc')
      await requestAndAssertTraces(traces => assertVulnerability(traces, 'NO_HTTPONLY_COOKIE'))
    })

    it('normalizes response header names before sink publication', async () => {
      handler = (req, res) => res.setHeader(' Set-Cookie ', 'session=abc')
      await requestAndAssertTraces(traces => assertVulnerability(traces, 'NO_HTTPONLY_COOKIE'))
    })

    it('analyzes in-place response header array mutations before commit', async () => {
      handler = (req, res) => {
        const cookies = ['first=1; HttpOnly']
        res.setHeader('set-cookie', cookies)
        cookies.push('second=2')
      }
      await requestAndAssertTraces(traces => assertVulnerability(traces, 'NO_HTTPONLY_COOKIE'))
    })

    it('continues cookie analysis after a numeric value', async () => {
      handler = (req, res) => {
        res.setHeader('set-cookie', 42)
        res.setHeader('set-cookie', 'session=abc')
      }
      await requestAndAssertTraces(traces => assertVulnerability(traces, 'NO_HTTPONLY_COOKIE'))
    })

    it('reports a response-side vulnerability from writeHead headers', async () => {
      handler = (req, res) => res.writeHead(200, 'OK', { 'set-cookie': 'session=abc' })
      await requestAndAssertTraces(traces => assertVulnerability(traces, 'NO_HTTPONLY_COOKIE'))
    })

    it('reports a response-side vulnerability from duplicate writeHead header pairs', async () => {
      handler = (req, res) => {
        res.writeHead(200, [
          ['set-cookie', 'session=abc'],
          ['set-cookie', ['second=value', 'third=value']],
          ['set-cookie', 'fourth=value'],
        ])
      }
      await requestAndAssertTraces(traces => assertVulnerability(traces, 'NO_HTTPONLY_COOKIE'))
    })

    it('reports a response-side vulnerability from raw writeHead headers', async () => {
      handler = (req, res) => res.writeHead(200, ['set-cookie', 'session=abc'])
      await requestAndAssertTraces(traces => assertVulnerability(traces, 'NO_HTTPONLY_COOKIE'))
    })
  })

  describe('mixed compatibility and core APIs', () => {
    beforeEach(() => listen(() => {
      const mixedServer = http2.createServer((req, res) => {
        handler(req, res)
        res.end()
      })
      mixedServer.on('stream', () => {})
      return mixedServer
    }))

    it('taints the compatibility request url as a URI', async () => {
      await assertSource('/a-path', req => req.url, HTTP_REQUEST_URI)
    })

    it('leaves the compatibility request untainted when IAST capacity is exhausted', async () => {
      iast.disable()
      rewriter.disable()
      enableIast(100, 0)

      await assertSource('/an-unacquired-path', req => req.url, undefined, {}, 0)
    })

    it('analyzes only newly appended response cookies after adoption', async () => {
      const analyzedCookies = []
      const onSetCookie = ({ cookieString }) => analyzedCookies.push(cookieString)
      const publishedHeaders = []
      const onSetHeader = data => {
        if (data.name === 'set-cookie') publishedHeaders.push(data)
      }
      const cookies = ['first=1; HttpOnly']
      handler = (req, res) => {
        res.setHeader('set-cookie', cookies)
        cookies.push('second=2; HttpOnly')
      }
      responseSetHeaderFinishChannel.subscribe(onSetHeader)
      setCookieChannel.subscribe(onSetCookie)

      try {
        await request('/')
      } finally {
        responseSetHeaderFinishChannel.unsubscribe(onSetHeader)
        setCookieChannel.unsubscribe(onSetCookie)
      }

      assert.strictEqual(publishedHeaders.length, 2)
      assert.strictEqual(publishedHeaders[0].res, publishedHeaders[1].res)
      assert.deepStrictEqual(analyzedCookies, cookies)
    })
  })

  describe('mixed compatibility and core APIs with a core listener first', () => {
    beforeEach(() => listen(() => {
      const mixedServer = http2.createServer()
      mixedServer.prependListener('stream', stream => {
        stream.respond({ ':status': 200, 'content-type': 'text/html' })
        stream.end()
      })
      mixedServer.on('request', () => {})
      return mixedServer
    }))

    it('reports a missing response header from the core response', async () => {
      await requestAndAssertTraces(traces => assertVulnerability(traces, 'XCONTENTTYPE_HEADER_MISSING'))
    })
  })

  describe('core API (server.on(\'stream\'))', () => {
    beforeEach(() => listen(() => {
      const coreServer = http2.createServer()
      coreServer.on('stream', (stream, headers) => {
        const responseHandled = handler({ headers, url: headers[':path'] }, stream)
        if (!responseHandled) {
          if (!stream.headersSent) stream.respond({ ':status': 200 })
          stream.end()
        }
      })
      return coreServer
    }))

    it('taints the request header values', async () => {
      await assertSource('/', req => req.headers['x-custom'], HTTP_REQUEST_HEADER_VALUE, {
        'x-custom': 'aCustomValue',
      })
    })

    // On the core API user code reads the `:path` pseudo-header directly; it is
    // tainted in place on the shared headers object as a header value. The
    // HTTP_REQUEST_URI taint applies to the adapter's `req.url`, which only the
    // tracer's own URL sinks observe, never user code.
    it('taints the :path pseudo-header', async () => {
      await assertSource('/a-path', req => req.headers[':path'], HTTP_REQUEST_HEADER_VALUE)
    })

    it('reports a response-side vulnerability (cookie without HttpOnly)', async () => {
      handler = (req, stream) => stream.respond({ ':status': 200, 'set-cookie': 'session=abc' })
      await requestAndAssertTraces(traces => assertVulnerability(traces, 'NO_HTTPONLY_COOKIE'))
    })

    describeRawResponseHeaders('raw response headers', () => {
      it('reports a response-side vulnerability (cookie without HttpOnly)', async () => {
        handler = (req, stream) => stream.respond([':status', 200, 'set-cookie', 'session=abc'])
        await requestAndAssertTraces(traces => assertVulnerability(traces, 'NO_HTTPONLY_COOKIE'))
      })

      it('reports a response-side vulnerability from immutable complete headers', async () => {
        handler = (req, stream) => stream.respond(Object.freeze([
          ':status', 200,
          'date', 'Thu, 01 Jan 1970 00:00:00 GMT',
          'set-cookie', 'session=abc',
        ]))
        await requestAndAssertTraces(traces => assertVulnerability(traces, 'NO_HTTPONLY_COOKIE'))
      })
    })

    it('reports no response-side vulnerability when respond carries no headers', async () => {
      handler = (req, stream) => stream.respond()
      await requestAndAssertTraces(traces => {
        const span = getWebSpanFrom(traces)
        const iastJson = span.meta['_dd.iast.json'] || ''
        assert.ok(!iastJson.includes('NO_HTTPONLY_COOKIE'), `Unexpected report: ${iastJson}`)
      })
    })

    it('reports a response-side vulnerability from respondWithFile headers', async () => {
      handler = (req, stream) => {
        stream.respondWithFile(__filename, { ':status': 200, 'set-cookie': 'session=abc' })
        return true
      }
      await requestAndAssertTraces(traces => assertVulnerability(traces, 'NO_HTTPONLY_COOKIE'))
    })

    it('does not inspect respondWithFile headers when opening the file fails', async () => {
      handler = (req, stream) => {
        stream.respondWithFile(`${__filename}.missing`, { ':status': 200, 'set-cookie': 'session=abc' }, {
          onError () {
            stream.respond({ ':status': 200 })
            stream.end()
          },
        })
        return true
      }
      await requestAndAssertTraces(traces => {
        const span = getWebSpanFrom(traces)
        const iastJson = span.meta['_dd.iast.json'] || ''
        assert.ok(!iastJson.includes('NO_HTTPONLY_COOKIE'), `Unexpected report: ${iastJson}`)
      })
    })

    it('inspects respondWithFile headers after statCheck mutates them', async () => {
      handler = (req, stream) => {
        stream.respondWithFile(__filename, { ':status': 200 }, {
          statCheck (stat, headers) {
            headers['set-cookie'] = 'session=abc'
            return true
          },
        })
        return true
      }
      await requestAndAssertTraces(traces => assertVulnerability(traces, 'NO_HTTPONLY_COOKIE'))
    })

    it('does not inspect replaced respondWithFile headers before statCheck returns', async () => {
      handler = (req, stream) => {
        stream.respondWithFile(__filename, { ':status': 200, 'set-cookie': 'session=abc' }, {
          statCheck (stat, headers) {
            delete headers['set-cookie']
            return true
          },
        })
        return true
      }
      await requestAndAssertTraces(traces => {
        const span = getWebSpanFrom(traces)
        const iastJson = span.meta['_dd.iast.json'] || ''
        assert.ok(!iastJson.includes('NO_HTTPONLY_COOKIE'), `Unexpected report: ${iastJson}`)
      })
    })

    it('reports a response-side vulnerability from respondWithFD headers', async () => {
      handler = (req, stream) => {
        const fileDescriptor = openSync(__filename, 'r')
        stream.once('close', () => closeSync(fileDescriptor))
        stream.respondWithFD(fileDescriptor, { ':status': 200, 'set-cookie': 'session=abc' })
        return true
      }
      await requestAndAssertTraces(traces => assertVulnerability(traces, 'NO_HTTPONLY_COOKIE'))
    })

    it('reports a response-side vulnerability from FileHandle respondWithFD headers', async () => {
      const fileHandle = await open(__filename, 'r')
      try {
        handler = (req, stream) => {
          stream.respondWithFD(fileHandle, { ':status': 200, 'set-cookie': 'session=abc' })
          return true
        }
        await requestAndAssertTraces(traces => assertVulnerability(traces, 'NO_HTTPONLY_COOKIE'))
      } finally {
        await fileHandle.close()
      }
    })

    it('inspects respondWithFD headers after statCheck mutates them', async () => {
      handler = (req, stream) => {
        const fileDescriptor = openSync(__filename, 'r')
        stream.once('close', () => closeSync(fileDescriptor))
        stream.respondWithFD(fileDescriptor, { ':status': 200 }, {
          statCheck (stat, headers) {
            headers['set-cookie'] = 'session=abc'
            return true
          },
        })
        return true
      }
      await requestAndAssertTraces(traces => assertVulnerability(traces, 'NO_HTTPONLY_COOKIE'))
    })
  })

  describe('secure core API (secureServer.on(\'stream\'))', () => {
    beforeEach(() => listen(() => {
      const secureServer = http2.createSecureServer({ cert: serverCert, key: serverKey })
      secureServer.on('stream', stream => {
        stream.respond({ ':status': 200, 'content-type': 'text/html' })
        stream.end()
      })
      return secureServer
    }))

    it('reports a missing HSTS header', async () => {
      await Promise.all([
        agent.assertSomeTraces(traces => assertVulnerability(traces, 'HSTS_HEADER_MISSING')),
        request('/', {}, true),
      ])
    })
  })
})
