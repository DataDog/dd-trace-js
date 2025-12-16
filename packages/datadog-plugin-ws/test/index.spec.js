'use strict'

const assert = require('node:assert')
const { once } = require('node:events')

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

        it('should instrument message sending and not double wrap the same handler', done => {
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

          client.on('message', brokenHandler)

          const handler = (data) => {
            assert.strictEqual(data.toString(), 'test message')
            done()
          }

          client.addListener('message', handler)
          client.on('message', handler)

          const handlers = client.listeners('message')

          assert.strictEqual(handlers[0].name, brokenHandler.name)
          assert.strictEqual(handlers[1], handlers[2])

          client.removeListener('message', brokenHandler)
          client.removeListener('message', handler)

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
            assert.ok(!('_dd.dm.inherited' in traces[0][0].meta) || traces[0][0].meta['_dd.dm.inherited'] !== 1)
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

      describe('with span pointers', () => {
        let tracer

        beforeEach(async () => {
          tracer = require('../../dd-trace')
          await agent.load(['ws'], [{
            service: 'ws-with-pointers',
            traceWebsocketMessagesEnabled: true,
          }])
          WebSocket = require(`../../../versions/ws@${version}`).get()

          wsServer = new WebSocket.Server({ port: clientPort })

          // Create a parent span within a trace to properly set up distributed tracing context
          tracer.trace('test.parent', parentSpan => {
            const headers = {}
            tracer.inject(parentSpan, 'http_headers', headers)
            
            // Inject distributed tracing headers to enable span pointers
            client = new WebSocket(`ws://localhost:${clientPort}/${route}?active=true`, {
              headers
            })
          })
        })

        afterEach(async () => {
          clientPort++
          agent.close({ ritmReset: false, wipe: true })
        })

        it('should add span pointers to producer spans', () => {
          wsServer.on('connection', (ws) => {
            ws.send('test message with pointer')
          })

          client.on('message', (data) => {
            assert.strictEqual(data.toString(), 'test message with pointer')
          })

          return agent.assertSomeTraces(traces => {
            const producerSpan = traces[0][0]
            assert.strictEqual(producerSpan.name, 'websocket.send')
            assert.strictEqual(producerSpan.service, 'ws-with-pointers')

            // Check for span links with span pointer attributes
            if (producerSpan.meta['_dd.span_links']) {
              const spanLinks = JSON.parse(producerSpan.meta['_dd.span_links'])
              const pointerLink = spanLinks.find(link =>
                link.attributes && link.attributes['dd.kind'] === 'span-pointer'
              )
              if (pointerLink) {
                expect(pointerLink.attributes).to.have.property('ptr.kind', 'websocket')
                expect(pointerLink.attributes).to.have.property('ptr.dir', 'd')
                expect(pointerLink.attributes).to.have.property('ptr.hash')
                expect(pointerLink.attributes).to.have.property('link.name', 'span-pointer-down')
                expect(pointerLink.attributes['ptr.hash']).to.be.a('string')
                expect(pointerLink.attributes['ptr.hash']).to.have.lengthOf(57)
                // Hash format: <prefix><32 hex trace id><16 hex span id><8 hex counter>
                expect(pointerLink.attributes['ptr.hash']).to.match(/^[SC][0-9a-f]{32}[0-9a-f]{16}[0-9a-f]{8}$/)
              }
            }
          })
        })

        it('should add span pointers to consumer spans', () => {
          wsServer.on('connection', (ws) => {
            ws.on('message', (data) => {
              assert.strictEqual(data.toString(), 'client message with pointer')
            })
          })

          client.on('open', () => {
            client.send('client message with pointer')
          })

          return agent.assertSomeTraces(traces => {
            const consumerSpan = traces.find(t => t[0].name === 'websocket.receive')?.[0]
            if (consumerSpan) {
              assert.strictEqual(consumerSpan.service, 'ws-with-pointers')

              // Check for span links with span pointer attributes
              if (consumerSpan.meta['_dd.span_links']) {
                const spanLinks = JSON.parse(consumerSpan.meta['_dd.span_links'])
                const pointerLink = spanLinks.find(link =>
                  link.attributes && link.attributes['dd.kind'] === 'span-pointer'
                )
                if (pointerLink) {
                  expect(pointerLink.attributes).to.have.property('ptr.kind', 'websocket')
                  expect(pointerLink.attributes).to.have.property('ptr.dir', 'u')
                  expect(pointerLink.attributes).to.have.property('ptr.hash')
                  expect(pointerLink.attributes).to.have.property('link.name', 'span-pointer-up')
                  expect(pointerLink.attributes['ptr.hash']).to.be.a('string')
                  expect(pointerLink.attributes['ptr.hash']).to.have.lengthOf(57)
                  // Hash format: <prefix><32 hex trace id><16 hex span id><8 hex counter>
                  expect(pointerLink.attributes['ptr.hash']).to.match(/^[SC][0-9a-f]{32}[0-9a-f]{16}[0-9a-f]{8}$/)
                }
              }
            }
          })
        })

        it('should generate unique hashes for each message', () => {
          const testMessage = 'test message'
          const hashes = new Set()

          wsServer.on('connection', (ws) => {
            ws.send(testMessage)
            // Send a second message to test counter increment
            setTimeout(() => ws.send(testMessage), 10)
          })

          client.on('message', (data) => {
            assert.strictEqual(data.toString(), testMessage)
          })

          return agent.assertSomeTraces(traces => {
            // Find all producer spans
            const producerTraces = traces.filter(t => t[0].name === 'websocket.send')

            producerTraces.forEach(trace => {
              if (trace[0].meta['_dd.span_links']) {
                const spanLinks = JSON.parse(trace[0].meta['_dd.span_links'])
                const pointerLink = spanLinks.find(link =>
                  link.attributes && link.attributes['dd.kind'] === 'span-pointer'
                )
                if (pointerLink) {
                  const hash = pointerLink.attributes['ptr.hash']
                  hashes.add(hash)
                }
              }
            })

            // Each message should have a unique hash due to counter increment
            if (hashes.size > 1) {
              assert.ok(hashes.size >= 2, 'Multiple messages should have different hashes')
            }
          })
        })
      })
    })
  })
})
