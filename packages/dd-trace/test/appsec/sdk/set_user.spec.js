'use strict'

const proxyquire = require('proxyquire')
const agent = require('../../plugins/agent')
const tracer = require('../../../../../index')
const getPort = require('get-port')
const axios = require('axios')

describe('set_user', () => {
  describe('Internal API', () => {
    const tracer = {}

    let rootSpan, getRootSpan, log, setUser

    beforeEach(() => {
      rootSpan = {
        setTag: sinon.stub()
      }
      getRootSpan = sinon.stub().returns(rootSpan)

      log = {
        warn: sinon.stub()
      }

      const setUserModule = proxyquire('../../../src/appsec/sdk/set_user', {
        './utils': { getRootSpan },
        '../../log': log
      })

      setUser = setUserModule.setUser
    })

    describe('setUser', () => {
      it('should not call setTag when no user is passed', () => {
        setUser(tracer)
        expect(log.warn).to.have.been.calledOnceWithExactly('Invalid user provided to setUser')
        expect(rootSpan.setTag).to.not.have.been.called
      })

      it('should not call setTag when user is empty', () => {
        const user = {}
        setUser(tracer, user)
        expect(log.warn).to.have.been.calledOnceWithExactly('Invalid user provided to setUser')
        expect(rootSpan.setTag).to.not.have.been.called
      })

      it('should not call setTag when rootSpan is not available', () => {
        getRootSpan.returns(undefined)

        setUser(tracer, { id: 'user' })
        expect(getRootSpan).to.be.calledOnceWithExactly(tracer)
        expect(log.warn).to.have.been.calledOnceWithExactly('Root span not available in setUser')
        expect(rootSpan.setTag).to.not.have.been.called
      })

      it('should call setTag with every attribute', () => {
        const user = {
          id: '123',
          email: 'a@b.c',
          custom: 'hello'
        }

        setUser(tracer, user)
        expect(log.warn).to.not.have.been.called
        expect(rootSpan.setTag).to.have.been.calledThrice
        expect(rootSpan.setTag.firstCall).to.have.been.calledWithExactly('usr.id', '123')
        expect(rootSpan.setTag.secondCall).to.have.been.calledWithExactly('usr.email', 'a@b.c')
        expect(rootSpan.setTag.thirdCall).to.have.been.calledWithExactly('usr.custom', 'hello')
      })
    })
  })

  describe('Integration with the tracer', () => {
    let http
    let controller
    let appListener
    let port

    function listener (req, res) {
      if (controller) {
        controller(req, res)
      }
    }

    before(async () => {
      port = await getPort()
      await agent.load('http')
      http = require('http')
    })

    before(done => {
      const server = new http.Server(listener)
      appListener = server
        .listen(port, 'localhost', () => done())
    })

    after(() => {
      appListener.close()
      return agent.close({ ritmReset: false })
    })

    describe('setUser', () => {
      it('should set a proper user', (done) => {
        controller = (req, res) => {
          tracer.appsec.setUser({
            id: 'testUser',
            email: 'a@b.c',
            custom: 'hello'
          })
          res.end()
        }
        agent.use(traces => {
          expect(traces[0][0].meta).to.have.property('usr.id', 'testUser')
          expect(traces[0][0].meta).to.have.property('usr.email', 'a@b.c')
          expect(traces[0][0].meta).to.have.property('usr.custom', 'hello')
        }).then(done).catch(done)
        axios.get(`http://localhost:${port}/`)
      })

      it('should override user on consecutive callings', (done) => {
        controller = (req, res) => {
          tracer.appsec.setUser({ id: 'testUser' })
          tracer.appsec.setUser({ id: 'testUser2' })
          res.end()
        }
        agent.use(traces => {
          expect(traces[0][0].meta).to.have.property('usr.id', 'testUser2')
        }).then(done).catch(done)
        axios.get(`http://localhost:${port}/`)
      })
    })
  })
})
