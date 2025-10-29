'use strict'

const dc = require('dc-polyfill')
const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')

const assert = require('node:assert')

const agent = require('../../dd-trace/test/plugins/agent')

describe('client', () => {
  let url, http, startChannelCb, endChannelCb, asyncStartChannelCb, errorChannelCb

  const startChannel = dc.channel('apm:http:client:request:start')
  const endChannel = dc.channel('apm:http:client:request:end')
  const asyncStartChannel = dc.channel('apm:http:client:request:asyncStart')
  const errorChannel = dc.channel('apm:http:client:request:error')
  const responseFinishChannel = dc.channel('apm:http:client:response:finish')

  before(async () => {
    await agent.load('http')
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

  /*
   * Necessary because the tracer makes extra requests to the agent
   * and the same stub could be called multiple times
   */
  function getContextFromStubByUrl (url, stub) {
    for (const args of stub.args) {
      const arg = args[0]
      if (arg.args?.originalUrl === url) {
        return arg
      }
    }
    return null
  }

  function stubHasResponseForUrl (url, stub) {
    return stub.args.some(([payload]) => {
      const ctx = payload?.ctx
      const originalUrl = ctx?.args?.originalUrl || ctx?.args?.uri
      return originalUrl === url
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
          assert(ctx !== null)
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
                assert(ctx === null)
              }

              done()
            } catch (e) {
              done(e)
            }
          })
        })
      })

      describe('response finish channel', () => {
        let responseFinishChannelCb

        before(() => {
          http = require(httpSchema)
          url = `${httpSchema}://www.datadoghq.com`
        })

        beforeEach(() => {
          responseFinishChannelCb = sinon.stub()
          responseFinishChannel.subscribe(responseFinishChannelCb)
        })

        afterEach(() => {
          responseFinishChannel.unsubscribe(responseFinishChannelCb)
        })

        function setCollectBody (ctx) {
          if (ctx.args.originalUrl === url) {
            ctx.shouldCollectBody = true
          }
        }

        function getResponseFinishPayload (url, stub) {
          for (const args of stub.args) {
            const payload = args[0]
            const originalUrl = payload?.ctx?.args?.originalUrl || payload?.ctx?.args?.uri
            if (originalUrl === url) {
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

        it('collects and concatenates all chunks when ctx.shouldCollectBody is true', (done) => {
          startChannelCb.callsFake(setCollectBody)

          const chunks = []
          http.get(url, (res) => {
            res.on('data', (chunk) => {
              chunks.push(chunk)
            })
            res.on('end', () => {
              try {
                const payload = getResponseFinishPayload(url, responseFinishChannelCb)
                assert(Buffer.isBuffer(payload.body))

                const expectedBody = Buffer.concat(chunks)
                assert(payload.body.equals(expectedBody))

                done()
              } catch (e) {
                done(e)
              }
            })
          })
        })

        it('collects and concatenates string chunks when using setEncoding', (done) => {
          startChannelCb.callsFake(setCollectBody)

          const chunks = []
          http.get(url, (res) => {
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
                const payload = getResponseFinishPayload(url, responseFinishChannelCb)
                assert(typeof payload.body === 'string')

                const expectedBody = chunks.join('')
                assert.strictEqual(payload.body, expectedBody)

                done()
              } catch (e) {
                done(e)
              }
            })
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
