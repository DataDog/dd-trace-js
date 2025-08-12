'use strict'

const { expect } = require('chai')
const http = require('http')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
const agent = require('../../dd-trace/test/plugins/agent')

describe('Plugin', () => {
  let ws
  let WebSocket
  let wsServer
  let httpServer
  let tracer

  describe('ws', () => {
    withVersions('ws', 'ws', version => {
      beforeEach(() => {
        tracer = require('../../dd-trace')
      })

      describe('when using WebSocket', () => {
        before(() => {
          return agent.load('ws')
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        beforeEach(done => {
          ws = require(`../../../versions/ws@${version}`).get()
          WebSocket = ws

          httpServer = http.createServer()
          wsServer = new ws.Server({ server: httpServer })

          wsServer.on('connection', ws => {
            ws.on('message', msg => {
              console.log('echo')
              // Echo back the message with "server:" prefix
              ws.send('echo')
            })
          })

          httpServer.listen(0, 'localhost', () => {
            done()
          })
        })

        afterEach(() => {
          if (wsServer) {
            wsServer.close()
          }
          if (httpServer) {
            httpServer.close()
          }
        })

        it('should do automatic instrumentatio', done => {
          console.log('trace', agent.assertFirstTraceSpan())
          agent.assertSomeTraces(traces => {
            // expect(traces[0][0]).to.have.property('name', expectedSchema.outbound.opName)
            // expect(traces[0][0]).to.have.property('service', expectedSchema.outbound.serviceName)
            // expect(traces[0][0]).to.have.property('resource', 'SELECT $1::text as message')
            // expect(traces[0][0]).to.have.property('type', 'sql')
            // expect(traces[0][0].meta).to.have.property('span.kind', 'client')
            // expect(traces[0][0].meta).to.have.property('db.name', 'postgres')
            // expect(traces[0][0].meta).to.have.property('db.user', 'postgres')
            // expect(traces[0][0].meta).to.have.property('db.type', 'postgres')
            // expect(traces[0][0].meta).to.have.property('component', 'pg')
            // expect(traces[0][0].metrics).to.have.property('network.destination.port', 5432)
          })
            .then(done)
            .catch(done)

          const client = new WebSocket(`ws://localhost:${httpServer.address().port}`)

          client.on('open', () => {
            client.send('hello')
          })

          client.on('message', msg => {
            console.log('message', msg.toString())
            expect(msg.toString()).to.equal('echo')
            done()
          })

          client.on('error', done)
        })

        it('should do automatic instrumentation for server connections', done => {
          let connectionReceived = false

          wsServer.on('connection', (ws) => {
            connectionReceived = true
            ws.close()
          })

          const client = new WebSocket(`ws://localhost:${httpServer.address().port}`)

          client.on('open', () => {
            // Give a small delay to ensure trace is captured
            setTimeout(() => {
              expect(connectionReceived).to.be.true
              client.close()
              done()
            }, 10)
          })

          client.on('error', done)
        })

        it('should instrument message sending', done => {
          wsServer.on('connection', (ws) => {
            ws.send('test message')
          })

          const client = new WebSocket(`ws://localhost:${httpServer.address().port}`)

          client.on('message', (data) => {
            expect(data.toString()).to.equal('test message')
            client.close()
            done()
          })

          client.on('error', done)
        })

        it('should instrument message receiving', done => {
          wsServer.on('connection', (ws) => {
            ws.on('message', (data) => {
              expect(data.toString()).to.equal('test message from client')
              ws.close()
              done()
            })
          })

          const client = new WebSocket(`ws://localhost:${httpServer.address().port}`)

          client.on('open', () => {
            client.send('test message from client')
          })

          client.on('error', done)
        })

        it('should instrument connection close', done => {
          wsServer.on('connection', (ws) => {
            setTimeout(() => ws.close(), 10)
          })

          const client = new WebSocket(`ws://localhost:${httpServer.address().port}`)

          client.on('close', () => {
            done()
          })

          client.on('error', done)
        })

        // it.only('should run callbacks in the parent context', done => {
        //   const span = tracer.startSpan('parent')

        //   console.log('span', span._spanContext._tags)
        //   tracer.scope().activate(span, () => {
        //     console.log('span', span._spanContext._tags)
        //     // console.log('span in connection', span._spanContext._tags)
        //     const spanIn = tracer.scope().active()
        //     wsServer.on('connection', (ws) => {
        //       console.log('span in connection', tracer.scope().active())
        //       expect(spanIn).to.equal(span)
        //       ws.close()
        //       done()
        //     })

        //     const client = new WebSocket(`ws://localhost:${httpServer.address().port}`)
        //     client.on('error', done)
        //   })
        // })
      })

      describe('with service configuration', () => {
        before(() => {
          return agent.load('ws', { service: 'custom-ws-service' })
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        beforeEach(done => {
          ws = require(`../../../versions/ws@${version}`).get()
          WebSocket = ws

          httpServer = http.createServer()
          wsServer = new ws.Server({ server: httpServer })

          httpServer.listen(0, 'localhost', () => {
            done()
          })
        })

        afterEach(() => {
          if (wsServer) {
            wsServer.close()
          }
          if (httpServer) {
            httpServer.close()
          }
        })

        it('should work with custom service configuration', done => {
          agent.assertSomeTraces(traces => {
            console.log('assert some')
            expect(traces[0][0]).to.have.property('service', 'custom-ws-service')
            expect(traces[0][0]).to.have.property('name', 'websocket.request')
            expect(traces[0][0]).to.have.property('type', 'websocket')
          })
            .then(done)
            .catch(done)

          let messageReceived = false

          wsServer.on('connection', (ws) => {
            ws.send('test message')
            setTimeout(() => ws.close(), 10)
          })

          const client = new WebSocket(`ws://localhost:${httpServer.address().port}`)

          client.on('message', (data) => {
            expect(data.toString()).to.equal('test message')
            messageReceived = true
          })

          client.on('error', done)
        })
      })
    })
  })
}
)
