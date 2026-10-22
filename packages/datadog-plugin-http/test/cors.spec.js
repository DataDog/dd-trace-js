'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')
const { text } = require('node:stream/consumers')

const { after, before, describe, it } = require('mocha')

const agent = require('../../dd-trace/test/plugins/agent')

const ALLOW_ORIGIN = 'access-control-allow-origin'
const ALLOW_HEADERS = 'access-control-allow-headers'
const origin = 'https://example.com'
const requestHeaders = { origin, 'access-control-request-headers': 'baggage,traceparent,x-other' }

/** @typedef {import('node:http').IncomingMessage | import('node:http2').Http2ServerRequest} ServerRequest */
/** @typedef {import('node:http').ServerResponse | import('node:http2').Http2ServerResponse} ServerResponse */

for (const protocol of ['http', 'http2']) {
  for (const plugins of [['http', 'http2'], ['http2', 'http']]) {
    describe(`${protocol} CORS with ${plugins.join(' before ')}`, () => {
      before(async () => {
        const config = { client: false, headers: [ALLOW_HEADERS, ALLOW_ORIGIN] }
        await agent.load(plugins, [config, config])
      })

      after(() => agent.close())

      const shapes = protocol === 'http' ? ['object', 'flat'] : ['object', 'flat', 'tuples']
      for (const shape of shapes) {
        for (const [name, message] of [
          ['omitted', []], ['string', ['OK']], ['empty', ['']], ['undefined', [undefined]],
          ['null', [null]], ['zero', [0]], ['false', [false]], ['NaN', [NaN]],
        ]) {
          it(`extends frozen ${shape} headers with ${name} status message`, async () => {
            const pairs = [
              ['Access-Control-Allow-Origin', origin],
              ['Access-Control-Allow-Headers', 'content-type'],
              ['Set-Cookie', ['first=1', 'second=2']],
              ['x-test', 'retained'],
            ]
            const headers = freezeHeaders(shape, pairs)
            const expectedHeaders = structuredClone(headers)
            const traces = agent.assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].meta['http.status_code'], '200')
              if (shape === 'object' || protocol === 'http2') {
                assert.strictEqual(traces[0][0].meta[`http.response.headers.${ALLOW_HEADERS}`],
                  'content-type,baggage,traceparent')
                assert.strictEqual(traces[0][0].meta[`http.response.headers.${ALLOW_ORIGIN}`], origin)
              }
            })
            const [response] = await Promise.all([
              exchange(protocol, (req, res) => {
                assert.strictEqual(res.writeHead(200, ...message, headers), res)
              }),
              traces,
            ])
            assert.strictEqual(response[ALLOW_HEADERS], 'content-type,baggage,traceparent')
            assert.strictEqual(response[ALLOW_ORIGIN], origin)
            assert.deepStrictEqual(response['set-cookie'], ['first=1', 'second=2'])
            assert.strictEqual(response['x-test'], 'retained')
            assert.deepStrictEqual(headers, expectedHeaders)
          })
        }

        it(`preserves duplicate ${shape} allow-header fields and cookies`, async () => {
          const pairs = [
            [ALLOW_ORIGIN, '*'],
            [ALLOW_HEADERS, 'content-type'],
            ['Access-Control-Allow-Headers', 'x-custom'],
            ['Set-Cookie', 'first=1'],
            ['Set-Cookie', 'second=2'],
          ]
          const headers = freezeHeaders(shape, pairs)
          const traces = agent.assertSomeTraces(() => {})
          const [response] = await Promise.all([
            exchange(protocol, (req, res) => {
              res.setHeader(ALLOW_HEADERS, 'overridden')
              res.writeHead(200, headers)
            }),
            traces,
          ])
          assert.strictEqual(response[ALLOW_HEADERS], shape === 'object'
            ? 'x-custom,baggage,traceparent'
            : 'content-type, x-custom,baggage,traceparent')
          assert.deepStrictEqual(response['set-cookie'], shape === 'object' ? ['second=2'] : ['first=1', 'second=2'])
        })

        it(`combines progressive headers with unrelated explicit ${shape} fields`, async () => {
          const traces = agent.assertSomeTraces(() => {})
          const [response] = await Promise.all([
            exchange(protocol, (req, res) => {
              res.setHeader(ALLOW_ORIGIN, '*')
              res.setHeader(ALLOW_HEADERS, 'content-type')
              res.writeHead(200, undefined, freezeHeaders(shape, [['x-test', 'retained']]))
            }),
            traces,
          ])
          assert.strictEqual(response[ALLOW_HEADERS], 'content-type,baggage,traceparent')
          assert.strictEqual(response['x-test'], 'retained')
        })

        if (shape !== 'object') {
          it(`does not call a custom ${shape} header iterator`, async () => {
            let iteratorCalls = 0
            const headers = shape === 'flat'
              ? [ALLOW_ORIGIN, '*', ALLOW_HEADERS, 'content-type']
              : [[ALLOW_ORIGIN, '*'], [ALLOW_HEADERS, 'content-type']]
            Object.defineProperty(headers, Symbol.iterator, {
              value () {
                iteratorCalls++
                throw new Error('writeHead must read header arrays by index')
              },
            })
            const traces = agent.assertSomeTraces(() => {})
            const [response] = await Promise.all([
              exchange(protocol, (req, res) => { res.writeHead(200, headers) }),
              traces,
            ])
            assert.strictEqual(iteratorCalls, 0)
            assert.strictEqual(response[ALLOW_HEADERS], 'content-type,baggage,traceparent')
          })
        }
      }

      if (protocol === 'http') {
        for (const frozen of [false, true]) {
          for (const explicitAllow of [false, true]) {
            it(`preserves ${frozen ? 'frozen' : 'mutable'} cookie arrays with explicit allow ${explicitAllow}`,
              async () => {
                const pairs = [
                  [ALLOW_ORIGIN, '*'],
                  ['Set-Cookie', ['first=1']],
                  ['Set-Cookie', 'second=2'],
                ]
                if (explicitAllow) pairs.push([ALLOW_HEADERS, 'content-type'])
                const headers = frozen ? freezeHeaders('flat', pairs) : pairs.flat()
                const expectedHeaders = structuredClone(headers)
                const traces = agent.assertSomeTraces(() => {})
                const [response] = await Promise.all([
                  exchange(protocol, (req, res) => { res.writeHead(200, headers) }),
                  traces,
                ])
                assert.deepStrictEqual(headers, expectedHeaders)
                assert.deepStrictEqual(response['set-cookie'], ['first=1', 'second=2'])
                assert.strictEqual(response[ALLOW_HEADERS], explicitAllow
                  ? 'content-type,baggage,traceparent'
                  : 'baggage,traceparent')
              })
          }
        }
      }

      for (const method of ['GET', 'OPTIONS']) {
        for (const allowed of [undefined, 'https://other.example.com', '*']) {
          it(`preserves ${method} headers with allow-origin ${allowed}`, async () => {
            const traces = agent.assertSomeTraces(() => {})
            const [response] = await Promise.all([
              exchange(protocol, (req, res) => {
                res.setHeader(ALLOW_HEADERS, ['content-type', 'x-custom'])
                if (allowed !== undefined) res.setHeader(ALLOW_ORIGIN, allowed)
                res.writeHead(200)
              }, method),
              traces,
            ])
            assert.strictEqual(response[ALLOW_HEADERS], method === 'OPTIONS' && allowed === '*'
              ? 'content-type,x-custom,baggage,traceparent'
              : 'content-type, x-custom')
          })
        }
      }

      it('preserves explicit headers when no tracing header was requested', async () => {
        const traces = agent.assertSomeTraces(() => {})
        const [response] = await Promise.all([
          exchange(protocol, (req, res) => {
            res.setHeader(ALLOW_ORIGIN, '*')
            res.writeHead(200, undefined, { [ALLOW_HEADERS]: 'content-type', 'x-test': 'retained' })
          }, 'OPTIONS', { origin, 'access-control-request-headers': 'content-type' }),
          traces,
        ])
        assert.strictEqual(response[ALLOW_HEADERS], 'content-type')
        assert.strictEqual(response['x-test'], 'retained')
      })

      for (const value of [0, false, '', NaN, ['content-type', 'x-custom']]) {
        it(`extends an allow-header value of ${String(value)}`, async () => {
          const traces = agent.assertSomeTraces(() => {})
          const [response] = await Promise.all([
            exchange(protocol, (req, res) => {
              res.writeHead(200, { [ALLOW_ORIGIN]: '*', [ALLOW_HEADERS]: value })
            }),
            traces,
          ])
          const existing = Array.isArray(value) ? value.join(',') : String(value)
          assert.strictEqual(response[ALLOW_HEADERS], `${existing},baggage,traceparent`)
        })
      }

      it('preserves native rejection of an undefined explicit allow-header', async () => {
        const traces = agent.assertSomeTraces(() => {})
        await Promise.all([
          exchange(protocol, (req, res) => {
            res.setHeader(ALLOW_ORIGIN, '*')
            assert.throws(() => res.writeHead(200, { [ALLOW_HEADERS]: undefined }), {
              code: protocol === 'http' ? 'ERR_HTTP_INVALID_HEADER_VALUE' : 'ERR_HTTP2_INVALID_HEADER_VALUE',
            })
          }),
          traces,
        ])
      })

      for (const headers of [{}, { origin }]) {
        it(`preserves headers without ${headers.origin ? 'requested headers' : 'an origin'}`, async () => {
          const traces = agent.assertSomeTraces(() => {})
          const [response] = await Promise.all([
            exchange(protocol, (req, res) => {
              res.writeHead(200, { [ALLOW_ORIGIN]: '*', [ALLOW_HEADERS]: 'content-type' })
            }, 'OPTIONS', headers),
            traces,
          ])
          assert.strictEqual(response[ALLOW_HEADERS], 'content-type')
        })
      }

      it('preserves writeHead behavior after the response closes', async () => {
        const traces = agent.assertSomeTraces(() => {})
        await Promise.all([
          exchange(protocol, async (req, res) => {
            res.setHeader(ALLOW_ORIGIN, '*')
            const closed = once(res, 'close')
            res.end()
            await closed
            if (protocol === 'http2') {
              assert.strictEqual(res.writeHead(200, { [ALLOW_HEADERS]: 'x-custom' }), res)
            } else {
              assert.throws(() => res.writeHead(200, { [ALLOW_HEADERS]: 'x-custom' }), {
                code: 'ERR_HTTP_HEADERS_SENT',
                message: 'Cannot write headers after they are sent to the client',
              })
            }
          }),
          traces,
        ])
      })
    })
  }
}

