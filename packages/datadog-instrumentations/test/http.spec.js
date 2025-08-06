'use strict'

const { assert } = require('chai')
const dc = require('dc-polyfill')

const agent = require('../../dd-trace/test/plugins/agent')
describe('client', () => {
  let url, http, startChannelCb, endChannelCb, asyncStartChannelCb, errorChannelCb

  const startChannel = dc.channel('apm:http:client:request:start')
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
          assert.isNotNull(ctx)
          assert.instanceOf(ctx.abortController, AbortController)
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
            done(new Error('Request should be blocked'))
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
                assert.isNull(ctx)
              }

              done()
            } catch (e) {
              done(e.message)
            }
          })
        })
      })
    })
  })
})

describe('server', () => {
  let http, server, port
  let startServerCh, startServerSpy

  before(async () => {
    await agent.load('http')
  })

  after(() => {
    return agent.close()
  })

  beforeEach(() => {
    http = require('http')
    startServerCh = dc.channel('apm:http:server:request:start')
    startServerSpy = sinon.stub()
    startServerCh.subscribe(startServerSpy)

    // Mock global tracer for server-side handling
    global._ddtrace = require('../../dd-trace')
  })

  afterEach((done) => {
    startServerCh.unsubscribe(startServerSpy)
    if (server) {
      server.close(done)
    } else {
      done()
    }
  })

  describe('PubSub detection integration', () => {
    beforeEach((done) => {
      server = http.createServer((req, res) => {
        res.writeHead(200)
        res.end('OK')
      })
      server.listen(0, () => {
        port = server.address().port
        done()
      })
    })

    it('should publish to startServerCh for PubSub requests', (done) => {
      const pubsubPayload = JSON.stringify({
        message: {
          data: Buffer.from('test').toString('base64'),
          messageId: 'test-id',
          attributes: { 'pubsub.topic': 'test-topic' }
        },
        subscription: 'projects/test/subscriptions/test'
      })

      const req = http.request({
        hostname: 'localhost',
        port,
        path: '/',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'APIs-Google; (+https://developers.google.com/webmasters/APIs-Google.html)',
          'Content-Length': Buffer.byteLength(pubsubPayload)
        }
      }, (res) => {
        res.on('data', () => {})
        res.on('end', () => {
          // Verify the channel was called
          setTimeout(() => {
            expect(startServerSpy).to.have.been.called
            done()
          }, 50)
        })
      })

      req.write(pubsubPayload)
      req.end()
    })

    it('should publish to startServerCh for Eventarc Cloud Events', (done) => {
      const eventarcPayload = JSON.stringify({
        message: {
          data: Buffer.from('test').toString('base64'),
          messageId: 'test-eventarc-id',
          attributes: {
            'pubsub.topic': 'test-topic',
            traceparent: '00-abc123-def456-01'
          }
        },
        subscription: 'projects/test/subscriptions/eventarc-sub'
      })

      const req = http.request({
        hostname: 'localhost',
        port,
        path: '/',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'ce-specversion': '1.0',
          'ce-type': 'google.cloud.pubsub.topic.v1.messagePublished',
          'ce-source': '//pubsub.googleapis.com/projects/test/topics/test-topic',
          'ce-id': 'test-eventarc-id',
          'Content-Length': Buffer.byteLength(eventarcPayload)
        }
      }, (res) => {
        res.on('data', () => {})
        res.on('end', () => {
          setTimeout(() => {
            expect(startServerSpy).to.have.been.called
            done()
          }, 50)
        })
      })

      req.write(eventarcPayload)
      req.end()
    })

    it('should publish to startServerCh for regular HTTP requests', (done) => {
      const req = http.request({
        hostname: 'localhost',
        port,
        path: '/',
        method: 'GET'
      }, (res) => {
        res.on('data', () => {})
        res.on('end', () => {
          setTimeout(() => {
            expect(startServerSpy).to.have.been.called
            done()
          }, 50)
        })
      })

      req.end()
    })
  })

  describe('error handling for server', () => {
    beforeEach((done) => {
      server = http.createServer((req, res) => {
        res.writeHead(200)
        res.end('OK')
      })
      server.listen(0, () => {
        port = server.address().port
        done()
      })
    })

    it('should handle request errors gracefully', (done) => {
      const req = http.request({
        hostname: 'localhost',
        port,
        path: '/',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'APIs-Google; (+https://developers.google.com/webmasters/APIs-Google.html)'
        }
      }, (res) => {
        res.on('data', () => {})
        res.on('end', done)
      })

      // Simulate request error
      req.on('error', () => {
        // Error should be handled gracefully
        done()
      })

      req.write('invalid')
      req.destroy(new Error('Simulated error'))
    })
  })
})
