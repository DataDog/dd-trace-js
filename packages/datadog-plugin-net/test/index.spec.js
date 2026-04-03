'use strict'

const assert = require('node:assert/strict')
const dns = require('node:dns')

const { afterEach, beforeEach, describe, it } = require('mocha')

const { assertObjectContains } = require('../../../integration-tests/helpers')
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')
const agent = require('../../dd-trace/test/plugins/agent')
const { expectSomeSpan } = require('../../dd-trace/test/plugins/helpers')
const { withPeerService } = require('../../dd-trace/test/setup/mocha')

describe('Plugin', () => {
  let net
  let tcp
  let ipc
  let port
  let tracer
  let parent

  before(() => {
    require('events').defaultMaxListeners = 5
  })

  ;['net', 'node:net'].forEach(pluginToBeLoaded => {
    describe(pluginToBeLoaded, () => {
      afterEach(() => {
        return agent.close()
      })

      afterEach(() => {
        tcp.close()
      })

      afterEach(() => {
        ipc.close()
      })

      beforeEach(() => {
        return agent.load(['net', 'dns'])
          .then(() => {
            net = require(pluginToBeLoaded)
            tracer = require('../../dd-trace')
            parent = tracer.startSpan('parent')
            parent.finish()
          }).then(_port => {
            return new Promise(resolve => setImmediate(resolve))
          })
      })

      beforeEach(done => {
        tcp = new net.Server(socket => {
          socket.write('')
        })
        tcp.listen(0, () => {
          port = tcp.address().port
          done()
        })
      })

      beforeEach(done => {
        ipc = new net.Server(socket => {
          socket.write('')
        })
        ipc.listen('/tmp/dd-trace.sock', () => done())
      })

      it('should instrument connect with a path', done => {
        expectSomeSpan(agent, {
          name: 'ipc.connect',
          service: 'test',
          resource: '/tmp/dd-trace.sock',
          meta: {
            'span.kind': 'client',
            'ipc.path': '/tmp/dd-trace.sock',
          },
          parent_id: BigInt(parent.context()._spanId.toString(10)),
        }).then(done).catch(done)

        tracer.scope().activate(parent, () => {
          const socket = net.connect('/tmp/dd-trace.sock')
          assert.strictEqual(socket.listenerCount('error'), 0)
        })
      })

      it('should instrument dns', done => {
        const socket = new net.Socket()
        tracer.scope().activate(parent, () => {
          socket.connect(port, 'localhost')
          socket.on('connect', () => {
            expectSomeSpan(agent, {
              name: 'dns.lookup',
              service: 'test',
              resource: 'localhost',
            }, 2000).then(done).catch(done)
          })
          assert.strictEqual(socket.listenerCount('error'), 0)
        })
      })

      withPeerService(
        () => tracer,
        'net',
        (done) => {
          const socket = new net.Socket()
          socket.connect(port, 'localhost')
          done()
        },
        'localhost',
        'out.host'
      )

      it('should instrument connect with a port', done => {
        const socket = new net.Socket()
        tracer.scope().activate(parent, () => {
          socket.connect(port, 'localhost')
          socket.on('connect', () => {
            expectSomeSpan(agent, {
              name: 'tcp.connect',
              service: 'test',
              resource: `localhost:${port}`,
              meta: {
                component: 'net',
                'span.kind': 'client',
                'tcp.family': 'IPv4',
                'tcp.remote.host': 'localhost',
                'tcp.local.address': socket.localAddress,
                'out.host': 'localhost',
              },
              metrics: {
                'network.destination.port': port,
                'tcp.remote.port': port,
                'tcp.local.port': socket.localPort,
              },
              parent_id: BigInt(parent.context()._spanId.toString(10)),
            }, 2000).then(done).catch(done)
          })
          assert.strictEqual(socket.listenerCount('error'), 0)
        })
      })

      it('should instrument connect with TCP options', done => {
        const socket = new net.Socket()
        tracer.scope().activate(parent, () => {
          socket.connect({
            port,
            host: 'localhost',
          })
          socket.on('connect', () => {
            expectSomeSpan(agent, {
              name: 'tcp.connect',
              service: 'test',
              resource: `localhost:${port}`,
              meta: {
                component: 'net',
                'span.kind': 'client',
                'tcp.family': 'IPv4',
                'tcp.remote.host': 'localhost',
                'tcp.local.address': socket.localAddress,
                'out.host': 'localhost',
              },
              metrics: {
                'network.destination.port': port,
                'tcp.remote.port': port,
                'tcp.local.port': socket.localPort,
              },
              parent_id: BigInt(parent.context()._spanId.toString(10)),
            }).then(done).catch(done)
          })
        })
      })

      it('should instrument connect with IPC options', done => {
        expectSomeSpan(agent, {
          name: 'ipc.connect',
          service: 'test',
          resource: '/tmp/dd-trace.sock',
          meta: {
            component: 'net',
            'span.kind': 'client',
            'ipc.path': '/tmp/dd-trace.sock',
          },
          parent_id: BigInt(parent.context()._spanId.toString(10)),
        }).then(done).catch(done)

        tracer.scope().activate(parent, () => {
          net.connect({
            path: '/tmp/dd-trace.sock',
          })
        })
      })

      it('should instrument error', done => {
        const socket = new net.Socket()

        let error = null

        agent
          .assertSomeTraces(traces => {
            assertObjectContains(traces[0][0], {
              name: 'tcp.connect',
              service: 'test',
              resource: `localhost:${port}`,
            })
            assertObjectContains(traces[0][0].meta, {
              component: 'net',
              'span.kind': 'client',
              'tcp.family': 'IPv4',
              'tcp.remote.host': 'localhost',
              'out.host': 'localhost',
              [ERROR_TYPE]: error.name,
              [ERROR_MESSAGE]: error.message || error.code,
              [ERROR_STACK]: error.stack,
            })
            assertObjectContains(traces[0][0].metrics, {
              'network.destination.port': port,
              'tcp.remote.port': port,
            })
            assert.strictEqual(traces[0][0].parent_id.toString(), parent.context().toSpanId())
          })
          .then(done)
          .catch(done)

        tracer.scope().activate(parent, () => {
          tcp.close()
          socket.connect({ port })
          socket.once('error', (err) => {
            error = err
          })
        })
      })

      it('should cleanup event listeners when the socket changes state', done => {
        const socket = new net.Socket()

        tracer.scope().activate(parent, () => {
          const events = ['connect', 'error', 'close', 'timeout']

          socket.connect({ port })
          socket.destroy()

          socket.once('close', () => {
            setImmediate(() => {
              // Node.js 21.2 broke this function. We'll have to do the more manual way for now.
              // assert.ok((socket.eventNames(), events)
              for (const event of events) {
                assert.strictEqual(socket.listeners(event).length, 0)
              }
              done()
            })
          })
        })
      })

      it('should run event listeners in the correct scope', () => {
        return tracer.scope().activate(parent, () => {
          const socket = new net.Socket()

          const promises = Array(5).fill(0).map(() => {
            let res
            let rej
            const p = new Promise((resolve, reject) => {
              res = resolve
              rej = reject
            })
            p.resolve = res
            p.reject = rej
            return p
          })

          socket.on('connect', () => {
            assert.strictEqual(tracer.scope().active(), parent)
            promises[0].resolve()
          })

          socket.on('ready', () => {
            assert.strictEqual(tracer.scope().active(), parent)
            socket.destroy()
            promises[1].resolve()
          })

          socket.on('close', () => {
            assert.notStrictEqual(tracer.scope().active(), null)
            assert.strictEqual(tracer.scope().active().context()._name, 'tcp.connect')
            promises[2].resolve()
          })

          socket.on('lookup', () => {
            assert.notStrictEqual(tracer.scope().active(), null)
            assert.strictEqual(tracer.scope().active().context()._name, 'tcp.connect')
            promises[3].resolve()
          })

          socket.connect({
            port,
            lookup: (...args) => {
              assert.notStrictEqual(tracer.scope().active(), null)
              assert.strictEqual(tracer.scope().active().context()._name, 'tcp.connect')
              promises[4].resolve()
              dns.lookup(...args)
            },
          })

          return Promise.all(promises)
        })
      })

      it('should run the connection callback in the correct scope', done => {
        const socket = new net.Socket()

        tracer.scope().activate(parent, () => {
          socket.connect({ port }, function () {
            assert.strictEqual(this, socket)
            assert.strictEqual(tracer.scope().active(), parent)
            socket.destroy()
            done()
          })
        })
      })

      it('should not crash when a handled socket error occurs', done => {
        // When an app attaches an 'error' listener, the process must not crash.
        // Verifies dd-trace net instrumentation does not interfere with normal
        // error propagation on sockets.
        const server = new net.Server(serverSocket => {
          setImmediate(() => serverSocket.destroy())
        })

        server.listen(0, () => {
          const serverPort = server.address().port
          let errorHandled = false

          // Fail the test if an unhandled exception escapes — this is the
          // exact symptom from APMS-18805 (pod crash).
          const uncaughtGuard = (err) => {
            done(new Error(`uncaughtException should not fire with an error listener: ${err.message}`))
          }
          process.once('uncaughtException', uncaughtGuard)

          const failTimer = setTimeout(() => {
            process.removeListener('uncaughtException', uncaughtGuard)
            server.close()
            done(new Error('socket error was not emitted within timeout'))
          }, 4000)

          tracer.scope().activate(parent, () => {
            const socket = new net.Socket()

            socket.once('error', (err) => {
              errorHandled = true
              clearTimeout(failTimer)
              process.removeListener('uncaughtException', uncaughtGuard)

              assert.ok(err, 'error event should provide an error object')
              assert.ok(
                err.code === 'ECONNRESET' || err.code === 'EPIPE',
                `expected ECONNRESET or EPIPE, got ${err.code}`,
              )
              socket.destroy()
              server.close()
              done()
            })

            socket.connect(serverPort, 'localhost', () => {
              setImmediate(() => {
                socket.write('trigger socket error')
              })
            })
          })
        })
      }).timeout(5000)

      it('should preserve the native error shape through the wrapped emit', done => {
        // The error emitted through dd-trace's wrapped Socket.emit must be an
        // unmodified Node.js system error (no custom wrapper, same fields).
        const server = new net.Server(serverSocket => {
          setImmediate(() => serverSocket.destroy())
        })

        server.listen(0, () => {
          const serverPort = server.address().port

          const failTimer = setTimeout(() => {
            server.close()
            done(new Error('socket error was not emitted within timeout'))
          }, 4000)

          tracer.scope().activate(parent, () => {
            const socket = new net.Socket()

            socket.once('error', (err) => {
              clearTimeout(failTimer)

              // Must be a native Error — not wrapped or replaced by dd-trace
              assert.ok(err instanceof Error, 'error should be an Error instance')
              assert.strictEqual(typeof err.code, 'string', 'error should have a string code')
              assert.strictEqual(typeof err.syscall, 'string', 'error should have a string syscall')
              assert.strictEqual(typeof err.errno, 'number', 'error should have a numeric errno')
              assert.strictEqual(err.constructor.name, 'Error', 'error should not be a custom wrapper type')

              socket.destroy()
              server.close()
              done()
            })

            socket.connect(serverPort, 'localhost', () => {
              setImmediate(() => {
                socket.write('trigger socket error')
              })
            })
          })
        })
      }).timeout(5000)
    })
  })
})
