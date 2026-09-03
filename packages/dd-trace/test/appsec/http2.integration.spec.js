'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')
const { closeSync, openSync, readFileSync } = require('node:fs')
const { open } = require('node:fs/promises')
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
  incomingHttpRequestEnd,
  queryParser,
  responseBody,
} = require('../../src/appsec/channels')
const { getConfigFresh } = require('../helpers/config')
const agent = require('../plugins/agent')
const { blockedTemplateJson, setTestBlockingTemplates } = require('./utils')

const PRESERVES_DUPLICATE_HEADERS = NODE_MAJOR >= 22 ||
  (NODE_MAJOR === 21 && NODE_MINOR >= 7) ||
  (NODE_MAJOR === 20 && NODE_MINOR >= 12)
const VALIDATES_SENSITIVE_HEADER_NAMES_WITH_MAP = NODE_MAJOR >= 23 ||
  (NODE_MAJOR === 22 && NODE_MINOR >= 5) ||
  (NODE_MAJOR === 20 && NODE_MINOR >= 18)
const SUPPORTS_RAW_RESPONSE_HEADERS = NODE_MAJOR >= 25 ||
  (NODE_MAJOR === 24 && NODE_MINOR >= 7) ||
  (NODE_MAJOR === 22 && NODE_MINOR >= 20)
const SUPPORTS_RELAXED_SINGLE_VALUE_FIELDS = NODE_MAJOR >= 26 ||
  (NODE_MAJOR === 25 && NODE_MINOR >= 7) ||
  (NODE_MAJOR === 24 && NODE_MINOR >= 15)
const serverKey = readFileSync(path.join(__dirname, '../../../datadog-plugin-http2/test/ssl/test.key'))
const serverCert = readFileSync(path.join(__dirname, '../../../datadog-plugin-http2/test/ssl/test.crt'))
const runtimeSupported = Boolean(process.env.DD_INJECT_FORCE) ||
  semver.satisfies(process.version, `${engines.node} <${nodeMaxMajor}`)
const describeSupported = runtimeSupported ? describe : describe.skip

/** @type {typeof import('node:https')} */
let https
let incomingHttpRequestEndCount = 0

/**
 * @returns {void}
 */
function countIncomingHttpRequestEnd () {
  incomingHttpRequestEndCount++
}

