'use strict'

const assert = require('node:assert/strict')
const { closeSync, openSync } = require('node:fs')
const path = require('node:path')

const { after, afterEach, before, describe, it } = require('mocha')
const semver = require('semver')

const { engines, nodeMaxMajor } = require('../../../../package.json')
const { NODE_MAJOR, NODE_MINOR } = require('../../../../version')
const { FOREIGN_HTTP2_SERVER } = require('../../src/constants')
const appsec = require('../../src/appsec')
const {
  bodyParser,
  cookieParser,
  expressProcessParams,
  expressSession,
  queryParser,
  responseBody,
} = require('../../src/appsec/channels')
const { getConfigFresh } = require('../helpers/config')
const agent = require('../plugins/agent')
const { blockedTemplateJson, setTestBlockingTemplates } = require('./utils')

const PRESERVES_DUPLICATE_HEADERS = NODE_MAJOR >= 22 ||
  (NODE_MAJOR === 21 && NODE_MINOR >= 7) ||
  (NODE_MAJOR === 20 && NODE_MINOR >= 12)
const runtimeSupported = Boolean(process.env.DD_INJECT_FORCE) ||
  semver.satisfies(process.version, `${engines.node} <${nodeMaxMajor}`)
const describeSupported = runtimeSupported ? describe : describe.skip

