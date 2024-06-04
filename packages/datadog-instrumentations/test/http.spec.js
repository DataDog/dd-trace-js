'use strict'

const { assert } = require('chai')
const dc = require('dc-polyfill')

const agent = require('../../dd-trace/test/plugins/agent')
describe('client', () => {
  let url, http, startChannelCb, finishChannelCb, endChannelCb, asyncStartChannelCb, errorChannelCb

  const startChannel = dc.channel('apm:http:client:request:start')
  const finishChannel = dc.channel('apm:http:client:request:finish')
  const endChannel = dc.channel('apm:http:client:request:end')
  const asyncStartChannel = dc.channel('apm:http:client:request:asyncStart')
  const errorChannel = dc.channel('apm:http:client:request:error')

  before(async () => {
    await agent.load('http')
  })

  after(() => {
    return agent.close()
  })

  beforeEach(() => {
    startChannelCb = sinon.stub()
    startChannel.subscribe(startChannelCb)
    finishChannelCb = sinon.stub()
    finishChannel.subscribe(finishChannelCb)
    endChannelCb = sinon.stub()
    endChannel.subscribe(endChannelCb)
    asyncStartChannelCb = sinon.stub()
    asyncStartChannel.subscribe(asyncStartChannelCb)
    errorChannelCb = sinon.stub()
    errorChannel.subscribe(errorChannelCb)
  })

  afterEach(() => {
    startChannel.unsubscribe(startChannelCb)
    finishChannel.unsubscribe(finishChannelCb)
    endChannel.unsubscribe(endChannelCb)
    asyncStartChannel.unsubscribe(asyncStartChannelCb)
    errorChannel.unsubscribe(errorChannelCb)
  })

  /*
   * Necessary because the tracer makes extra requests to the agent
   * and the same stub could be called multiple times
   */
  function getContextFromStubByUrl (url, stub) {
    for (let i = 0; i < stub.args.length; i++) {
      const arg = stub.args[i][0]
      if (arg.args?.originalUrl === url) {
        return arg
      }
    }

    return null
  }

  ['http', 'https'].forEach((httpSchema) => {
    describe(`using ${httpSchema}`, () => {
      describe('abort controller', () => {
        function abortCallback (ctx) {
          if (ctx.args.originalUrl === url) {
            ctx.abortData.abortController.abort()
          }
        }

        before(() => {
          http = require(httpSchema)
          url = `${httpSchema}://www.datadoghq.com`
        })

        it('abortData is sent on startChannel', (done) => {
          http.get(url, (res) => {
            res.on('data', () => {
            })
            res.on('end', () => {
              done()
            })
          })

          sinon.assert.called(startChannelCb)
          const ctx = getContextFromStubByUrl(url, startChannelCb)
          assert.isNotNull(ctx)
          assert.instanceOf(ctx.abortData.abortController, AbortController)
        })

        it('Request is aborted with default error', (done) => {
          startChannelCb.callsFake(abortCallback)

          const cr = http.get(url, () => {
            done('Request should be blocked')
          })
          cr.on('error', (e) => {
            try {
              assert.instanceOf(e, Error)
              assert.strictEqual(e.message, 'Aborted')
              done()
            } catch (e) {
              done(e)
            }
          })
        })

        it('Request is aborted with custom error', (done) => {
          class CustomError extends Error {
          }

          startChannelCb.callsFake((ctx) => {
            if (ctx.args.originalUrl === url) {
              ctx.abortData.abortController.abort()
              ctx.abortData.error = new CustomError('Custom error')
            }
          })

          const cr = http.get(url, () => {
            done('Request should be blocked')
          })
          cr.on('error', (e) => {
            try {
              assert.instanceOf(e, CustomError)
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
            done('Request should be blocked')
          })
          cr.on('error', () => {
            try {
              sinon.assert.calledOnce(errorChannelCb)
              assert.instanceOf(errorChannelCb.firstCall.args[0].error, Error)
              done()
            } catch (e) {
              done(e)
            }
          })
        })

        it('endChannel is called on abort', (done) => {
          startChannelCb.callsFake(abortCallback)

          const cr = http.get(url, () => {
            done('Request should be blocked')
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
            done('Request should be blocked')
          })
          cr.on('error', () => {
            try {
              // Necessary because the tracer makes extra requests to the agent
              if (asyncStartChannelCb.called) {
                const ctx = getContextFromStubByUrl(url, asyncStartChannelCb)
                assert.isNull(ctx)
              }
              done()
            } catch (e) {
              done(e.message)
            }
          })
        }).timeout(1000)
      })
    })
  })
})