describeSupported('AppSec HTTP/2 response blocking', () => {
  let config
  let http2
  let server
  let port

  before(async () => {
    await agent.load(['http2', 'http'], { client: false })
    // Exercise the dual-plugin load order that wraps HTTP/1 fallback responses.
    require('node:http')
    https = require('node:https')
    http2 = require('node:http2')
    config = getConfigFresh({
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
    })
    appsec.enable(config)
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
   * @param {import('node:http2').OutgoingHttpHeaders} [additionalHeaders]
   * @returns {Promise<{
   *   body: string,
   *   headers: import('node:http2').IncomingHttpHeaders,
   *   informationalHeaders: import('node:http2').IncomingHttpHeaders[]
   * }>}
   */
  function request (requestPath = '/', additionalHeaders) {
    return new Promise((resolve, reject) => {
      const client = http2.connect(`http://localhost:${port}`).once('error', reject)
      const requestHeaders = { ':path': requestPath, ...additionalHeaders }
      if (requestHeaders[':method'] === 'CONNECT') delete requestHeaders[':path']
      const stream = client.request(requestHeaders)
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
      res.writeHead(200, { 'after-block-write-head': 'ignored' })
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
    assert.strictEqual(headers['after-block-write-head'], undefined)
    assert.strictEqual(body, blockedTemplateJson)
  })

  it('blocks responses sent through the compatibility response stream', async () => {
    let returnValue
    await listen(() => http2.createServer((req, res) => {
      returnValue = res.stream.respond({ ':status': 404, k: '404' })
      res.stream.end('ignored')
    }))

    const { body, headers } = await request()

    assert.strictEqual(headers[':status'], 403)
    assert.strictEqual(body, blockedTemplateJson)
    assert.strictEqual(returnValue, undefined)
  })

  it('preserves undefined returns after blocking a core file response', async () => {
    let returnValue
    let repeatedReturnValues
    await listenCore(stream => {
      const fileDescriptor = openSync(__filename, 'r')
      returnValue = stream.respondWithFD(fileDescriptor, { ':status': 404, k: '404' })
      repeatedReturnValues = [
        stream.respond({ ':status': 200 }),
        stream.respondWithFD(fileDescriptor, { ':status': 200 }),
        stream.respondWithFile(__filename, { ':status': 200 }),
      ]
      closeSync(fileDescriptor)
    })

    const { body, headers } = await request()

    assert.strictEqual(headers[':status'], 403)
    assert.strictEqual(body, blockedTemplateJson)
    assert.strictEqual(returnValue, undefined)
    assert.deepStrictEqual(repeatedReturnValues, [undefined, undefined, undefined])
  })

  it('keeps compatibility response operations blocked after AppSec is disabled', async () => {
    let operationError
    await listen(() => http2.createServer((req, res) => {
      res.stream.respond({ ':status': 404, k: '404' })
      appsec.disable()
      try {
        res.removeHeader('k')
        res.setHeader('after-block', 'ignored')
        res.appendHeader?.('after-block', 'ignored')
        res.writeHead(200, { 'after-block-write-head': 'ignored' })
        res.write('ignored')
        res.end('ignored')
        res.stream.respond({ ':status': 200 })
        res.stream.write('ignored')
        res.stream.end('ignored')
      } catch (error) {
        operationError = error
      }
    }))

    try {
      const { body, headers } = await request()

      assert.strictEqual(operationError, undefined)
      assert.strictEqual(headers[':status'], 403)
      assert.strictEqual(headers['after-block'], undefined)
      assert.strictEqual(headers['after-block-write-head'], undefined)
      assert.strictEqual(body, blockedTemplateJson)
    } finally {
      appsec.enable(config)
      setTestBlockingTemplates()
    }
  })

  it('preserves HTTP/1 fallback requests on secure compatibility servers', async () => {
    let requestVersion
    let responseClosedPromise
    incomingHttpRequestEndCount = 0
    incomingHttpRequestEnd.subscribe(countIncomingHttpRequestEnd)
    await listen(() => http2.createSecureServer({
      allowHTTP1: true,
      cert: serverCert,
      key: serverKey,
    }, (req, res) => {
      requestVersion = req.httpVersion
      responseClosedPromise = once(res, 'close')
      res.end('body')
    }))

    const traceAsserted = agent.assertFirstTraceSpan({
      name: 'web.request',
      meta: {
        component: 'http2',
        'http.status_code': '200',
      },
      metrics: {
        '_dd.appsec.enabled': 1,
      },
    })
    const responseBodyPromise = new Promise((resolve, reject) => {
      const chunks = []
      const clientRequest = https.get({
        ALPNProtocols: ['http/1.1'],
        hostname: 'localhost',
        port,
        rejectUnauthorized: false,
      }, response => {
        response.on('data', chunk => chunks.push(chunk))
        response.once('end', () => resolve(Buffer.concat(chunks).toString()))
      })
      clientRequest.once('error', reject)
    })
    try {
      const [, responseBody] = await Promise.all([traceAsserted, responseBodyPromise])
      await responseClosedPromise

      assert.strictEqual(requestVersion, '1.1')
      assert.strictEqual(responseBody, 'body')
      assert.strictEqual(incomingHttpRequestEndCount, 1)
    } finally {
      incomingHttpRequestEnd.unsubscribe(countIncomingHttpRequestEnd)
    }
  })

  it('preserves HTTP/1 CONNECT events on secure compatibility servers', async () => {
    agent.reload('http2', { client: false, headers: ['x-response'] })

    try {
      await listen(() => {
        const compatibilityServer = http2.createSecureServer({
          allowHTTP1: true,
          cert: serverCert,
          key: serverKey,
        })
        compatibilityServer.on('connect', (req, socket) => {
          socket.end('HTTP/1.1 200 Connection Established\r\nX-Response: value\r\n\r\n')
        })
        return compatibilityServer
      })

      const statusCode = await new Promise((resolve, reject) => {
        const clientRequest = https.request({
          ALPNProtocols: ['http/1.1'],
          hostname: 'localhost',
          method: 'CONNECT',
          path: 'localhost:443',
          port,
          rejectUnauthorized: false,
        })
        clientRequest.once('connect', (response, socket) => {
          socket.end()
          resolve(response.statusCode)
        })
        clientRequest.once('error', reject)
        clientRequest.end()
      })

      assert.strictEqual(statusCode, 200)
    } finally {
      agent.reload('http2', { client: false })
    }
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

  for (const [eventName, requestHeaders] of [
    ['connect', { ':authority': 'localhost', ':method': 'CONNECT' }],
    ['checkContinue', { expect: '100-continue' }],
    ['checkExpectation', { expect: 'unsupported' }],
  ]) {
    it(`blocks compatibility ${eventName} responses`, async () => {
      await listen(() => {
        const compatibilityServer = http2.createServer((req, res) => {
          res.end('request')
        })
        compatibilityServer.on(eventName, (req, res) => {
          res.writeHead(404, { k: '404' })
          res.end('ignored')
        })
        return compatibilityServer
      })

      const { body, headers } = await request('/', requestHeaders)

      assert.strictEqual(headers[':status'], 403)
      assert.strictEqual(body, blockedTemplateJson)
    })
  }

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

  it('uses one WAF context when AppSec restarts between mixed request events', async () => {
    await listen(() => {
      const mixedServer = http2.createServer((req, res) => {
        appsec.enable(config)
        setTestBlockingTemplates()

        const abortController = new AbortController()
        expressSession.publish({ req, res, sessionId: 'mixed-http2-session', abortController })
        if (abortController.signal.aborted) return

        res.end('unblocked')
      })
      mixedServer.prependListener('stream', () => appsec.disable())
      return mixedServer
    })

    try {
      const { body, headers } = await request('/mixed-session')

      assert.strictEqual(headers[':status'], 403)
      assert.strictEqual(body, blockedTemplateJson)
    } finally {
      appsec.enable(config)
      setTestBlockingTemplates()
    }
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

  it('keeps a core response blocked after AppSec is disabled', async () => {
    await listenCore(stream => {
      stream.respond({ ':status': 404, k: '404' })
      appsec.disable()
      stream.additionalHeaders({ ':status': 103 })
      stream.respond({ ':status': 200 })
      stream.write('ignored')
      stream.end('ignored')
    })

    try {
      const { body, headers } = await request()

      assert.strictEqual(headers[':status'], 403)
      assert.strictEqual(body, blockedTemplateJson)
    } finally {
      appsec.enable(config)
      setTestBlockingTemplates()
    }
  })

  it('keeps core response operations suppressed after a blocked stream closes and AppSec is disabled', async () => {
    let resolveAfterClose
    let rejectAfterClose
    const afterClosePromise = new Promise((resolve, reject) => {
      resolveAfterClose = resolve
      rejectAfterClose = reject
    })

    await listenCore(stream => {
      stream.once('close', () => {
        appsec.disable()
        queueMicrotask(() => {
          const fileDescriptor = openSync(__filename, 'r')
          try {
            stream.additionalHeaders({ ':status': 103 })
            stream.respond({ ':status': 200 })
            stream.respondWithFD(fileDescriptor, { ':status': 200 })
            stream.respondWithFile(__filename, { ':status': 200 })
            stream.write('ignored')
            stream.end('ignored')
            stream.emit('close')
            resolveAfterClose()
          } catch (error) {
            rejectAfterClose(error)
          } finally {
            closeSync(fileDescriptor)
          }
        })
      })
      stream.respond({ ':status': 404, k: '404' })
    })

    try {
      const [{ body, headers }] = await Promise.all([request(), afterClosePromise])

      assert.strictEqual(headers[':status'], 403)
      assert.strictEqual(body, blockedTemplateJson)
    } finally {
      appsec.enable(config)
      setTestBlockingTemplates()
    }
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

  it('blocks a core response after AppSec is enabled during the request', async () => {
    let resolveStream
    const streamPromise = new Promise(resolve => {
      resolveStream = resolve
    })
    await listenCore(stream => resolveStream(stream))
    appsec.disable()

    try {
      const responsePromise = request()
      const stream = await streamPromise

      appsec.enable(config)
      setTestBlockingTemplates()
      stream.respond({ ':status': 404, k: '404' })
      stream.end('ignored')

      const { body, headers } = await responsePromise
      assert.strictEqual(headers[':status'], 403)
      assert.strictEqual(body, blockedTemplateJson)
    } finally {
      appsec.enable(config)
      setTestBlockingTemplates()
    }
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

  it('preserves closed-stream errors before reading response values', async () => {
    let headerReads = 0
    let optionReads = 0
    const errors = []
    let resolveStream
    const streamPromise = new Promise(resolve => {
      resolveStream = resolve
    })

    await listenCore(stream => resolveStream(stream))

    const client = http2.connect(`http://localhost:${port}`)
    try {
      const clientStream = client.request()
      clientStream.resume()
      const clientStreamClosedPromise = once(clientStream, 'close')
      clientStream.end()
      const stream = await streamPromise

      const headers = { ':status': 200 }
      Object.defineProperty(headers, 'x-test', {
        enumerable: true,
        get () {
          headerReads++
          return 'value'
        },
      })
      const options = {}
      Object.defineProperty(options, 'sendDate', {
        enumerable: true,
        get () {
          optionReads++
          return false
        },
      })

      stream.close()

      for (const respond of [
        () => stream.respond(headers, options),
        () => stream.respondWithFD(0, headers, options),
        () => stream.respondWithFile(__filename, headers, options),
        () => stream.additionalHeaders(headers),
      ]) {
        try {
          respond()
        } catch (error) {
          errors.push(error.code)
        }
      }

      await clientStreamClosedPromise
    } finally {
      if (!client.destroyed) {
        const clientClosedPromise = once(client, 'close')
        client.destroy()
        await clientClosedPromise
      }
    }

    assert.deepStrictEqual(errors, [
      'ERR_HTTP2_INVALID_STREAM',
      'ERR_HTTP2_INVALID_STREAM',
      'ERR_HTTP2_INVALID_STREAM',
      'ERR_HTTP2_INVALID_STREAM',
    ])
    assert.strictEqual(headerReads, 0)
    assert.strictEqual(optionReads, 0)
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
      assert.throws(() => stream.respondWithFD(fileDescriptor, {}, []), TypeError)
      assert.throws(() => stream.respondWithFile(__filename, {}, []), TypeError)

      closeSync(fileDescriptor)
      stream.respond({ ':status': 200 })
      stream.end('body')
    })

    const { body, headers } = await request()

    assert.strictEqual(headers[':status'], 200)
    assert.strictEqual(body, 'body')
  })

  it('preserves invalid compatibility response errors before analyzing them', async () => {
    await listen(() => http2.createServer((req, res) => {
      assert.throws(
        () => res.writeHead(404, ['k', '404', 'odd']),
        { code: 'ERR_INVALID_ARG_VALUE' }
      )
      res.writeHead(404, { k: '404' })
      res.end('ignored')
    }))

    const { body, headers } = await request()

    assert.strictEqual(headers[':status'], 403)
    assert.strictEqual(body, blockedTemplateJson)
  })

  it('validates rejected core responses before analyzing their headers', async () => {
    await listenCore((stream, headers) => {
      const requestPath = headers[':path']

      if (requestPath === '/status') {
        assert.throws(
          () => stream.respond({ ':status': 199, k: '404' }),
          { code: 'ERR_HTTP2_STATUS_INVALID' }
        )
      } else if (requestPath === '/status-normalized') {
        assert.throws(
          () => stream.respond({ ':STATUS': {}, k: '404' }),
          { code: 'ERR_HTTP2_HEADER_SINGLE_VALUE' }
        )
      } else if (requestPath === '/status-case') {
        assert.throws(
          () => stream.respond({ ':STATUS': 404, k: '404' }),
          { code: 'ERR_HTTP2_HEADER_SINGLE_VALUE' }
        )
      } else if (requestPath === '/date-case') {
        assert.throws(
          () => stream.respond({ ':status': 404, Date: 'Thu, 01 Jan 1970 00:00:00 GMT', k: '404' }),
          { code: 'ERR_HTTP2_HEADER_SINGLE_VALUE' }
        )
      } else if (requestPath === '/header') {
        assert.throws(
          () => stream.respond({ ':status': 404, connection: 'close', k: '404' }),
          { code: 'ERR_HTTP2_INVALID_CONNECTION_HEADERS' }
        )
      } else if (requestPath === '/header-type') {
        assert.throws(
          () => stream.respond('invalid'),
          { code: 'ERR_INVALID_ARG_TYPE' }
        )
      } else if (requestPath === '/header-null') {
        assert.throws(
          () => stream.respond(null),
          { code: 'ERR_INVALID_ARG_TYPE' }
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
          () => stream.respond({ ':status': 404, k: '404', TE: 'gzip' }),
          { code: 'ERR_HTTP2_INVALID_CONNECTION_HEADERS' }
        )
      } else if (requestPath === '/te-multiple-blocking') {
        assert.throws(
          () => stream.respond({ ':status': 404, k: '404', te: ['trailers', 'bad'] }),
          { code: 'ERR_HTTP2_INVALID_CONNECTION_HEADERS' }
        )
      } else if (requestPath === '/te-multiple-fallback') {
        assert.throws(
          () => stream.respond({ te: ['trailers', 'bad'] }),
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
        if (VALIDATES_SENSITIVE_HEADER_NAMES_WITH_MAP) {
          assert.throws(() => stream.respond(responseHeaders), TypeError)
        } else {
          stream.respond(responseHeaders)
          stream.end('ignored')
          return
        }
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
      } else if (requestPath === '/sensitive-header-map') {
        const responseHeaders = { ':status': 404, k: '404' }
        const sensitiveHeaders = ['k']
        sensitiveHeaders.map = () => {
          throw new Error('invalid sensitive header map')
        }
        responseHeaders[http2.sensitiveHeaders] = sensitiveHeaders
        if (VALIDATES_SENSITIVE_HEADER_NAMES_WITH_MAP) {
          assert.throws(
            () => stream.respond(responseHeaders),
            { message: 'invalid sensitive header map' }
          )
        } else {
          stream.respond(responseHeaders)
          stream.end('ignored')
          return
        }
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
      } else if (requestPath === '/flat-raw-headers') {
        const responseHeaders = [':status', 404, 'k', '404']
        if (SUPPORTS_RAW_RESPONSE_HEADERS) {
          stream.respond(responseHeaders)
          stream.end('ignored')
          return
        }
        assert.throws(() => stream.respond(responseHeaders), TypeError)
      } else if (requestPath === '/raw-header-name') {
        assert.throws(
          () => stream.respond([1, 'value', ':status', 404, 'k', '404']),
          TypeError
        )
      } else if (requestPath === '/raw-status-value') {
        assert.throws(
          () => stream.respond([':status', {}, 'k', '404']),
          SUPPORTS_RAW_RESPONSE_HEADERS ? { code: 'ERR_HTTP2_HEADER_SINGLE_VALUE' } : TypeError
        )
      } else if (requestPath === '/raw-header-accessor') {
        const responseHeaders = [':status', 404, 'x-test', 'value', 'k', '404']
        Object.defineProperty(responseHeaders, 2, {
          get () {
            throw new Error('invalid raw header getter')
          },
        })
        assert.throws(
          () => stream.respond(responseHeaders),
          SUPPORTS_RAW_RESPONSE_HEADERS ? { message: 'invalid raw header getter' } : TypeError
        )
      } else if (requestPath === '/raw-sensitive-header-accessor') {
        const responseHeaders = [':status', 404, 'k', '404']
        Object.defineProperty(responseHeaders, http2.sensitiveHeaders, {
          get () {
            throw new Error('invalid raw sensitive header getter')
          },
        })
        assert.throws(
          () => stream.respond(responseHeaders),
          SUPPORTS_RAW_RESPONSE_HEADERS ? { message: 'invalid raw sensitive header getter' } : TypeError
        )
      } else if (requestPath === '/frozen-raw-headers') {
        const responseHeaders = Object.freeze([':status', 404, 'k', '404'])
        assert.throws(() => stream.respond(responseHeaders), TypeError)
      } else if (requestPath === '/frozen-raw-headers-status') {
        const responseHeaders = Object.freeze([
          'date', 'Thu, 01 Jan 1970 00:00:00 GMT',
          'k', '404',
        ])
        assert.throws(() => stream.respond(responseHeaders), TypeError)
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
        stream.respond({ ':status': 404, k: '404', '': 'ignored', empty: [], MiSsInG: undefined })
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
      '/status-normalized',
      '/status-case',
      '/date-case',
      '/header',
      '/header-type',
      '/header-null',
      '/options',
      '/options-accessor',
      '/header-accessor',
      '/pseudo-header',
      '/header-name',
      '/te',
      '/te-multiple-blocking',
      '/te-multiple-fallback',
      '/sensitive-headers',
      '/sensitive-header-name',
      '/sensitive-header-accessor',
      '/sensitive-header-map',
      '/header-value',
      '/raw-headers',
      '/flat-raw-headers',
      '/raw-header-name',
      '/raw-status-value',
      '/raw-header-accessor',
      '/raw-sensitive-header-accessor',
      '/frozen-raw-headers',
      '/frozen-raw-headers-status',
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
      const preservesSensitiveHeaders = !VALIDATES_SENSITIVE_HEADER_NAMES_WITH_MAP &&
        (requestPath === '/sensitive-header-name' || requestPath === '/sensitive-header-map')
      assert.strictEqual(headers[':status'], preservesSensitiveHeaders ? 404 : 403)
      assert.strictEqual(body, preservesSensitiveHeaders ? 'ignored' : blockedTemplateJson)
    }
  })

  it('allows a single-value te header array', async () => {
    await listenCore(stream => {
      stream.respond({ te: ['trailers'] })
      stream.end('body')
    })

    const { body, headers } = await request()

    assert.strictEqual(headers.te, 'trailers')
    assert.strictEqual(body, 'body')
  })

  it('leaves incomplete raw response header pairs to Node', async function () {
    if (!SUPPORTS_RAW_RESPONSE_HEADERS) this.skip()

    await listenCore(stream => {
      stream.respond([':status', 200, 'x-test'], { sendDate: false })
      stream.end('body')
    })

    const { body, headers } = await request()

    assert.strictEqual(headers[':status'], 200)
    assert.strictEqual(headers['x-test'], undefined)
    assert.strictEqual(body, 'body')
  })

  for (const [method, respond] of [
    ['respond', (stream, options) => {
      stream.respond({ ':status': 200 }, options)
      stream.end('body')
    }],
    ['respondWithFD', (stream, options) => {
      const fileDescriptor = openSync(__filename, 'r')
      stream.once('close', () => closeSync(fileDescriptor))
      stream.respondWithFD(fileDescriptor, { ':status': 200 }, options)
    }],
    ['respondWithFile', (stream, options) => {
      stream.respondWithFile(__filename, { ':status': 200 }, options)
    }],
  ]) {
    it(`reads ${method} options once`, async () => {
      let ownKeysCalls = 0
      const options = new Proxy({}, {
        ownKeys () {
          ownKeysCalls++
          return []
        },
      })
      await listenCore(stream => respond(stream, options))

      const { headers } = await request()

      assert.strictEqual(headers[':status'], 200)
      assert.strictEqual(ownKeysCalls, 1)
    })
  }

  it('reads raw sensitive header metadata once', async function () {
    if (!SUPPORTS_RAW_RESPONSE_HEADERS) this.skip()

    let nativeReads
    let instrumentedReads
    await listenCore((stream, requestHeaders) => {
      const instrumentationEnabled = requestHeaders[':path'] === '/instrumented'
      if (instrumentationEnabled) {
        appsec.enable(config)
        setTestBlockingTemplates()
      } else {
        appsec.disable()
      }

      let sensitiveHeaderReads = 0
      const responseHeaders = [':status', 200, 'k', 'value']
      Object.defineProperty(responseHeaders, http2.sensitiveHeaders, {
        get () {
          sensitiveHeaderReads++
          return ['k']
        },
      })
      stream.respond(responseHeaders)
      stream.end('body')
      if (instrumentationEnabled) {
        instrumentedReads = sensitiveHeaderReads
      } else {
        nativeReads = sensitiveHeaderReads
      }
    })

    try {
      await request('/native')
      const { body, headers } = await request('/instrumented')

      assert.strictEqual(headers[':status'], 200)
      assert.strictEqual(body, 'body')
      assert.strictEqual(instrumentedReads, nativeReads)
    } finally {
      appsec.enable(config)
      setTestBlockingTemplates()
    }
  })

  it('preserves raw sensitive header metadata', async function () {
    if (!SUPPORTS_RAW_RESPONSE_HEADERS) this.skip()

    await listenCore(stream => {
      const responseHeaders = [':status', 200, 'k', 'value']
      responseHeaders[http2.sensitiveHeaders] = ['k']
      stream.respond(responseHeaders)
      stream.end('body')
    })

    const { body, headers } = await request()

    assert.strictEqual(headers[':status'], 200)
    assert.strictEqual(body, 'body')
    assert.deepStrictEqual(headers[http2.sensitiveHeaders], ['k'])
  })

  it('blocks immutable complete raw response headers', async function () {
    if (!SUPPORTS_RAW_RESPONSE_HEADERS) this.skip()

    await listenCore(stream => {
      const responseHeaders = Object.freeze([
        ':status', 404,
        'date', 'Thu, 01 Jan 1970 00:00:00 GMT',
        'k', '404',
      ])
      stream.respond(responseHeaders)
      stream.end('ignored')
    })

    const { body, headers } = await request()

    assert.strictEqual(headers[':status'], 403)
    assert.strictEqual(body, blockedTemplateJson)
  })

  it('blocks immutable raw response headers when automatic dates are disabled', async function () {
    if (!SUPPORTS_RAW_RESPONSE_HEADERS) this.skip()

    await listenCore(stream => {
      const responseHeaders = Object.freeze([':status', 404, 'k', '404'])
      stream.respond(responseHeaders, { sendDate: false })
      stream.end('ignored')
    })

    const { body, headers } = await request()

    assert.strictEqual(headers[':status'], 403)
    assert.strictEqual(body, blockedTemplateJson)
  })

  it('blocks uppercase date headers when automatic dates are disabled', async () => {
    await listenCore(stream => {
      stream.respond({
        ':status': 404,
        Date: 'Thu, 01 Jan 1970 00:00:00 GMT',
        k: '404',
      }, { sendDate: false })
      stream.end('ignored')
    })

    const { body, headers } = await request()

    assert.strictEqual(headers[':status'], 403)
    assert.strictEqual(body, blockedTemplateJson)
  })

  it('preserves invalid te errors when single-value fields are relaxed', async function () {
    if (!SUPPORTS_RELAXED_SINGLE_VALUE_FIELDS) this.skip()

    await listen(() => http2.createServer({ strictSingleValueFields: false }, (req, res) => {
      assert.throws(
        () => res.stream.respond({ ':status': 404, k: '404', te: ['trailers', 'bad'] }),
        { code: 'ERR_HTTP2_INVALID_CONNECTION_HEADERS' }
      )
      res.stream.respond({ ':status': 404, k: '404' })
      res.stream.end('ignored')
    }))

    const { body, headers } = await request()

    assert.strictEqual(headers[':status'], 403)
    assert.strictEqual(body, blockedTemplateJson)
  })

  it('blocks duplicate single-value response fields when Node allows them', async function () {
    if (!SUPPORTS_RELAXED_SINGLE_VALUE_FIELDS) this.skip()

    let optionReads = 0
    const options = {}
    Object.defineProperty(options, 'strictSingleValueFields', {
      enumerable: true,
      get () {
        optionReads++
        return false
      },
    })
    await listen(() => {
      const coreServer = http2.createServer(options)
      coreServer.on('stream', stream => {
        stream.respond({ ':status': 404, k: '404', 'content-type': ['first', 'second'] })
        stream.end('ignored')
      })
      return coreServer
    })

    const { body, headers } = await request()

    assert.strictEqual(optionReads, 1)
    assert.strictEqual(headers[':status'], 403)
    assert.strictEqual(body, blockedTemplateJson)
  })

  it('preserves rejected array server options', function () {
    if (!SUPPORTS_RELAXED_SINGLE_VALUE_FIELDS) this.skip()

    assert.throws(() => http2.createServer([]), { code: 'ERR_INVALID_ARG_TYPE' })
    assert.throws(() => http2.createSecureServer([]), { code: 'ERR_INVALID_ARG_TYPE' })
  })

  it('blocks duplicate single-value fields sent through a compatibility response stream', async function () {
    if (!SUPPORTS_RELAXED_SINGLE_VALUE_FIELDS) this.skip()

    await listen(() => http2.createServer({ strictSingleValueFields: false }, (req, res) => {
      res.stream.respond({ ':status': 404, k: '404', 'content-type': ['first', 'second'] })
      res.stream.end('ignored')
    }))

    const { body, headers } = await request()

    assert.strictEqual(headers[':status'], 403)
    assert.strictEqual(body, blockedTemplateJson)
  })

  it('blocks responses using Node-normalized status codes', async () => {
    await listenCore(stream => {
      stream.respond({ ':status': '404.9', k: '404' })
      stream.end('ignored')
    })

    const { body, headers } = await request()

    assert.strictEqual(headers[':status'], 403)
    assert.strictEqual(body, blockedTemplateJson)
  })

  it('leaves exotic valid response values to Node without analyzing them', async () => {
    await listenCore((stream, headers) => {
      if (headers[':path'] === '/status') {
        stream.respond({ ':status': {}, K: '404' })
      } else if (headers[':path'] === '/value') {
        stream.respond({ ':status': 404, k: '404', value: [{}] })
      } else {
        stream.respond({ k: '404' })
      }
      stream.end('body')
    })

    const [statusResponse, valueResponse, defaultResponse] = await Promise.all([
      request('/status'),
      request('/value'),
      request('/default'),
    ])

    assert.strictEqual(statusResponse.headers[':status'], 200)
    assert.strictEqual(statusResponse.headers.k, '404')
    assert.strictEqual(statusResponse.body, 'body')
    assert.strictEqual(valueResponse.headers[':status'], 404)
    assert.strictEqual(valueResponse.body, 'body')
    assert.strictEqual(defaultResponse.headers[':status'], 200)
    assert.strictEqual(defaultResponse.body, 'body')
  })

  it('blocks class instance response headers with own data properties', async () => {
    await listenCore(stream => {
      class ResponseHeaders {
        constructor () {
          this[':status'] = 404
          this.k = '404'
        }
      }
      stream.respond(new ResponseHeaders())
      stream.end('body')
    })

    const { body, headers } = await request()

    assert.strictEqual(headers[':status'], 403)
    assert.strictEqual(body, blockedTemplateJson)
  })

  it('preserves response headers named __proto__', async () => {
    await listenCore(stream => {
      const responseHeaders = JSON.parse('{":status":200,"__proto__":"value"}')
      stream.respond(responseHeaders)
      stream.end('body')
    })

    const { body, headers } = await request()

    assert.strictEqual(headers[':status'], 200)
    assert.strictEqual(Object.getOwnPropertyDescriptor(headers, '__proto__')?.value, 'value')
    assert.strictEqual(body, 'body')
  })

  it('allows responses without explicit headers', async () => {
    await listenCore(stream => {
      stream.respond()
      stream.end('body')
    })

    const { body, headers } = await request()

    assert.strictEqual(headers[':status'], 200)
    assert.strictEqual(body, 'body')
  })

  it('blocks response headers exposed through accessors', async () => {
    await listenCore(stream => {
      const responseHeaders = { ':status': 404 }
      Object.defineProperty(responseHeaders, 'k', {
        enumerable: true,
        get () {
          return '404'
        },
      })
      stream.respond(responseHeaders)
      stream.end('body')
    })

    const { body, headers } = await request()

    assert.strictEqual(headers[':status'], 403)
    assert.strictEqual(body, blockedTemplateJson)
  })

  it('reads response header accessors once', async () => {
    let reads = 0
    let responseStream
    await listenCore(stream => {
      responseStream = stream
      const responseHeaders = { ':status': 200 }
      Object.defineProperty(responseHeaders, 'X-Value', {
        enumerable: true,
        get () {
          reads++
          return reads === 1 ? 'first' : 'second'
        },
      })
      responseHeaders[http2.sensitiveHeaders] = ['X-Value']
      stream.respond(responseHeaders)
      stream.end('body')
    })

    const { body, headers } = await request()

    assert.strictEqual(headers['x-value'], 'first')
    assert.deepStrictEqual(headers[http2.sensitiveHeaders], ['x-value'])
    assert.strictEqual(responseStream.sentHeaders['X-Value'], 'first')
    assert.strictEqual(responseStream.sentHeaders['x-value'], undefined)
    assert.strictEqual(reads, 1)
    assert.strictEqual(body, 'body')
  })

  it('preserves ignored response fields in stream.sentHeaders', async () => {
    let responseStream
    await listenCore(stream => {
      responseStream = stream
      stream.respond({
        ':status': 200,
        '': 'ignored',
        empty: [],
        skipped: undefined,
      })
      stream.end('body')
    })

    const { body, headers } = await request()

    assert.strictEqual(headers[''], undefined)
    assert.strictEqual(headers.empty, undefined)
    assert.strictEqual(headers.skipped, undefined)
    assert.strictEqual(Object.hasOwn(responseStream.sentHeaders, ''), true)
    assert.deepStrictEqual(responseStream.sentHeaders.empty, [])
    assert.strictEqual(Object.hasOwn(responseStream.sentHeaders, 'skipped'), true)
    assert.strictEqual(body, 'body')
  })

  it('does not invoke iterators on response header arrays', async () => {
    await listenCore(stream => {
      const values = ['first', 'second']
      const sensitiveHeaders = ['X-Value']
      values[Symbol.iterator] = sensitiveHeaders[Symbol.iterator] = () => {
        throw new Error('response header iterator called')
      }

      const responseHeaders = { ':status': 200, 'X-Value': values }
      responseHeaders[http2.sensitiveHeaders] = sensitiveHeaders
      stream.respond(responseHeaders)
      stream.end('body')
    })

    const { body, headers } = await request()

    assert.strictEqual(headers['x-value'], 'first, second')
    assert.deepStrictEqual(headers[http2.sensitiveHeaders], ['x-value', 'x-value'])
    assert.strictEqual(body, 'body')
  })

  it('reads response header array accessors once', async () => {
    let reads = 0
    await listenCore(stream => {
      const values = []
      Object.defineProperty(values, '0', {
        enumerable: true,
        get () {
          reads++
          return reads === 1 ? 'first' : 'second'
        },
      })
      stream.respond({ ':status': 200, 'X-Value': values })
      stream.end('body')
    })

    const { body, headers } = await request()

    assert.strictEqual(headers['x-value'], 'first')
    assert.strictEqual(reads, 1)
    assert.strictEqual(body, 'body')
  })

  it('does not invoke iterators while merging duplicate response header arrays', async () => {
    await listenCore(stream => {
      const firstValues = ['first']
      const laterValues = ['second', 'third']
      firstValues[Symbol.iterator] = laterValues[Symbol.iterator] = () => {
        throw new Error('response header iterator called')
      }

      stream.respond({ ':status': 200, 'X-Value': firstValues, 'x-value': laterValues })
      stream.end('body')
    })

    const { body, headers } = await request()

    assert.strictEqual(headers['x-value'], 'first, second, third')
    assert.strictEqual(body, 'body')
  })

  it('blocks statCheck headers after their prototype changes', async () => {
    await listenCore(stream => {
      stream.respondWithFile(__filename, { ':status': 404, k: '404' }, {
        statCheck (stat, headers) {
          Object.setPrototypeOf(headers, { inherited: true })
          return true
        },
      })
    })

    const { body, headers } = await request()

    assert.strictEqual(headers[':status'], 403)
    assert.strictEqual(body, blockedTemplateJson)
  })

  it('reads statCheck response header accessors once', async () => {
    let reads = 0
    await listenCore(stream => {
      stream.respondWithFile(__filename, { ':status': 200 }, {
        statCheck (stat, headers) {
          Object.defineProperty(headers, 'X-Value', {
            enumerable: true,
            get () {
              reads++
              return reads === 1 ? 'first' : 'second'
            },
          })
          return true
        },
      })
    })

    const { body, headers } = await request()

    assert.strictEqual(headers['x-value'], 'first')
    assert.strictEqual(reads, 1)
    assert.strictEqual(body.length > 0, true)
  })

  it('preserves invalid statCheck header errors before analyzing them', async () => {
    let resolveStream
    const streamPromise = new Promise(resolve => {
      resolveStream = resolve
    })
    await listenCore(stream => resolveStream(stream))

    const client = http2.connect(`http://localhost:${port}`)
    try {
      const clientStream = client.request()
      clientStream.resume()
      const clientStreamErrorPromise = once(clientStream, 'error')
      clientStream.end()
      const stream = await streamPromise
      const streamErrorPromise = once(stream, 'error')
      stream.respondWithFile(__filename, { ':status': 404, k: '404' }, {
        statCheck (stat, headers) {
          headers.connection = 'close'
          return true
        },
      })

      const [[streamError], [clientStreamError]] = await Promise.all([streamErrorPromise, clientStreamErrorPromise])
      assert.strictEqual(streamError.code, 'ERR_HTTP2_INVALID_CONNECTION_HEADERS')
      assert.strictEqual(clientStreamError.code, 'ERR_HTTP2_STREAM_ERROR')
    } finally {
      if (!client.destroyed) {
        const clientClosedPromise = once(client, 'close')
        client.destroy()
        await clientClosedPromise
      }
    }
  })

  it('does not affect untracked core stream response methods after wrapping their prototype', async () => {
    await listen(() => {
      const coreServer = http2.createServer()
      coreServer[FOREIGN_HTTP2_SERVER] = true
      coreServer.on('stream', (stream, headers) => {
        if (headers[':path'] === '/respond') {
          stream.respond({ ':status': 200 })
          stream.write('bo')
          stream.end('dy')
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

  it('uses the stream HEAD state when validating file responses', async () => {
    let headErrorCode
    /**
     * @param {import('node:http2').Http2ServerRequest} req
     * @param {import('node:http2').Http2ServerResponse} res
     */
    function handleFileResponse (req, res) {
      const fileDescriptor = openSync(__filename, 'r')
      res.stream.once('close', () => closeSync(fileDescriptor))
      if (req.url === '/get') {
        req.method = 'HEAD'
        res.stream.respondWithFD(fileDescriptor, { ':status': 404, k: '404' })
        return
      }

      req.method = 'GET'
      try {
        res.stream.respondWithFD(fileDescriptor, { ':status': 404, k: '404' })
      } catch (error) {
        headErrorCode = error.code
      }
      if (!res.stream.headersSent) {
        res.stream.respond({ ':status': 200 })
        res.stream.end()
      }
    }

    await listen(() => http2.createServer(handleFileResponse))

    const [getResponse, headResponse] = await Promise.all([
      request('/get'),
      request('/head', { ':method': 'HEAD' }),
    ])

    assert.strictEqual(getResponse.headers[':status'], 403)
    assert.strictEqual(getResponse.body, blockedTemplateJson)
    assert.strictEqual(headErrorCode, 'ERR_HTTP2_PAYLOAD_FORBIDDEN')
    assert.strictEqual(headResponse.headers[':status'], 200)
    assert.strictEqual(headResponse.body, '')
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

  it('blocks FileHandle respondWithFD headers without statCheck', async () => {
    const fileHandle = await open(__filename, 'r')
    try {
      await listenCore(stream => {
        stream.respondWithFD(fileHandle, { ':status': 404, k: '404' })
      })

      const { body, headers } = await request()

      assert.strictEqual(headers[':status'], 403)
      assert.strictEqual(body, blockedTemplateJson)
    } finally {
      await fileHandle.close()
    }
  })

  it('preserves synchronous FileHandle response state without statCheck', async () => {
    const fileHandle = await open(__filename, 'r')
    let headersSent
    try {
      await listenCore(stream => {
        stream.respondWithFD(fileHandle, { ':status': 200 })
        headersSent = stream.headersSent
        if (headersSent) {
          assert.throws(
            () => stream.respond({ ':status': 201 }),
            { code: 'ERR_HTTP2_HEADERS_SENT' }
          )
        }
      })

      const { body, headers } = await request()

      assert.strictEqual(headersSent, true)
      assert.strictEqual(headers[':status'], 200)
      assert.strictEqual(body.length > 0, true)
    } finally {
      await fileHandle.close()
    }
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
      stream.respond({ ':status': 200, Key: 'bad1', kEy: ['bad2'], key: 'bad3' })
      stream.end()
    })

    const { body, headers } = await request()

    assert.strictEqual(headers[':status'], 403)
    assert.strictEqual(body, blockedTemplateJson)
  })
})
