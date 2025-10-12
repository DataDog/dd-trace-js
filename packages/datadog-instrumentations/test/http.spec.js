'use strict'

const dc = require('dc-polyfill')
const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')

const assert = require('node:assert')
const { EventEmitter } = require('events')

const agent = require('../../dd-trace/test/plugins/agent')

describe('client', () => {
  let url, http, startChannelCb, endChannelCb, asyncStartChannelCb, errorChannelCb

  const startChannel = dc.channel('apm:http:client:request:start')
  const endChannel = dc.channel('apm:http:client:request:end')
  const asyncStartChannel = dc.channel('apm:http:client:request:asyncStart')
  const errorChannel = dc.channel('apm:http:client:request:error')
  const responseDataChannel = dc.channel('apm:http:client:response:data')
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

      describe('response data and finish channels', () => {
        let responseDataChannelCb, responseFinishChannelCb
        const readableMethods = ['on', 'addListener']

        if (httpSchema === 'http') {
          readableMethods.push('once', 'prependListener')
        }

        before(() => {
          http = require(httpSchema)
          url = `${httpSchema}://www.datadoghq.com`
        })

        beforeEach(() => {
          responseDataChannelCb = sinon.stub()
          responseFinishChannelCb = sinon.stub()
          responseDataChannel.subscribe(responseDataChannelCb)
          responseFinishChannel.subscribe(responseFinishChannelCb)
        })

        afterEach(() => {
          responseDataChannel.unsubscribe(responseDataChannelCb)
          responseFinishChannel.unsubscribe(responseFinishChannelCb)
        })

          ;['on', 'addListener', 'once', 'prependListener'].forEach(method => {
            if (typeof EventEmitter.prototype[method] !== 'function') {
              return
            }

            it(`publishes data chunks when customer uses ${method} for data`, (done) => {
              http.get(url, (res) => {
                res[method]('data', () => {})
                res.on('end', () => {
                  try {
                    assert.strictEqual(stubHasResponseForUrl(url, responseDataChannelCb), true)
                    assert.strictEqual(stubHasResponseForUrl(url, responseFinishChannelCb), true)
                    done()
                  } catch (e) {
                    done(e)
                  }
                })
              })
            })
          })

        // Limit readable variants to ones that continue draining so TLS never stalls
        readableMethods.forEach(method => {
          if (typeof EventEmitter.prototype[method] !== 'function') {
            return
          }

          it(`publishes data chunks when customer uses ${method} for readable`, (done) => {
            http.get(url, (res) => {
              res.setEncoding('utf8')
              const consume = () => {
                let chunk
                while ((chunk = res.read()) !== null) {
                  // wrapping res.read() lets instrumentation capture each chunk
                }
              }

              res[method]('readable', consume)
              res.on('end', () => {
                try {
                  assert.strictEqual(stubHasResponseForUrl(url, responseDataChannelCb), true)
                  assert.strictEqual(stubHasResponseForUrl(url, responseFinishChannelCb), true)
                  done()
                } catch (e) {
                  done(e)
                }
              })
            })
          })
        })

        it('does not publish data chunks when customer does not consume response', (done) => {
          http.get(url, (res) => {
            // Don't attach data listener
            setTimeout(() => {
              try {
                assert.strictEqual(stubHasResponseForUrl(url, responseDataChannelCb), false)
                assert.strictEqual(stubHasResponseForUrl(url, responseFinishChannelCb), true)
                done()
              } catch (e) {
                done(e)
              }
            }, 100)
          })
        })

        it('publishes finish when customer attaches end listener', (done) => {
          http.get(url, (res) => {
            res.on('end', () => {
              try {
                assert.strictEqual(stubHasResponseForUrl(url, responseFinishChannelCb), true)
                done()
              } catch (e) {
                done(e)
              }
            })
          })
        })

        it('handles response close event', (done) => {
          http.get(url, (res) => {
            res.destroy()
            setTimeout(() => {
              try {
                assert.strictEqual(stubHasResponseForUrl(url, responseFinishChannelCb), true)
                done()
              } catch (e) {
                done(e)
              }
            }, 50)
          })
        })
      })
    })
  })
})