/**
 * @param {string} shape
 * @param {Array<[string, string | string[]]>} pairs
 */
function freezeHeaders (shape, pairs) {
  const headers = shape === 'object' ? Object.fromEntries(pairs) : shape === 'flat' ? pairs.flat() : pairs
  for (const value of Object.values(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (Array.isArray(item)) Object.freeze(item)
      }
      Object.freeze(value)
    }
  }
  return Object.freeze(headers)
}

/**
 * @param {string} protocol
 * @param {(req: ServerRequest, res: ServerResponse) => void | Promise<void>} handler
 * @param {string} method
 * @param {Record<string, string>} headers
 */
async function exchange (protocol, handler, method = 'OPTIONS', headers = requestHeaders) {
  const library = require(`node:${protocol}`)
  let failure
  let finishHandler
  const handled = new Promise(resolve => { finishHandler = resolve })
  const server = library.createServer(async (req, res) => {
    try {
      await handler(req, res)
    } catch (error) {
      failure = error
    }
    res.end()
    finishHandler()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const url = `http://127.0.0.1:${server.address().port}`
  let session
  try {
    let response
    if (protocol === 'http') {
      const request = library.request(url, { method, headers })
      const received = once(request, 'response')
      request.end()
      ;[response] = await received
      await text(response)
      response = response.headers
    } else {
      session = library.connect(url)
      const request = session.request({ ':method': method, ...headers })
      const received = once(request, 'response')
      request.end()
      ;[response] = await received
      await text(request)
    }
    await handled
    if (failure) throw failure
    return response
  } finally {
    if (session) {
      const closed = once(session, 'close')
      session.close()
      await closed
    }
    await new Promise(resolve => server.close(resolve))
  }
}
