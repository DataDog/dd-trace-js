'use strict'

const assert = require('node:assert')
const { URL } = require('node:url')
const { inspect } = require('node:util')
const dc = require('dc-polyfill')
const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')

const agent = require('../../dd-trace/test/plugins/agent')

describe('client', () => {
  let tracer, url, http, startChannelCb, endChannelCb, asyncStartChannelCb, errorChannelCb

  const startChannel = dc.channel('apm:http:client:request:start')
  const endChannel = dc.channel('apm:http:client:request:end')
  const asyncStartChannel = dc.channel('apm:http:client:request:asyncStart')
  const errorChannel = dc.channel('apm:http:client:request:error')
  const responseFinishChannel = dc.channel('apm:http:client:response:finish')
  const responseStartChannel = dc.channel('apm:http:client:response:start')
  const serverFinishChannel = dc.channel('apm:http:server:request:finish')
  const serverPostFinishChannel = dc.channel('apm:http:server:request:postfinish')

  before(async () => {
    tracer = await agent.load('http')
  })

  after(() => {
    return agent.close()
  })

  beforeEach(() => {
    startChannelCb = sinon.stub()
    endChannelCb = sinon.stub()
    asyncStartChannelCb = sinon.stub()
    errorChannelCb = sinon.stub()

    startChannel.subscribe(startChannelCb)
    endChannel.subscribe(endChannelCb)
    asyncStartChannel.subscribe(asyncStartChannelCb)
    errorChannel.subscribe(errorChannelCb)
  })

  afterEach(() => {
    startChannel.unsubscribe(startChannelCb)
    endChannel.unsubscribe(endChannelCb)
    asyncStartChannel.unsubscribe(asyncStartChannelCb)
    errorChannel.unsubscribe(errorChannelCb)
  })

  // originalUrl is the raw http.request first arg (string, URL, or options); uri is always a string.
  function getRequestUrlString (args) {
    if (!args) return undefined
    const { originalUrl, uri } = args
    if (typeof originalUrl === 'string') return originalUrl
    if (originalUrl instanceof URL) return originalUrl.href
    return uri
  }

  /*
   * Necessary because the tracer makes extra requests to the agent
   * and the same stub could be called multiple times
   */
  function getContextFromStubByUrl (url, stub) {
    for (const args of stub.args) {
      const arg = args[0]
      if (getRequestUrlString(arg.args) === url) {
        return arg
      }
    }
    return null
  }

  function stubHasResponseForUrl (url, stub) {
    return stub.args.some(([payload]) => {
      return getRequestUrlString(payload?.ctx?.args) === url
    })
  }

  ['http', 'https'].forEach((httpSchema) => {
    describe(`using ${httpSchema}`, () => {
      describe('abort controller', () => {
        function abortCallback (ctx) {
          if (ctx.args.originalUrl === url) {
            ctx.abortController.abort()
          }
        }

        before(() => {
          http = require(httpSchema)
          url = `${httpSchema}://www.datadoghq.com`
        })

        it('abortController is sent on startChannel', (done) => {
          http.get(url, (res) => {
            res.on('data', () => {})
            res.on('end', () => {
              done()
            })
          })

          sinon.assert.called(startChannelCb)
          const ctx = getContextFromStubByUrl(url, startChannelCb)
          assert.notStrictEqual(ctx, null)
          assert(ctx.abortController instanceof AbortController)
        })

        it('Request is aborted', (done) => {
          startChannelCb.callsFake(abortCallback)

          const cr = http.get(url, () => {
            done(new Error('Request should be blocked'))
          })

          cr.on('error', () => {
            done()
          })
        })

        it('Request is aborted with custom error', (done) => {
          class CustomError extends Error { }

          startChannelCb.callsFake((ctx) => {
            if (ctx.args.originalUrl === url) {
              ctx.abortController.abort(new CustomError('Custom error'))
            }
          })

          const cr = http.get(url, () => {
            done(new Error('Request should be blocked'))
          })

          cr.on('error', (e) => {
            try {
              assert(e instanceof CustomError)
              assert.strictEqual(e.message, 'Custom error')

              done()
            } catch (e) {
              done(e)
            }
          })
        })

        it('Error is sent on errorChannel on abort', (done) => {
          startChannelCb.callsFake(abortCallback)

          const cr = http.get(url, () => {
            done(new Error('Request should be blocked'))
          })

          cr.on('error', () => {
            try {
              sinon.assert.calledOnce(errorChannelCb)
              assert(errorChannelCb.firstCall.args[0].error instanceof Error)

              done()
            } catch (e) {
              done(e)
            }
          })
        })

        it('endChannel is called on abort', (done) => {
          startChannelCb.callsFake(abortCallback)

          const cr = http.get(url, () => {
            done(new Error('Request should be blocked'))
          })

          cr.on('error', () => {
            try {
              sinon.assert.called(endChannelCb)
              const ctx = getContextFromStubByUrl(url, endChannelCb)
              assert.strictEqual(ctx.args.originalUrl, url)

              done()
            } catch (e) {
              done(e)
            }
          })
        })

        it('asyncStartChannel is not called on abort', (done) => {
          startChannelCb.callsFake(abortCallback)

          const cr = http.get(url, () => {
            done(new Error('Request should be blocked'))
          })

          cr.on('error', () => {
            try {
              // Necessary because the tracer makes extra requests to the agent
              if (asyncStartChannelCb.called) {
                const ctx = getContextFromStubByUrl(url, asyncStartChannelCb)
                assert.strictEqual(ctx, null)
              }

              done()
            } catch (e) {
              done(e)
            }
          })
        })
      })

      describe('response finish channel', () => {
        let responseFinishChannelCb, responseStartChannelCb

        before(() => {
          http = require(httpSchema)
          url = `${httpSchema}://www.datadoghq.com`
        })

        beforeEach(() => {
          responseFinishChannelCb = sinon.stub()
          responseFinishChannel.subscribe(responseFinishChannelCb)

          responseStartChannelCb = sinon.stub()
          responseStartChannel.subscribe(responseStartChannelCb)
        })

        afterEach(() => {
          responseFinishChannel.unsubscribe(responseFinishChannelCb)
          responseStartChannel.unsubscribe(responseStartChannelCb)
        })

        it('publishes response:start before response:finish for the same request', (done) => {
          http.get(url, (res) => {
            res.resume()
            res.on('end', () => {
              try {
                sinon.assert.called(responseStartChannelCb)
                sinon.assert.called(responseFinishChannelCb)
                assert.ok(responseStartChannelCb.calledBefore(responseFinishChannelCb))
                done()
              } catch (e) {
                done(e)
              }
            })
          })
        })

        function isLocalServerRequest (args) {
          const requestUrl = getRequestUrlString(args)
          return typeof requestUrl === 'string' && requestUrl.startsWith('http://127.0.0.1:')
        }

        function setCollectBody (ctx) {
          const requestUrl = getRequestUrlString(ctx.args)
          // External tests use `url` (datadoghq); local server tests use 127.0.0.1 and never match it.
          if (requestUrl === url || isLocalServerRequest(ctx.args)) {
            ctx.shouldCollectBody = true
          }
        }

        function getResponseFinishPayload (requestUrl, stub) {
          for (const args of stub.args) {
            const payload = args[0]
            if (getRequestUrlString(payload?.ctx?.args) === requestUrl) {
              return payload
            }
          }
          return null
        }

        it('publishes finish when customer uses for-await to consume', (done) => {
          http.get(url, (res) => {
            (async () => {
              for await (const _ of res) { // eslint-disable-line no-unused-vars
                // consume without capturing
              }
              assert.strictEqual(stubHasResponseForUrl(url, responseFinishChannelCb), true)
            })().then(() => done(), done)
          })
        })

        it('publishes finish on response close event', (done) => {
          http.get(url, (res) => {
            res.destroy()
            setTimeout(() => {
              try {
                assert.strictEqual(stubHasResponseForUrl(url, responseFinishChannelCb), true)
                done()
              } catch (e) {
                done(e)
              }
            }, 100)
          })
        })

        // Local server tests use plain http:// URLs; skip under the https schema loop.
        const describeIfHttp = httpSchema === 'http' ? describe : describe.skip

        describeIfHttp('with local http server', () => {
          it('keeps response events unchanged without lifecycle subscribers', async () => {
            tracer.use('http', false)
            let finished = false
            const server = http.createServer((req, res) => {
              res.on('finish', () => {
                finished = true
              })
              res.end()
            })

            try {
              await new Promise(resolve => server.listen(0, resolve))
              await new Promise((resolve, reject) => {
                http.get(`http://127.0.0.1:${server.address().port}/`, res => {
                  res.resume()
                  res.on('end', resolve)
                }).on('error', reject)
              })
            } finally {
              await new Promise(resolve => server.close(resolve))
              tracer.use('http', {})
            }

            assert.strictEqual(finished, true)
          })

          it('publishes server postfinish after response listeners', async () => {
            const calls = []
            const onFinish = () => calls.push('finish')
            const onPostFinish = () => calls.push('postfinish')
            serverFinishChannel.subscribe(onFinish)
            serverPostFinishChannel.subscribe(onPostFinish)
            const server = http.createServer((req, res) => {
              res.on('finish', () => calls.push('listener'))
              res.end()
            })

            try {
              await new Promise(resolve => server.listen(0, resolve))
              await new Promise((resolve, reject) => {
                http.get(`http://127.0.0.1:${server.address().port}/`, res => {
                  res.resume()
                  res.on('end', resolve)
                }).on('error', reject)
              })
            } finally {
              serverFinishChannel.unsubscribe(onFinish)
              serverPostFinishChannel.unsubscribe(onPostFinish)
              await new Promise(resolve => server.close(resolve))
            }

            assert.deepStrictEqual(calls, ['finish', 'listener', 'postfinish'])
          })

          function requestWithLocalServer ({ responseHeaders, responseBody, onResponse }, done) {
            const server = http.createServer((req, res) => {
              res.writeHead(200, responseHeaders)
              if (responseBody != null) {
                res.end(responseBody)
              } else {
                res.end()
              }
            })

            server.listen(0, () => {
              const localUrl = `http://127.0.0.1:${server.address().port}/`
              startChannelCb.callsFake(setCollectBody)

              http.get(localUrl, (res) => {
                onResponse(res, server, localUrl, done)
              }).on('error', (err) => {
                server.close(() => done(err))
              })
            })
          }

          function requestWithLocalJsonBody (onResponse, done) {
            const body = JSON.stringify({ ok: true })
            requestWithLocalServer({
              responseHeaders: {
                'content-type': 'application/json',
                'content-length': String(Buffer.byteLength(body)),
              },
              responseBody: body,
              onResponse,
            }, done)
          }

          it('collects and concatenates all chunks when ctx.shouldCollectBody is true', (done) => {
            const chunks = []
            requestWithLocalJsonBody((res, server, localUrl, done) => {
              res.on('data', (chunk) => {
                chunks.push(chunk)
              })
              res.on('end', () => {
                try {
                  const payload = getResponseFinishPayload(localUrl, responseFinishChannelCb)
                  assert(Buffer.isBuffer(payload.body), `Expected Buffer, got ${inspect(payload.body)}`)

                  const expectedBody = Buffer.concat(chunks)
                  assert.deepStrictEqual(payload.body, expectedBody)

                  server.close(() => done())
                } catch (e) {
                  server.close(() => done(e))
                }
              })
            }, done)
          })

          it('collects and concatenates string chunks when using setEncoding', (done) => {
            const chunks = []
            requestWithLocalJsonBody((res, server, localUrl, done) => {
              res.setEncoding('utf8')
              const consume = () => {
                let chunk
                while ((chunk = res.read()) !== null) {
                  chunks.push(chunk)
                }
              }

              res.on('readable', consume)
              res.on('end', () => {
                try {
                  const payload = getResponseFinishPayload(localUrl, responseFinishChannelCb)
                  assert.strictEqual(typeof payload.body, 'string')

                  const expectedBody = chunks.join('')
                  assert.strictEqual(payload.body, expectedBody)

                  server.close(() => done())
                } catch (e) {
                  server.close(() => done(e))
                }
              })
            }, done)
          })

          it('should collect data correctly when read and data are both used', (done) => {
            const chunks = []
            requestWithLocalJsonBody((res, server, localUrl, done) => {
              res.setEncoding('utf8')
              // eslint-disable-next-line sonarjs/no-identical-functions -- per-test chunks buffer
              const consume = () => {
                let chunk
                while ((chunk = res.read()) !== null) {
                  chunks.push(chunk)
                }
              }
              res.on('data', () => {})

              res.on('readable', consume)
              res.on('end', () => {
                try {
                  const payload = getResponseFinishPayload(localUrl, responseFinishChannelCb)
                  assert.strictEqual(typeof payload.body, 'string')

                  const expectedBody = chunks.join('')
                  assert.strictEqual(payload.body, expectedBody)

                  server.close(() => done())
                } catch (e) {
                  server.close(() => done(e))
                }
              })
            }, done)
          })

          it('should collect data correctly when read and data are both used in different order', (done) => {
            const chunks = []
            requestWithLocalJsonBody((res, server, localUrl, done) => {
              let onDataAdded = false
              res.setEncoding('utf8')
              const consume = () => {
                let chunk
                while ((chunk = res.read(100)) !== null) {
                  if (!onDataAdded) {
                    onDataAdded = true
                    res.on('data', () => {})
                  }
                  chunks.push(chunk)
                }
              }
              res.on('readable', consume)
              res.on('end', () => {
                try {
                  const payload = getResponseFinishPayload(localUrl, responseFinishChannelCb)
                  assert.strictEqual(typeof payload.body, 'string')
                  const expectedBody = chunks.join('')
                  assert.strictEqual(payload.body, expectedBody)

                  server.close(() => done())
                } catch (e) {
                  server.close(() => done(e))
                }
              })
            }, done)
          })
        })

        it('does not collect body when ctx.shouldCollectBody is false', (done) => {
          // Don't set shouldCollectBody flag

          http.get(url, (res) => {
            res.on('data', () => {})
            res.on('end', () => {
              try {
                const payload = getResponseFinishPayload(url, responseFinishChannelCb)
                assert.strictEqual(payload.body, null)
                done()
              } catch (e) {
                done(e)
              }
            })
          })
        })

        it('does not collect body when customer does not consume response', (done) => {
          startChannelCb.callsFake(setCollectBody)

          http.get(url, (res) => {
            // Don't attach data listener
            setTimeout(() => {
              try {
                const payload = getResponseFinishPayload(url, responseFinishChannelCb)
                assert.strictEqual(payload.body, null)
                done()
              } catch (e) {
                done(e)
              }
            }, 100)
          })
        })
      })
    })
  })
})
