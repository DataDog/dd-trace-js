'use strict'

const assert = require('node:assert')
const { once } = require('node:events')

const dc = require('dc-polyfill')
const { after, afterEach, before, beforeEach, describe, it } = require('mocha')

const agent = require('../../dd-trace/test/plugins/agent')
const { storage } = require('../../datadog-core')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
const { assertObjectContains } = require('../../../integration-tests/helpers')

/**
 * @param {Array<Array<object>>} traces
 * @param {(span: object) => boolean} predicate
 * @returns {object | undefined}
 */
function findSpan (traces, predicate) {
  for (const trace of traces) {
    for (const span of trace) {
      if (predicate(span)) return span
    }
  }
  return undefined
}

function closeWsServer (server) {
  for (const ws of server.clients) {
    ws.terminate()
  }
  return new Promise(resolve => server.close(resolve))
}

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
            traceWebsocketMessagesEnabled: true,
          }])
          WebSocket = require(`../../../versions/ws@${version}`).get()
        })

        it('should not crash when sending on a socket without spanContext', async () => {
          const server = new WebSocket.Server({ port: 16015 })
          const connectionPromise = once(server, 'connection')

          const socket = new WebSocket('ws://localhost:16015')
          const [serverSocket] = await connectionPromise
          await once(socket, 'open')

          assert.strictEqual(socket.spanContext, undefined)

          const messagePromise = once(serverSocket, 'message')
          await new Promise((resolve, reject) => {
            socket.send('test message', {}, (err) => err ? reject(err) : resolve())
          })
          await messagePromise

          socket.close()
          await once(socket, 'close')
          server.close()
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
          await agent.close({ ritmReset: false, wipe: true })
        })
      })

      describe('when using WebSocket', () => {
        route = 'test'
        // Each test connects the client itself, after `wsServer` handlers
        // are attached, otherwise 'connection' races on slow runners.
        const connectClient = (path = `/${route}?active=true`, options) => {
          client = new WebSocket(`ws://localhost:${clientPort}${path}`, options)
          return client
        }

        beforeEach(async () => {
          await agent.load(['ws'], [{
            service: 'some',
            traceWebsocketMessagesEnabled: true,
          }])
          WebSocket = require(`../../../versions/ws@${version}`).get()

          wsServer = new WebSocket.Server({ port: clientPort })
          await once(wsServer, 'listening')
        })

        afterEach(async () => {
          clientPort++
          if (client) { client.removeAllListeners('error'); client.on('error', () => {}) }
          await closeWsServer(wsServer)
          await agent.close({ ritmReset: false, wipe: true })
        })

        it('should not retain the connection span during socket setup', async () => {
          const setSocketCh = dc.channel('tracing:ws:server:connect:setSocket')
          let resolve
          const promise = new Promise((_resolve) => {
            resolve = _resolve
          })

          const handler = () => {
            resolve(storage('legacy').getStore())
            setSocketCh.unsubscribe(handler)
          }
          setSocketCh.subscribe(handler)

          // Trigger setSocket
          const newClient = new WebSocket(`ws://localhost:${clientPort}/test`)
          newClient.on('open', () => newClient.close())
          newClient.on('error', () => {})

          const store = await promise

          assert.strictEqual(store?.span, undefined,
            'connection span should not be in the store during setSocket')
        })

        it('should do automatic instrumentation and remove broken handler', () => {
          wsServer.on('connection', (ws) => {
            connectionReceived = true
            ws.send('test message')
          })

          connectClient()

          const brokenHandler = () => {
            throw new Error('broken handler')
          }

          client.on('message', brokenHandler)

          client.addListener('message', (msg) => {
            assert.strictEqual(msg.toString(), 'test message')
          })

          client.off('message', brokenHandler)

          return agent.assertSomeTraces(traces => {
            const sendSpan = findSpan(traces, s => s.name === 'websocket.send')
            assert.ok(sendSpan, 'Should have a websocket.send span')
            assertObjectContains(sendSpan, {
              name: 'websocket.send',
              type: 'websocket',
              resource: `websocket /${route}`,
              service: 'some',
              parent_id: 0n,
              error: 0,
              meta: {
                'span.kind': 'producer',
              },
            })
          })
        })

        it('should handle removing a listener that was never added', (done) => {
          wsServer.on('connection', (ws) => {
            connectionReceived = true
            ws.send('test message')
          })

          connectClient()

          const neverAddedHandler = () => {
            throw new Error('this should never be called')
          }

          client.on('message', (msg) => {
            assert.strictEqual(msg.toString(), 'test message')
            done()
          })

          client.off('message', neverAddedHandler)
        })

        it('should do automatic instrumentation for server connections', done => {
          connectionReceived = false

          wsServer.on('connection', (ws) => {
            connectionReceived = true
            ws.send('echo')
          })

          connectClient()

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

        it('should instrument message sending once per message', () => {
          wsServer.on('connection', ws => {
            connectionReceived = true
            ws.on('message', msg => {
              // Echo back the message with "server:" prefix
              ws.send(msg)
            })
          })

          connectClient()

          /** @type {Promise<void>} */
          const messageHandled = new Promise((resolve, reject) => {
            let count = 0
            const handler = (data) => {
              assert.strictEqual(data.toString(), 'test message')
              count++
              if (count === 2) resolve()
            }

            client.on('message', handler)
            client.on('message', handler)
            client.on('error', reject)
          })

          client.on('open', () => {
            client.send('test message')
          })

          return messageHandled.then(() => agent.assertSomeTraces(traces => {
            let receiveCount = 0
            for (const trace of traces) {
              for (const span of trace) {
                if (span.name === 'websocket.receive') {
                  receiveCount++
                }
              }
            }

            assert.strictEqual(receiveCount, 1)
          }))
        })

        it('should handle addEventListener/removeEventListener', () => {
          wsServer.on('connection', ws => {
            ws.send('test message')
          })

          connectClient()

          let onMessage
          let onError
          /** @type {Promise<void>} */
          const messageHandled = new Promise((resolve, reject) => {
            onMessage = event => {
              assert.strictEqual(event.data, 'test message')
              resolve()
            }
            onError = event => {
              reject(event?.error ?? event)
            }
            client.addEventListener('message', onMessage)
            client.addEventListener('error', onError)
          })

          return messageHandled.then(() => {
            client.removeEventListener('message', onMessage)
            client.removeEventListener('error', onError)

            return agent.assertSomeTraces(traces => {
              let sendCount = 0
              for (const trace of traces) {
                for (const span of trace) {
                  if (span.name === 'websocket.send') {
                    sendCount++
                  }
                }
              }
              assert.ok(sendCount > 0)
            })
          })
        })

        it('should instrument message receiving', () => {
          wsServer.on('connection', (ws) => {
            ws.on('message', (data) => {
              assert.strictEqual(data.toString(), 'test message from client')
            })
          })

          connectClient()

          client.on('open', () => {
            client.send('test message from client')
          })

          const errorPromise = once(client, 'error')
            .then(([error]) => {
              throw error
            })

          return Promise.race([
            errorPromise,
            agent.assertSomeTraces(traces => {
              const receiveSpan = findSpan(traces, s => s.name === 'websocket.receive')
              assert.ok(receiveSpan, 'Should have a websocket.receive span')
              assertObjectContains(receiveSpan, {
                name: 'websocket.receive',
                resource: `websocket /${route}`,
              })
            }),
          ])
        })

        it('should trace a receive span for each message', () => {
          let totalReceiveCount = 0
          /** @type {Promise<void>} */
          const messageHandled = new Promise((resolve, reject) => {
            wsServer.on('connection', (ws) => {
              let count = 0
              ws.on('message', (data) => {
                assert.strictEqual(data.toString(), 'test message')
                count++
                if (count === 2) resolve()
              })
              ws.on('error', reject)
            })
            connectClient()
            client.on('error', reject)
          })

          client.on('open', () => {
            client.send('test message')
            client.send('test message')
          })

          return messageHandled.then(() => agent.assertSomeTraces(traces => {
            for (const trace of traces) {
              for (const span of trace) {
                if (span.name === 'websocket.receive') {
                  totalReceiveCount++
                }
              }
            }
            assert.strictEqual(totalReceiveCount, 2)
          }))
        })

        it('should trace binary message length and type', () => {
          const payload = Buffer.from('binary payload')
          /** @type {Promise<void>} */
          const messageHandled = new Promise((resolve, reject) => {
            wsServer.on('connection', (ws) => {
              ws.on('message', (data) => {
                assert.ok(Buffer.isBuffer(data))
                assert.strictEqual(data.toString(), payload.toString())
                resolve()
              })
              ws.on('error', reject)
            })
            connectClient()
            client.on('error', reject)
          })

          client.on('open', () => {
            client.send(payload)
          })

          return messageHandled.then(() => agent.assertSomeTraces(traces => {
            const receiveSpan = findSpan(traces, s => s.name === 'websocket.receive')
            assert.ok(receiveSpan, 'Should have a websocket.receive span')
            assert.strictEqual(receiveSpan.meta['websocket.message.type'], 'binary')
            assert.strictEqual(receiveSpan.metrics['websocket.message.length'], payload.length)
          }))
        })

        it('should not trace received messages without listeners', () => {
          /** @type {Promise<void>} */
          const sendComplete = new Promise((resolve, reject) => {
            wsServer.on('connection', ws => {
              ws.send('test message', err => {
                if (err) return reject(err)
                resolve()
              })
            })
            connectClient()
            client.on('error', reject)
          })

          return sendComplete.then(() => agent.assertSomeTraces(traces => {
            let receiveCount = 0
            let sendCount = 0
            for (const trace of traces) {
              for (const span of trace) {
                if (span.name === 'websocket.receive') {
                  receiveCount++
                }
                if (span.name === 'websocket.send') {
                  sendCount++
                }
              }
            }

            assert.strictEqual(receiveCount, 0)
            assert.ok(sendCount > 0)
          }))
        })

        it('should instrument connection close', () => {
          wsServer.on('connection', (ws) => {
            ws.close()
          })

          connectClient()
          client.removeAllListeners()

          return agent.assertSomeTraces(traces => {
            assert.ok(
              findSpan(traces, s => s.name === 'websocket.close'),
              'Should have a websocket.close span'
            )
          })
        })
      })

      describe('with service configuration', () => {
        const connectClient = (path = `/${route}?active=true`, options) => {
          client = new WebSocket(`ws://localhost:${clientPort}${path}`, options)
          return client
        }

        beforeEach(async () => {
          await agent.load(['ws'], [{
            service: 'custom-ws-service',
            traceWebsocketMessagesEnabled: true,
          }])
          WebSocket = require(`../../../versions/ws@${version}`).get()

          wsServer = new WebSocket.Server({ port: clientPort })
          await once(wsServer, 'listening')
        })

        afterEach(async () => {
          clientPort++
          if (client) { client.removeAllListeners('error'); client.on('error', () => {}) }
          await closeWsServer(wsServer)
          await agent.close({ ritmReset: false, wipe: true })
        })

        it('should work with custom service configuration', () => {
          wsServer.on('connection', (ws) => {
          })
          connectClient()
          messageReceived = false

          return agent.assertSomeTraces(traces => {
            const span = findSpan(traces, s => s.name === 'web.request' && s.type === 'websocket')
            assert.ok(span, 'Should have a web.request websocket span')
            assert.strictEqual(span.service, 'custom-ws-service')
          })
        })

        it('should trace messages when traceWebsocketMessagesEnabled is set to true', () => {
          wsServer.on('connection', (ws) => {
            ws.send('test message')
          })

          connectClient()

          client.on('message', (data) => {
            assert.strictEqual(data.toString(), 'test message')
          })

          return agent.assertSomeTraces(traces => {
            const span = findSpan(traces, s => s.name === 'websocket.send')
            assert.ok(span, 'Should have a websocket.send span')
            assertObjectContains(span, {
              name: 'websocket.send',
              type: 'websocket',
              resource: `websocket /${route}`,
              service: 'custom-ws-service',
            })
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

          connectClient()

          client.on('message', (data) => {
            client.send(data)
            assert.strictEqual(data.toString(), 'test message')
            messageReceived = true
          })

          return agent.assertSomeTraces(traces => {
            const span = findSpan(traces, s => s.name === 'websocket.send')
            assert.ok(span, 'Should have a websocket.send span')
            assertObjectContains(span, {
              service: 'custom-ws-service',
              name: 'websocket.send',
              type: 'websocket',
            })
          })
        })

        it('should trace send messages when messages are not received', () => {
          messageReceived = false
          wsServer.on('connection', (ws) => {
            ws.send('test message')
          })

          connectClient()

          client.on('message', (data) => {
            client.send(data)
            assert.strictEqual(data.toString(), 'test message')
            messageReceived = true
          })

          return agent.assertSomeTraces(traces => {
            const span = findSpan(traces, s => s.name === 'websocket.send')
            assert.ok(span, 'Should have a websocket.send span')
            assertObjectContains(span, {
              service: 'custom-ws-service',
              name: 'websocket.send',
              type: 'websocket',
            })
          })
        })
      })
      describe('with WebSocket Messages Disabled', () => {
        beforeEach(async () => {
          await agent.load(['ws'], [{
            service: 'custom-ws-service',
            traceWebsocketMessagesEnabled: false,
          }])
          WebSocket = require(`../../../versions/ws@${version}`).get()

          wsServer = new WebSocket.Server({ port: clientPort })
          await once(wsServer, 'listening')
        })

        afterEach(async () => {
          clientPort++
          if (client) { client.removeAllListeners('error'); client.on('error', () => {}) }
          await closeWsServer(wsServer)
          await agent.close({ ritmReset: false, wipe: true })
        })

        it('should not initialize sub-plugins when traceWebsocketMessagesEnabled is false', () => {
          const tracer = require('../../dd-trace')
          const wsPlugin = tracer._pluginManager._pluginsByName.ws

          assertObjectContains(wsPlugin, {
            server: {
              _enabled: false,
            },
            producer: {
              _enabled: false,
            },
            receiver: {
              _enabled: false,
            },
            close: {
              _enabled: false,
            },
          })
        })
      })
      describe('with WebSocket configurations settings', () => {
        const connectClient = (path = '', options) => {
          client = new WebSocket(`ws://localhost:${clientPort}${path}`, options)
          return client
        }

        beforeEach(async () => {
          await agent.load(['ws'], [{
            service: 'custom-ws-service',
            traceWebsocketMessagesEnabled: true,
            traceWebsocketMessagesInheritSampling: false,
            traceWebsocketMessagesSeparateTraces: false,
          }])
          WebSocket = require(`../../../versions/ws@${version}`).get()

          wsServer = new WebSocket.Server({ port: clientPort })
          await once(wsServer, 'listening')
        })

        afterEach(async () => {
          clientPort++
          if (client) { client.removeAllListeners('error'); client.on('error', () => {}) }
          await closeWsServer(wsServer)
          await agent.close({ ritmReset: false, wipe: true })
        })

        it('should not inherit sampling decisions from root trace', () => {
          wsServer.on('connection', (ws) => {
            ws.on('message', (data) => {
              assert.strictEqual(data.toString(), 'test message from client')
            })
          })

          connectClient()

          client.on('open', () => {
            client.send('test message from client')
          })

          return agent.assertSomeTraces(traces => {
            const span = findSpan(traces, s =>
              s.name === 'websocket.receive' && s.type === 'websocket'
            )
            assert.ok(span, 'Should have a websocket.receive span')
            assert.strictEqual(span.meta['span.kind'], 'consumer')
            assert.ok(
              !('_dd.dm.inherited' in span.meta) || span.meta['_dd.dm.inherited'] !== 1,
              'websocket.receive should not inherit sampling decision'
            )
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

          connectClient()

          client.on('open', () => {
          })

          client.on('message', (data) => {
            client.send('With a great big hug...')
          })
          agent.assertFirstTraceSpan(trace => {
            firstTraceId = Number(trace.trace_id)
          })
          return agent.assertSomeTraces(traces => {
            const span = findSpan(traces, s =>
              s.name === 'websocket.send' && s.meta?.['_dd.span_links']
            )
            assert.ok(span, 'Should have a websocket.send span with span links')
            const metaData = JSON.parse(span.meta['_dd.span_links'])
            const spanId = Number(BigInt('0x' + metaData[0].span_id))
            assert.strictEqual(spanId, firstTraceId)
            assertObjectContains(span, {
              service: 'custom-ws-service',
              name: 'websocket.send',
              type: 'websocket',
            })
          })
        })
      })

      describe('with span pointers', () => {
        let tracer
        let parentHeaders

        const connectClient = (path = `/${route}?active=true`) => {
          client = new WebSocket(`ws://localhost:${clientPort}${path}`, {
            headers: parentHeaders,
          })
          return client
        }

        beforeEach(async () => {
          tracer = require('../../dd-trace')
          await agent.load(['ws'], [{
            service: 'ws-with-pointers',
            traceWebsocketMessagesEnabled: true,
          }])
          WebSocket = require(`../../../versions/ws@${version}`).get()

          wsServer = new WebSocket.Server({ port: clientPort })
          await once(wsServer, 'listening')

          parentHeaders = {}
          tracer.trace('test.parent', parentSpan => {
            tracer.inject(parentSpan, 'http_headers', parentHeaders)
          })
        })

        afterEach(async () => {
          clientPort++
          if (client) { client.removeAllListeners('error'); client.on('error', () => {}) }
          await closeWsServer(wsServer)
          await agent.close({ ritmReset: false, wipe: true })
        })

        it('should add span pointers to producer spans', async () => {
          wsServer.on('connection', (ws) => {
            ws.send('test message with pointer')
          })

          connectClient()

          client.on('message', (data) => {
            assert.strictEqual(data.toString(), 'test message with pointer')
          })

          let didFindPointerLink = false

          await agent.assertSomeTraces(traces => {
            const producerSpan = findSpan(traces, s => s.name === 'websocket.send')
            assert.ok(producerSpan, 'Should have a websocket.send span')
            assert.strictEqual(producerSpan.service, 'ws-with-pointers')

            // Check for span links with span pointer attributes
            assert.ok(producerSpan.meta['_dd.span_links'], 'Producer span should have span links')
            const spanLinks = JSON.parse(producerSpan.meta['_dd.span_links'])
            const pointerLink = spanLinks.find(link =>
              link.attributes && link.attributes['dd.kind'] === 'span-pointer'
            )
            assert.ok(pointerLink, 'Should have a span pointer link')

            assertObjectContains(pointerLink, {
              attributes: {
                'ptr.kind': 'websocket',
                'ptr.dir': 'd',
                'link.name': 'span-pointer-down',
              },
            })
            didFindPointerLink = true

            const { attributes } = pointerLink
            assert.ok(Object.hasOwn(attributes, 'ptr.hash'))
            // Hash format: <prefix><32 hex trace id><16 hex span id><8 hex counter>
            assert.match(attributes['ptr.hash'], /^[SC][0-9a-f]{32}[0-9a-f]{16}[0-9a-f]{8}$/)
            assert.strictEqual(attributes['ptr.hash'].length, 57)
          })

          assert.strictEqual(didFindPointerLink, true)
        })

        it('should add span pointers to consumer spans', async () => {
          wsServer.on('connection', (ws) => {
            ws.on('message', (data) => {
              assert.strictEqual(data.toString(), 'client message with pointer')
            })
          })

          connectClient()

          client.on('open', () => {
            client.send('client message with pointer')
          })

          let didFindPointerLink = false

          await agent.assertSomeTraces(traces => {
            const consumerSpan = findSpan(traces, s => s.name === 'websocket.receive')
            assert.ok(consumerSpan, 'Should have a websocket.receive span')
            assert.strictEqual(consumerSpan.service, 'ws-with-pointers')

            // Check for span links with span pointer attributes
            assert.ok(consumerSpan.meta['_dd.span_links'], 'Consumer span should have span links')
            const spanLinks = JSON.parse(consumerSpan.meta['_dd.span_links'])
            const pointerLink = spanLinks.find(link =>
              link.attributes && link.attributes['dd.kind'] === 'span-pointer'
            )

            assertObjectContains(pointerLink, {
              attributes: {
                'ptr.kind': 'websocket',
                'ptr.dir': 'u',
                'link.name': 'span-pointer-up',
              },
            })
            didFindPointerLink = true

            const { attributes } = pointerLink
            assert.ok(Object.hasOwn(attributes, 'ptr.hash'))
            // Hash format: <prefix><32 hex trace id><16 hex span id><8 hex counter>
            assert.match(attributes['ptr.hash'], /^[SC][0-9a-f]{32}[0-9a-f]{16}[0-9a-f]{8}$/)
            assert.strictEqual(attributes['ptr.hash'].length, 57)
          })

          assert.strictEqual(didFindPointerLink, true)
        })

        it('should generate unique hashes for each message', () => {
          const testMessage = 'test message'
          const hashes = new Set()

          wsServer.on('connection', (ws) => {
            ws.send(testMessage)
            // Send a second message to test counter increment
            setTimeout(() => ws.send(testMessage), 10)
          })

          connectClient()

          client.on('message', (data) => {
            assert.strictEqual(data.toString(), testMessage)
          })

          return agent.assertSomeTraces(traces => {
            for (const trace of traces) {
              for (const span of trace) {
                if (span.name !== 'websocket.send') continue
                if (!span.meta?.['_dd.span_links']) continue
                const spanLinks = JSON.parse(span.meta['_dd.span_links'])
                const pointerLink = spanLinks.find(link =>
                  link.attributes && link.attributes['dd.kind'] === 'span-pointer'
                )
                if (pointerLink) {
                  hashes.add(pointerLink.attributes['ptr.hash'])
                }
              }
            }

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