describeSupported('AppSec HTTP/2 response blocking', () => {
  let http2
  let server
  let port

  before(async () => {
    await agent.load(['http2', 'http'], { client: false })
    http2 = require('node:http2')
    appsec.enable(getConfigFresh({
      appsec: {
        enabled: true,
        rules: path.join(__dirname, 'response_blocking_rules.json'),
        rasp: {
          enabled: false,
        },
        apiSecurity: {
          enabled: true,
        },
      },
    }))
    setTestBlockingTemplates()
  })

  afterEach(async () => {
    if (server) {
      await new Promise(resolve => server.close(resolve))
    }
    server = undefined
  })

  after(() => {
    appsec.disable()
    return agent.close()
  })

  /**
   * @param {() => import('node:http2').Http2Server} createServer
   * @returns {Promise<void>}
   */
  function listen (createServer) {
    return new Promise(resolve => {
      server = createServer()
      server.listen(0, 'localhost', () => {
        port = server.address().port
        resolve()
      })
    })
  }

  /**
   * @param {(stream: import('node:http2').ServerHttp2Stream,
   *   headers: import('node:http2').IncomingHttpHeaders) => void} handler
   */
  function listenCore (handler) {
    return listen(() => {
      const coreServer = http2.createServer()
      coreServer.on('stream', handler)
      return coreServer
    })
  }

  /**
   * @param {string} [requestPath]
   * @returns {Promise<{
   *   body: string,
   *   headers: import('node:http2').IncomingHttpHeaders,
   *   informationalHeaders: import('node:http2').IncomingHttpHeaders[]
   * }>}
   */
  function request (requestPath = '/') {
    return new Promise((resolve, reject) => {
      const client = http2.connect(`http://localhost:${port}`).once('error', reject)
      const stream = client.request({ ':path': requestPath })
      const chunks = []
      const informationalHeaders = []
      let responseHeaders

      stream.on('headers', headers => {
        informationalHeaders.push(headers)
      })
      stream.once('response', headers => {
        responseHeaders = headers
      })
      stream.on('data', chunk => {
        chunks.push(chunk)
      })
      stream.once('error', reject)
      stream.once('end', () => {
        client.close()
        resolve({
          body: Buffer.concat(chunks).toString(),
          headers: responseHeaders,
          informationalHeaders,
        })
      })
      stream.end()
    })
  }

  /**
   * @param {import('node:http2').ServerHttp2Stream} stream
   * @param {Record<string, string | number | string[]>} headers
   * @param {object} options
   * @param {Function | RegExp | Record<string, string | RegExp>} expected
   */
  function assertInvalidFileDescriptorResponse (stream, headers, options, expected) {
    const fileDescriptor = openSync(__filename, 'r')
    try {
      assert.throws(() => stream.respondWithFD(fileDescriptor, headers, options), expected)
    } finally {
      closeSync(fileDescriptor)
    }
  }

  it('blocks compatibility responses and suppresses subsequent writes', async () => {
    await listen(() => http2.createServer((req, res) => {
      res.writeHead(404, { k: '404' })
      res.removeHeader('k')
      res.setHeader('after-block', 'ignored')
      res.writeContinue()
      res.writeEarlyHints({ link: '</style.css>; rel=preload; as=style' })
      res.write('ignored')
      res.end('ignored')
    }))

    const { body, headers } = await request()

    assert.strictEqual(headers[':status'], 403)
    assert.strictEqual(headers['after-block'], undefined)
    assert.strictEqual(body, blockedTemplateJson)
  })

  it('allows compatibility response operations before the final response', async () => {
    await listen(() => http2.createServer((req, res) => {
      res.setHeader('removed', 'value')
      res.removeHeader('removed')
      res.writeContinue()
      res.writeEarlyHints({ link: '</style.css>; rel=preload; as=style' })
      res.end('body')
    }))

    const { body, headers, informationalHeaders } = await request()

    assert.strictEqual(headers[':status'], 200)
    assert.strictEqual(headers.removed, undefined)
    assert.strictEqual(body, 'body')
    assert.deepStrictEqual(informationalHeaders.map(headers => headers[':status']), [100, 103])
  })

  it('keeps request-start data available when a mixed compatibility request ends', async () => {
    await listen(() => {
      const mixedServer = http2.createServer((req, res) => {
        req.body = { value: 'mixed-context-body' }
        bodyParser.publish({ req, res, body: req.body })
        cookieParser.publish({ req, res, cookies: { value: 'mixed-context-cookie' } })
        queryParser.publish({ req, res, query: { value: 'mixed-context-query' } })
        expressProcessParams.publish({ req, res, params: { value: 'mixed-context-param' } })
        responseBody.publish({ req, res, body: { value: 'mixed-context-response' } })
        res.end()
      })
      mixedServer.on('stream', () => {})
      return mixedServer
    })

    const traceAsserted = agent.assertFirstTraceSpan(span => {
      const { triggers } = JSON.parse(span.meta['_dd.appsec.json'])
      assert.ok(triggers.some(trigger => trigger.rule.id === 'mixed-http2-context'))
    })

    await Promise.all([traceAsserted, request('/mixed-context')])
  })

  it('uses one WAF context for mixed request-start and session data', async () => {
    await listen(() => {
      const mixedServer = http2.createServer((req, res) => {
        const abortController = new AbortController()
        expressSession.publish({ req, res, sessionId: 'mixed-http2-session', abortController })
        if (abortController.signal.aborted) return

        if (!res.writableEnded) {
          res.end('unblocked')
        }
      })
      mixedServer.on('stream', () => {})
      return mixedServer
    })

    const traceAsserted = agent.assertFirstTraceSpan(span => {
      const { triggers } = JSON.parse(span.meta['_dd.appsec.json'])
      assert.ok(triggers.some(trigger => trigger.rule.id === 'mixed-http2-session'))
    })

    const [, { body, headers }] = await Promise.all([traceAsserted, request('/mixed-session')])

    assert.strictEqual(headers[':status'], 403)
    assert.strictEqual(body, blockedTemplateJson)
  })

  it('blocks core stream responses and suppresses subsequent writes', async () => {
    await listenCore(stream => {
      const fileDescriptor = openSync(__filename, 'r')
      stream.once('close', () => closeSync(fileDescriptor))
      stream.respond({ ':status': 404, k: '404' })
      stream.additionalHeaders({ ':status': 103, link: '</style.css>; rel=preload; as=style' })
      stream.respond({ ':status': 200 })
      stream.respondWithFD(fileDescriptor, { ':status': 200 })
      stream.respondWithFile(__filename, { ':status': 200 })
      stream.write('ignored')
      stream.end('ignored')
    })

    const { body, headers } = await request()

    assert.strictEqual(headers[':status'], 403)
    assert.strictEqual(body, blockedTemplateJson)
  })

  it('allows core informational responses before the final response', async () => {
    await listenCore(stream => {
      stream.additionalHeaders({ ':status': 103, link: '</style.css>; rel=preload; as=style' })
      stream.respond({ ':status': 200 })
      stream.end('body')
    })

    const { body, headers, informationalHeaders } = await request()

    assert.strictEqual(headers[':status'], 200)
    assert.strictEqual(body, 'body')
    assert.strictEqual(informationalHeaders.length, 1)
    assert.strictEqual(informationalHeaders[0][':status'], 103)
  })

  it('allows core stream writes before respond', async () => {
    await listenCore(stream => {
      stream.write('body')
      stream.end()
    })

    const { body, headers } = await request()

    assert.strictEqual(headers[':status'], 200)
    assert.strictEqual(body, 'body')
  })

  it('allows core stream ends before respond', async () => {
    await listenCore(stream => stream.end('body'))

    const { body, headers } = await request()

    assert.strictEqual(headers[':status'], 200)
    assert.strictEqual(body, 'body')
  })

  it('preserves headers-sent errors for tracked core response methods', async () => {
    await listenCore(stream => {
      const fileDescriptor = openSync(__filename, 'r')
      stream.respond({ ':status': 200 })

      assert.throws(() => stream.respond({ ':status': 200 }), { code: 'ERR_HTTP2_HEADERS_SENT' })
      assert.throws(
        () => stream.respondWithFD(fileDescriptor, { ':status': 200 }),
        { code: 'ERR_HTTP2_HEADERS_SENT' }
      )
      assert.throws(
        () => stream.respondWithFile(__filename, { ':status': 200 }),
        { code: 'ERR_HTTP2_HEADERS_SENT' }
      )

      closeSync(fileDescriptor)
      stream.write('body')
      stream.end()
    })

    const { body, headers } = await request()

    assert.strictEqual(headers[':status'], 200)
    assert.strictEqual(body, 'body')
  })

  it('preserves invalid options errors for tracked file response methods', async () => {
    await listenCore(stream => {
      const fileDescriptor = openSync(__filename, 'r')

      assert.throws(() => stream.respondWithFD(fileDescriptor, {}, null), TypeError)
      assert.throws(() => stream.respondWithFile(__filename, {}, null), TypeError)
      assert.throws(
        () => stream.respondWithFD(fileDescriptor, {}, { statCheck: true }),
        { code: 'ERR_INVALID_ARG_VALUE' }
      )
      assert.throws(
        () => stream.respondWithFile(__filename, {}, { statCheck: true }),
        { code: 'ERR_INVALID_ARG_VALUE' }
      )

      closeSync(fileDescriptor)
      stream.respond({ ':status': 200 })
      stream.end('body')
    })

    const { body, headers } = await request()

    assert.strictEqual(headers[':status'], 200)
    assert.strictEqual(body, 'body')
  })

  it('validates rejected core responses before analyzing their headers', async () => {
    await listenCore((stream, headers) => {
      const requestPath = headers[':path']

      if (requestPath === '/status') {
        assert.throws(
          () => stream.respond({ ':status': 199, k: '404' }),
          { code: 'ERR_HTTP2_STATUS_INVALID' }
        )
      } else if (requestPath === '/header') {
        assert.throws(
          () => stream.respond({ ':status': 404, connection: 'close', k: '404' }),
          { code: 'ERR_HTTP2_INVALID_CONNECTION_HEADERS' }
        )
      } else if (requestPath === '/options') {
        assert.throws(
          () => stream.respond({ ':status': 200 }, null),
          { code: 'ERR_INVALID_ARG_TYPE' }
        )
      } else if (requestPath === '/options-accessor') {
        const options = {}
        Object.defineProperty(options, 'sendDate', {
          enumerable: true,
          get () {
            throw new Error('invalid options getter')
          },
        })
        assert.throws(
          () => stream.respond({ ':status': 404, k: '404' }, options),
          { message: 'invalid options getter' }
        )
      } else if (requestPath === '/header-accessor') {
        const responseHeaders = { ':status': 404, k: '404' }
        Object.defineProperty(responseHeaders, 'getter', {
          enumerable: true,
          get () {
            throw new Error('invalid header getter')
          },
        })
        assert.throws(
          () => stream.respond(responseHeaders),
          { message: 'invalid header getter' }
        )
      } else if (requestPath === '/pseudo-header') {
        assert.throws(
          () => stream.respond({ ':status': 404, ':path': '/', k: '404' }),
          { code: 'ERR_HTTP2_INVALID_PSEUDOHEADER' }
        )
      } else if (requestPath === '/header-name') {
        assert.throws(
          () => stream.respond({ ':status': 404, 'invalid header': 'value', k: '404' }),
          { code: 'ERR_INVALID_HTTP_TOKEN' }
        )
      } else if (requestPath === '/te') {
        assert.throws(
          () => stream.respond({ ':status': 404, k: '404', te: 'gzip' }),
          { code: 'ERR_HTTP2_INVALID_CONNECTION_HEADERS' }
        )
      } else if (requestPath === '/sensitive-headers') {
        const responseHeaders = { ':status': 404, k: '404' }
        responseHeaders[http2.sensitiveHeaders] = true
        assert.throws(
          () => stream.respond(responseHeaders),
          { code: 'ERR_INVALID_ARG_VALUE' }
        )
      } else if (requestPath === '/sensitive-header-name') {
        const responseHeaders = { ':status': 404, k: '404' }
        responseHeaders[http2.sensitiveHeaders] = [1]
        assert.throws(() => stream.respond(responseHeaders), TypeError)
      } else if (requestPath === '/sensitive-header-accessor') {
        const responseHeaders = { ':status': 404, k: '404' }
        Object.defineProperty(responseHeaders, http2.sensitiveHeaders, {
          get () {
            throw new Error('invalid sensitive header getter')
          },
        })
        assert.throws(
          () => stream.respond(responseHeaders),
          { message: 'invalid sensitive header getter' }
        )
      } else if (requestPath === '/header-value') {
        const value = {
          toString () {
            throw new Error('invalid header value')
          },
        }
        assert.throws(
          () => stream.respond({ ':status': 404, k: '404', value }),
          { message: 'invalid header value' }
        )
      } else if (requestPath === '/raw-headers') {
        assert.throws(
          () => stream.respond([[':status', 404], ['k', '404']]),
          TypeError
        )
      } else if (requestPath === '/raw-header-name') {
        assert.throws(
          () => stream.respond([1, 'value', ':status', 404, 'k', '404']),
          TypeError
        )
      } else if (requestPath === '/single-value-header') {
        assert.throws(
          () => stream.respond({ ':status': 404, k: '404', 'content-type': ['a', 'b'] }),
          { code: 'ERR_HTTP2_HEADER_SINGLE_VALUE' }
        )
      } else if (requestPath === '/sensitive-empty') {
        const responseHeaders = { ':status': 404, k: '404' }
        responseHeaders[http2.sensitiveHeaders] = []
        stream.respond(responseHeaders)
      } else if (requestPath === '/ignored-headers') {
        stream.respond({ ':status': 404, k: '404', '': 'ignored', empty: [], missing: undefined })
      } else if (requestPath === '/fd-offset') {
        assertInvalidFileDescriptorResponse(
          stream,
          { ':status': 404, k: '404' },
          { offset: 'invalid' },
          { code: 'ERR_INVALID_ARG_VALUE' }
        )
      } else if (requestPath === '/fd-length') {
        assertInvalidFileDescriptorResponse(
          stream,
          { ':status': 404, k: '404' },
          { length: 'invalid' },
          { code: 'ERR_INVALID_ARG_VALUE' }
        )
      } else if (requestPath === '/fd-payload') {
        assertInvalidFileDescriptorResponse(
          stream,
          { ':status': 204, k: '404' },
          {},
          { code: 'ERR_HTTP2_PAYLOAD_FORBIDDEN' }
        )
      } else if (requestPath === '/fd-type') {
        assert.throws(
          () => stream.respondWithFD('invalid', { ':status': 404, k: '404' }),
          { code: 'ERR_INVALID_ARG_TYPE' }
        )
      } else if (requestPath === '/fd-ignored-options') {
        const options = Object.create({
          get statCheck () {
            throw new Error('inherited statCheck getter')
          },
        })
        Object.defineProperty(options, 'offset', {
          get () {
            throw new Error('non-enumerable offset getter')
          },
        })
        const fileDescriptor = openSync(__filename, 'r')
        try {
          stream.respondWithFD(fileDescriptor, { ':status': 404, k: '404' }, options)
        } finally {
          closeSync(fileDescriptor)
        }
      } else {
        assertInvalidFileDescriptorResponse(
          stream,
          { ':status': 199, k: '404' },
          {},
          { code: 'ERR_HTTP2_STATUS_INVALID' }
        )
      }

      stream.respond({ ':status': 404, k: '404' })
      stream.end('ignored')
    })

    const requestPaths = [
      '/status',
      '/header',
      '/options',
      '/options-accessor',
      '/header-accessor',
      '/pseudo-header',
      '/header-name',
      '/te',
      '/sensitive-headers',
      '/sensitive-header-name',
      '/sensitive-header-accessor',
      '/header-value',
      '/raw-headers',
      '/raw-header-name',
      '/single-value-header',
      '/sensitive-empty',
      '/ignored-headers',
      '/fd-offset',
      '/fd-length',
      '/fd-payload',
      '/fd-type',
      '/fd-ignored-options',
      '/fd-status',
    ]
    for (const requestPath of requestPaths) {
      const { body, headers } = await request(requestPath)
      assert.strictEqual(headers[':status'], 403)
      assert.strictEqual(body, blockedTemplateJson)
    }
  })

  it('leaves exotic valid response values to Node without analyzing them', async () => {
    await listenCore((stream, headers) => {
      if (headers[':path'] === '/status') {
        stream.respond({ ':status': {}, k: '404' })
      } else if (headers[':path'] === '/value') {
        stream.respond({ ':status': 404, k: '404', value: [{}] })
      } else if (headers[':path'] === '/default') {
        stream.respond({ k: '404' })
      } else {
        class ResponseHeaders {
          constructor () {
            this[':status'] = 404
            this.k = '404'
          }
        }
        stream.respond(new ResponseHeaders())
      }
      stream.end('body')
    })

    const [statusResponse, valueResponse, defaultResponse, prototypeResponse] = await Promise.all([
      request('/status'),
      request('/value'),
      request('/default'),
      request('/prototype'),
    ])

    assert.strictEqual(statusResponse.headers[':status'], 200)
    assert.strictEqual(statusResponse.body, 'body')
    assert.strictEqual(valueResponse.headers[':status'], 404)
    assert.strictEqual(valueResponse.body, 'body')
    assert.strictEqual(defaultResponse.headers[':status'], 200)
    assert.strictEqual(defaultResponse.body, 'body')
    assert.strictEqual(prototypeResponse.headers[':status'], 404)
    assert.strictEqual(prototypeResponse.body, 'body')
  })

  it('leaves exotic statCheck headers to Node without analyzing them', async () => {
    await listenCore(stream => {
      stream.respondWithFile(__filename, { ':status': 404, k: '404' }, {
        statCheck (stat, headers) {
          Object.setPrototypeOf(headers, { inherited: true })
          return true
        },
      })
    })

    const { body, headers } = await request()

    assert.strictEqual(headers[':status'], 404)
    assert.notStrictEqual(body, blockedTemplateJson)
  })

  it('does not affect untracked core stream response methods after wrapping their prototype', async () => {
    await listen(() => {
      const coreServer = http2.createServer()
      coreServer[FOREIGN_HTTP2_SERVER] = true
      coreServer.on('stream', (stream, headers) => {
        if (headers[':path'] === '/respond') {
          stream.respond({ ':status': 200 })
          stream.end('body')
        } else if (headers[':path'] === '/fd') {
          const fileDescriptor = openSync(__filename, 'r')
          stream.once('close', () => closeSync(fileDescriptor))
          stream.respondWithFD(fileDescriptor, { ':status': 200 })
        } else if (headers[':path'] === '/file') {
          stream.respondWithFile(__filename, { ':status': 200 })
        } else {
          stream.additionalHeaders({ ':status': 103 })
          stream.respond({ ':status': 200 })
          stream.end('body')
        }
      })
      return coreServer
    })

    const [respondResponse, fileDescriptorResponse, fileResponse, additionalHeadersResponse] = await Promise.all([
      request('/respond'),
      request('/fd'),
      request('/file'),
      request('/additional-headers'),
    ])

    assert.strictEqual(respondResponse.headers[':status'], 200)
    assert.strictEqual(respondResponse.body, 'body')
    assert.strictEqual(fileDescriptorResponse.headers[':status'], 200)
    assert.notStrictEqual(fileDescriptorResponse.body, blockedTemplateJson)
    assert.strictEqual(fileResponse.headers[':status'], 200)
    assert.notStrictEqual(fileResponse.body, blockedTemplateJson)
    assert.strictEqual(additionalHeadersResponse.headers[':status'], 200)
    assert.strictEqual(additionalHeadersResponse.informationalHeaders.length, 1)
    assert.strictEqual(additionalHeadersResponse.informationalHeaders[0][':status'], 103)
  })

  it('does not inspect respondWithFile headers when opening the file fails', async () => {
    await listenCore(stream => {
      stream.respondWithFile(
        path.join(__dirname, 'missing-http2-response'),
        { ':status': 404, k: '404' },
        {
          onError () {
            stream.respond({ ':status': 200 })
            stream.end('fallback')
          },
        }
      )
    })

    const { body, headers } = await request()

    assert.strictEqual(headers[':status'], 200)
    assert.strictEqual(body, 'fallback')
  })

  it('inspects fallback headers after respondWithFile fails', async () => {
    await listenCore(stream => {
      stream.respondWithFile(
        path.join(__dirname, 'missing-http2-response'),
        { ':status': 200 },
        {
          onError () {
            stream.respond({ ':status': 404, k: '404' })
            stream.end('fallback')
          },
        }
      )
    })

    const { body, headers } = await request()

    assert.strictEqual(headers[':status'], 403)
    assert.strictEqual(body, blockedTemplateJson)
  })

  it('inspects respondWithFile headers after statCheck mutates them', async () => {
    await listenCore(stream => {
      stream.respondWithFile(__filename, { ':status': 200 }, {
        statCheck (stat, headers) {
          headers[':status'] = 404
          headers.k = '404'
          return true
        },
      })
    })

    const { body, headers } = await request()

    assert.strictEqual(headers[':status'], 403)
    assert.strictEqual(body, blockedTemplateJson)
  })

  it('does not inspect replaced respondWithFile headers before statCheck returns', async () => {
    await listenCore(stream => {
      stream.respondWithFile(__filename, { ':status': 404, k: '404' }, {
        statCheck (stat, headers) {
          headers[':status'] = 200
          delete headers.k
          return true
        },
      })
    })

    const { body, headers } = await request()

    assert.strictEqual(headers[':status'], 200)
    assert.notStrictEqual(body, blockedTemplateJson)
  })

  it('does not inspect respondWithFile headers when statCheck sends a fallback', async () => {
    await listenCore(stream => {
      stream.respondWithFile(__filename, { ':status': 404, k: '404' }, {
        statCheck () {
          stream.respond({ ':status': 200 })
          stream.end('fallback')
          return false
        },
      })
    })

    const { body, headers } = await request()

    assert.strictEqual(headers[':status'], 200)
    assert.strictEqual(body, 'fallback')
  })

  it('blocks respondWithFD headers without statCheck', async () => {
    await listenCore(stream => {
      const fileDescriptor = openSync(__filename, 'r')
      stream.once('close', () => closeSync(fileDescriptor))
      stream.respondWithFD(fileDescriptor, { ':status': 404, k: '404' })
    })

    const { body, headers } = await request()

    assert.strictEqual(headers[':status'], 403)
    assert.strictEqual(body, blockedTemplateJson)
  })

  it('inspects respondWithFD headers after statCheck mutates them', async () => {
    await listenCore(stream => {
      const fileDescriptor = openSync(__filename, 'r')
      stream.once('close', () => closeSync(fileDescriptor))
      stream.respondWithFD(fileDescriptor, { ':status': 200 }, {
        statCheck (stat, headers) {
          headers[':status'] = 404
          headers.k = '404'
          return true
        },
      })
    })

    const { body, headers } = await request()

    assert.strictEqual(headers[':status'], 403)
    assert.strictEqual(body, blockedTemplateJson)
  })

  it('preserves compatibility duplicate header values when Node does', async () => {
    await listen(() => http2.createServer((req, res) => {
      res.writeHead(200, [['K', 'bad1'], ['k', 'bad2'], ['K', 'bad3']])
      res.end()
    }))

    const { body, headers } = await request()

    assert.strictEqual(headers[':status'], PRESERVES_DUPLICATE_HEADERS ? 403 : 200)
    assert.strictEqual(body, PRESERVES_DUPLICATE_HEADERS ? blockedTemplateJson : '')
  })

  it('preserves core stream duplicate header values across casing', async () => {
    await listenCore(stream => {
      stream.respond({ ':status': 200, K: 'bad1', k: ['bad2', 'bad3'] })
      stream.end()
    })

    const { body, headers } = await request()

    assert.strictEqual(headers[':status'], 403)
    assert.strictEqual(body, blockedTemplateJson)
  })
})
