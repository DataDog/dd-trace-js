'use strict'

const { expect } = require('chai')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
const agent = require('../../dd-trace/test/plugins/agent')

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

        it('should do automatic instrumentation', () => {
          wsServer.on('connection', (ws) => {
            connectionReceived = true
            ws.send('test message')
          })

          client.on('message', (msg) => {
            expect(msg.toString()).to.equal('test message')
          })

          return agent.assertSomeTraces(traces => {
            expect(traces[0][0]).to.have.property('name', 'web.request')
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
              expect(connectionReceived).to.be.true
            }, 1000)
          })

          client.on('message', msg => {
            expect(msg.toString()).to.equal('echo')
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

          client.on('message', (data) => {
            expect(data.toString()).to.equal('test message')
            done()
          })

          client.on('error', done)
        })

        it('should instrument message receiving', done => {
          wsServer.on('connection', (ws) => {
            ws.on('message', (data) => {
              expect(data.toString()).to.equal('test message from client')
            })
          })
          agent.assertSomeTraces(traces => {
            expect(traces[0][0]).to.have.property('name', 'websocket.receive')
            expect(traces[0][0]).to.have.property('resource', `websocket /${route}`)
          })
            .then(done)
            .catch(done)

          client.on('open', () => {
            client.send('test message from client')
          })

          client.on('error', done)
        })

        it('should instrument connection close', () => {
          client.removeAllListeners()
          wsServer.on('connection', (ws) => {
            ws.close()
          })

          return agent.assertSomeTraces(traces => {
            expect(traces[0][0]).to.have.property('name', 'websocket.close')
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
            expect(traces[0][0]).to.have.property('service', 'custom-ws-service')
            expect(traces[0][0]).to.have.property('name', 'web.request')
            expect(traces[0][0]).to.have.property('type', 'websocket')
          })
        })

        it('should trace messages when traceWebsocketMessagesEnabled is set to true', () => {
          wsServer.on('connection', (ws) => {
            ws.send('test message')
          })

          client.on('message', (data) => {
            expect(data.toString()).to.equal('test message')
          })

          return agent.assertSomeTraces(traces => {
            expect(traces[0][0]).to.have.property('resource', `websocket /${route}`)
            expect(traces[0][0]).to.have.property('name', 'websocket.send')
            expect(traces[0][0]).to.have.property('type', 'websocket')
            expect(traces[0][0]).to.have.property('service', 'custom-ws-service')
          })
        })

        it('should trace received messages when traceWebsocketMessagesEnabled is set to true', () => {
          messageReceived = false
          wsServer.on('connection', (ws) => {
            ws.send('test message')
          })
          wsServer.on('message', (data) => {
            expect(data.toString()).to.equal('test message')
            expect(messageReceived).to.equal(true)
          })

          client.on('message', (data) => {
            client.send(data)
            expect(data.toString()).to.equal('test message')
            messageReceived = true
          })

          return agent.assertSomeTraces(traces => {
            expect(traces[0][0]).to.have.property('service', 'custom-ws-service')
            expect(traces[0][0]).to.have.property('name', 'websocket.send')
            expect(traces[0][0]).to.have.property('type', 'websocket')
          })
        })

        it('should trace send messages when messages are not received', () => {
          messageReceived = false
          wsServer.on('connection', (ws) => {
            ws.send('test message')
          })
          client.on('message', (data) => {
            client.send(data)
            expect(data.toString()).to.equal('test message')
            messageReceived = true
          })

          return agent.assertSomeTraces(traces => {
            expect(traces[0][0]).to.have.property('service', 'custom-ws-service')
            expect(traces[0][0]).to.have.property('name', 'websocket.send')
            expect(traces[0][0]).to.have.property('type', 'websocket')
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
            expect(data.toString()).to.equal('test message')
            messageReceived = true
          })

          return agent.assertSomeTraces(traces => {
            expect(traces[0][0]).to.have.property('service', 'custom-ws-service')
            expect(traces[0][0]).to.have.property('name', 'web.request')
            expect(traces[0][0]).to.have.property('type', 'websocket')
          })
        })

        it('should not produce close event spans when traceWebsocketMessagesEnabled is not set to true', () => {
          wsServer.on('connection', (ws) => {
            ws.close()
          })

          return agent.assertSomeTraces(traces => {
            expect(traces[0][0]).to.have.property('service', 'custom-ws-service')
            expect(traces[0][0]).to.have.property('name', 'web.request')
            expect(traces[0][0]).to.have.property('type', 'websocket')
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
              expect(data.toString()).to.equal('test message from client')
            })
          })

          client.on('open', () => {
            client.send('test message from client')
          })

          return agent.assertSomeTraces(traces => {
            expect(traces[0][0].meta).to.not.have.property('_dd.dm.inherited', 1)
            expect(traces[0][0].meta).to.have.property('span.kind', 'consumer')
            expect(traces[0][0]).to.have.property('name', 'websocket.receive')
            expect(traces[0][0]).to.have.property('type', 'websocket')
          })
        })

        it('should have span links', () => {
          let firstTraceId
          wsServer.on('connection', (ws) => {
            ws.on('message', (data) => {
              expect(data.toString()).to.equal('With a great big hug...')
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
            expect(spanId).to.equal(firstTraceId)
            expect(traces[0][0]).to.have.property('service', 'custom-ws-service')
            expect(traces[0][0]).to.have.property('name', 'websocket.send')
            expect(traces[0][0]).to.have.property('type', 'websocket')
          })
        })
      })

      describe('traceWebsocketMessagesEnabled=false', () => {
        beforeEach(async () => {
          await agent.load(['ws'], [{
            service: 'websocket-bug-repro',
            traceWebsocketMessagesEnabled: false
          }])

          WebSocket = require(`../../../versions/ws@${version}`).get()

          wsServer = new WebSocket.Server({ port: clientPort })

          client = new WebSocket(`ws://localhost:${clientPort}`)
        })

        afterEach(async () => {
          clientPort++
          agent.close({ ritmReset: false, wipe: true })
        })

        it('should not throw error when sending message with traceWebsocketMessagesEnabled=false', (done) => {
          wsServer.on('connection', function connection (ws) {
            expect(() => {
              ws.send('1')
            }).to.not.throw()
            setTimeout(() => wsServer.close(), 100)
          })

          setTimeout(() => {
            const ws = new WebSocket(`ws://localhost:${clientPort}`)
            ws.on('open', () => {
              setTimeout(() => {
                expect(() => {
                  ws.close()
                }).to.not.throw()
              }, 50)
            })
            ws.on('close', () => {
              done()
            })
            ws.on('error', done)
          }, 50)
        })
      })
    })
  })
})
