'use strict'

const assert = require('node:assert')
const { once } = require('node:events')

const { expect } = require('chai')
const { after, afterEach, before, beforeEach, describe, it } = require('mocha')

const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')

describe('Plugin', () => {
  let WebSocket
  let wsServer
  let connectionReceived
  let clientPort = 6015
  let client
  let messageReceived
  let route

  describe('ws', () => {
    withVersions('ws', 'ws', '>=8.0.0', version => {
      describe('regression tests', () => {
        before(async () => {
          await agent.load(['ws'], [{
            service: 'some',
            traceWebsocketMessagesEnabled: true
          }])
          WebSocket = require(`../../../versions/ws@${version}`).get()
        })

        it('should emit original error in case close is called before connection is established', async () => {
          const socket = new WebSocket('wss://localhost:12345')

          const errorPromise = once(socket, 'error')
          socket.close()

          const error = await errorPromise

          // Some versions emit an array with an error, some directly emit the error
          assert.strictEqual(error?.[0]?.message, 'WebSocket was closed before the connection was established')
        })

        after(async () => {
          agent.close({ ritmReset: false, wipe: true })
        })
      })

      describe('when using WebSocket', () => {
        route = 'test'
        beforeEach(async () => {
          await agent.load(['ws'], [{
            service: 'some',
            traceWebsocketMessagesEnabled: true
          }])
          WebSocket = require(`../../../versions/ws@${version}`).get()

          wsServer = new WebSocket.Server({ port: clientPort })

          client = new WebSocket(`ws://localhost:${clientPort}/${route}?active=true`)
        })

        afterEach(async () => {
          clientPort++
          agent.close({ ritmReset: false, wipe: true })
        })

        it('should do automatic instrumentation and remove broken handler', () => {
          wsServer.on('connection', (ws) => {
            connectionReceived = true
            ws.send('test message')
          })

          const brokenHandler = () => {
            throw new Error('broken handler')
          }

          client.on('message', brokenHandler)

          client.addListener('message', (msg) => {
            assert.strictEqual(msg.toString(), 'test message')
          })

          client.off('message', brokenHandler)

          return agent.assertFirstTraceSpan({
            name: 'websocket.send',
            type: 'websocket',
            resource: `websocket /${route}`,
            service: 'some',
            parent_id: 0n,
            error: 0,
            meta: {
              'span.kind': 'producer',
            }
          })
        })

        it('should do automatic instrumentation for server connections', done => {
          connectionReceived = false

          wsServer.on('connection', (ws) => {
            connectionReceived = true
            ws.send('echo')
          })

          client.on('open', () => {
            setTimeout(() => {
              assert.strictEqual(connectionReceived, true)
            }, 1000)
          })

          client.on('message', msg => {
            assert.strictEqual(msg.toString(), 'echo')
          })
          setTimeout(() => {
            done()
          }, 1000)
          client.on('error', done)
        })

        it('should instrument message sending', done => {
          wsServer.on('connection', ws => {
            connectionReceived = true
            ws.on('message', msg => {
              // Echo back the message with "server:" prefix
              ws.send(msg)
            })
          })

          client.on('open', () => {
            client.send('test message')
          })

          const brokenHandler = () => {
            throw new Error('broken handler')
          }

          client.addListener('message', brokenHandler)

          client.on('message', (data) => {
            assert.strictEqual(data.toString(), 'test message')
            done()
          })

          client.removeListener('message', brokenHandler)

          client.on('error', done)
        })

        it('should instrument message receiving', () => {
          wsServer.on('connection', (ws) => {
            ws.on('message', (data) => {
              assert.strictEqual(data.toString(), 'test message from client')
            })
          })

          client.on('open', () => {
            client.send('test message from client')
          })

          return Promise.race([
            once(client, 'error'),
            agent.assertFirstTraceSpan({
              name: 'websocket.receive',
              resource: `websocket /${route}`
            })
          ])
        })

        it('should instrument connection close', () => {
          client.removeAllListeners()
          wsServer.on('connection', (ws) => {
            ws.close()
          })

          return agent.assertSomeTraces(traces => {
            assert.strictEqual(traces[0][0].name, 'websocket.close')
          })
        })
      })

      describe('with service configuration', () => {
        beforeEach(async () => {
          await agent.load(['ws'], [{
            service: 'custom-ws-service',
            traceWebsocketMessagesEnabled: true
          }])
          WebSocket = require(`../../../versions/ws@${version}`).get()

          wsServer = new WebSocket.Server({ port: clientPort })

          client = new WebSocket(`ws://localhost:${clientPort}/${route}?active=true`)
        })

        afterEach(async () => {
          clientPort++
          agent.close({ ritmReset: false, wipe: true })
        })

        it('should work with custom service configuration', () => {
          wsServer.on('connection', (ws) => {
          })
          messageReceived = false

          return agent.assertSomeTraces(traces => {
            assert.strictEqual(traces[0][0].service, 'custom-ws-service')
            assert.strictEqual(traces[0][0].name, 'web.request')
            assert.strictEqual(traces[0][0].type, 'websocket')
          })
        })

        it('should trace messages when traceWebsocketMessagesEnabled is set to true', () => {
          wsServer.on('connection', (ws) => {
            ws.send('test message')
          })

          client.on('message', (data) => {
            assert.strictEqual(data.toString(), 'test message')
          })

          return agent.assertSomeTraces(traces => {
            assert.strictEqual(traces[0][0].resource, `websocket /${route}`)
            assert.strictEqual(traces[0][0].name, 'websocket.send')
            assert.strictEqual(traces[0][0].type, 'websocket')
            assert.strictEqual(traces[0][0].service, 'custom-ws-service')
          })
        })

        it('should trace received messages when traceWebsocketMessagesEnabled is set to true', () => {
          messageReceived = false
          wsServer.on('connection', (ws) => {
            ws.send('test message')
          })
          wsServer.on('message', (data) => {
            assert.strictEqual(data.toString(), 'test message')
            assert.strictEqual(messageReceived, true)
          })

          client.on('message', (data) => {
            client.send(data)
            assert.strictEqual(data.toString(), 'test message')
            messageReceived = true
          })

          return agent.assertSomeTraces(traces => {
            assert.strictEqual(traces[0][0].service, 'custom-ws-service')
            assert.strictEqual(traces[0][0].name, 'websocket.send')
            assert.strictEqual(traces[0][0].type, 'websocket')
          })
        })

        it('should trace send messages when messages are not received', () => {
          messageReceived = false
          wsServer.on('connection', (ws) => {
            ws.send('test message')
          })
          client.on('message', (data) => {
            client.send(data)
            assert.strictEqual(data.toString(), 'test message')
            messageReceived = true
          })

          return agent.assertSomeTraces(traces => {
            assert.strictEqual(traces[0][0].service, 'custom-ws-service')
            assert.strictEqual(traces[0][0].name, 'websocket.send')
            assert.strictEqual(traces[0][0].type, 'websocket')
          })
        })
      })
      describe('with WebSocket Messages Disabled', () => {
        beforeEach(async () => {
          await agent.load(['ws'], [{
            service: 'custom-ws-service',
            traceWebsocketMessagesEnabled: true
          }])
          WebSocket = require(`../../../versions/ws@${version}`).get()

          wsServer = new WebSocket.Server({ port: clientPort })

          client = new WebSocket(`ws://localhost:${clientPort}`)
        })

        afterEach(async () => {
          clientPort++
          agent.close({ ritmReset: false, wipe: true })
        })

        it('should not produce message spans when traceWebsocketMessagesEnabled is not set to true', () => {
          wsServer.on('connection', (ws) => {
            ws.send('test message')
          })
          messageReceived = false

          client.on('message', (data) => {
            assert.strictEqual(data.toString(), 'test message')
            messageReceived = true
          })

          return agent.assertSomeTraces(traces => {
            assert.strictEqual(traces[0][0].service, 'custom-ws-service')
            assert.strictEqual(traces[0][0].name, 'web.request')
            assert.strictEqual(traces[0][0].type, 'websocket')
          })
        })

        it('should not produce close event spans when traceWebsocketMessagesEnabled is not set to true', () => {
          wsServer.on('connection', (ws) => {
            ws.close()
          })

          return agent.assertSomeTraces(traces => {
            assert.strictEqual(traces[0][0].service, 'custom-ws-service')
            assert.strictEqual(traces[0][0].name, 'web.request')
            assert.strictEqual(traces[0][0].type, 'websocket')
          })
        })
      })
      describe('with WebSocket configurations settings', () => {
        beforeEach(async () => {
          await agent.load(['ws'], [{
            service: 'custom-ws-service',
            traceWebsocketMessagesEnabled: true,
            traceWebsocketMessagesInheritSampling: false,
            traceWebsocketMessagesSeparateTraces: false
          }])
          WebSocket = require(`../../../versions/ws@${version}`).get()

          wsServer = new WebSocket.Server({ port: clientPort })

          client = new WebSocket(`ws://localhost:${clientPort}`)
        })

        afterEach(async () => {
          clientPort++
          agent.close({ ritmReset: false, wipe: true })
        })

        it('should not inherit sampling decisions from root trace', () => {
          wsServer.on('connection', (ws) => {
            ws.on('message', (data) => {
              assert.strictEqual(data.toString(), 'test message from client')
            })
          })

          client.on('open', () => {
            client.send('test message from client')
          })

          return agent.assertSomeTraces(traces => {
            expect(traces[0][0].meta).to.not.have.property('_dd.dm.inherited', 1)
            assert.strictEqual(traces[0][0].meta['span.kind'], 'consumer')
            assert.strictEqual(traces[0][0].name, 'websocket.receive')
            assert.strictEqual(traces[0][0].type, 'websocket')
          })
        })

        it('should have span links', () => {
          let firstTraceId
          wsServer.on('connection', (ws) => {
            ws.on('message', (data) => {
              assert.strictEqual(data.toString(), 'With a great big hug...')
            })
            ws.send('We are a happy family!')
          })

          client.on('open', () => {
          })

          client.on('message', (data) => {
            client.send('With a great big hug...')
          })
          agent.assertFirstTraceSpan(trace => {
            firstTraceId = Number(trace.trace_id)
          })
          return agent.assertSomeTraces(traces => {
            const metaData = JSON.parse(traces[0][0].meta['_dd.span_links'])
            const spanId = Number(BigInt('0x' + metaData[0].span_id))
            assert.strictEqual(spanId, firstTraceId)
            assert.strictEqual(traces[0][0].service, 'custom-ws-service')
            assert.strictEqual(traces[0][0].name, 'websocket.send')
            assert.strictEqual(traces[0][0].type, 'websocket')
          })
        })
      })
    })
  })
})
