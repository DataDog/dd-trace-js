'use strict'

const getPort = require('get-port')
const agent = require('../../dd-trace/test/plugins/agent')
const axios = require('axios')
const { incomingHttpRequestStart } = require('../../dd-trace/src/appsec/gateway/channels')

describe('Plugin', () => {
  let http
  let listener
  let appListener
  let tracer
  let port
  let app

  describe('http/server', () => {
    beforeEach(() => {
      tracer = require('../../dd-trace')
      listener = (req, res) => {
        app && app(req, res)
        res.writeHead(200)
        res.end()
      }
    })

    beforeEach(() => {
      return getPort().then(newPort => {
        port = newPort
      })
    })

    afterEach(() => {
      appListener && appListener.close()
      return agent.close({ ritmReset: false })
    })

    describe('without configuration', () => {
      beforeEach(() => {
        return agent.load('http')
          .then(() => {
            http = require('http')
          })
      })

      beforeEach(done => {
        const server = new http.Server(listener)
        appListener = server
          .listen(port, 'localhost', () => done())
      })

      it('should do automatic instrumentation', done => {
        agent
          .use(traces => {
            expect(traces[0][0]).to.have.property('name', 'http.request')
            expect(traces[0][0]).to.have.property('service', 'test')
            expect(traces[0][0]).to.have.property('type', 'web')
            expect(traces[0][0]).to.have.property('resource', 'GET')
            expect(traces[0][0].meta).to.have.property('span.kind', 'server')
            expect(traces[0][0].meta).to.have.property('http.url', `http://localhost:${port}/user`)
            expect(traces[0][0].meta).to.have.property('http.method', 'GET')
            expect(traces[0][0].meta).to.have.property('http.status_code', '200')
          })
          .then(done)
          .catch(done)

        axios.get(`http://localhost:${port}/user`).catch(done)
      })

      it('should run the request listener in the request scope', done => {
        const spy = sinon.spy(() => {
          expect(tracer.scope().active()).to.not.be.null
        })

        incomingHttpRequestStart.subscribe(spy)

        app = (req, res) => {
          expect(tracer.scope().active()).to.not.be.null

          expect(spy).to.have.been.calledOnceWithExactly({ req, res }, incomingHttpRequestStart.name)

          done()
        }

        axios.get(`http://localhost:${port}/user`).catch(done)
      })

      it(`should run the request's close event in the correct context`, done => {
        app = (req, res) => {
          req.on('close', () => {
            expect(tracer.scope().active()).to.equal(null)
            done()
          })
          res.end()
        }

        axios.get(`http://localhost:${port}/user`).catch(done)
      })

      it(`should run the response's close event in the correct context`, done => {
        app = (req, res) => {
          const span = tracer.scope().active()

          res.on('close', () => {
            expect(tracer.scope().active()).to.equal(span)
            done()
          })
        }

        axios.get(`http://localhost:${port}/user`).catch(done)
      })

      it(`should run the finish event in the correct context`, done => {
        app = (req, res) => {
          const span = tracer.scope().active()

          res.on('finish', () => {
            expect(tracer.scope().active()).to.equal(span)
            done()
          })
        }

        axios.get(`http://localhost:${port}/user`).catch(done)
      })

      it('should not instrument manually instantiated server responses', () => {
        const { IncomingMessage, ServerResponse } = http

        const req = new IncomingMessage()
        const res = new ServerResponse(req)

        expect(() => res.emit('finish')).to.not.throw()
      })
    })
  })
})
