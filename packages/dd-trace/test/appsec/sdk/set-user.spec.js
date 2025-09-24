'use strict'

const axios = require('axios')
const { expect } = require('chai')
const { describe, it, beforeEach } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')
const path = require('node:path')

const agent = require('../../plugins/agent')
const tracer = require('../../../../../index')
const appsec = require('../../../src/appsec')
const Config = require('../../../src/config')

describe('set-user', () => {
  describe('Internal API', () => {
    const tracer = {}

    let rootSpan, getRootSpan, log, waf, setUser

    beforeEach(() => {
      rootSpan = {
        setTag: sinon.stub()
      }
      getRootSpan = sinon.stub().returns(rootSpan)

      log = {
        warn: sinon.stub()
      }

      waf = {
        run: sinon.stub()
      }

      const setUserModule = proxyquire('../../../src/appsec/sdk/set-user', {
        './utils': { getRootSpan },
        '../../log': log,
        '../waf': waf
      })

      setUser = setUserModule.setUser
    })

    describe('setUser', () => {
      it('should not call setTag when no user is passed', () => {
        setUser(tracer)
        expect(log.warn).to.have.been.calledOnceWithExactly('[ASM] Invalid user provided to setUser')
        expect(rootSpan.setTag).to.not.have.been.called
        expect(waf.run).to.not.have.been.called
      })

      it('should not call setTag when user is empty', () => {
        const user = {}
        setUser(tracer, user)
        expect(log.warn).to.have.been.calledOnceWithExactly('[ASM] Invalid user provided to setUser')
        expect(rootSpan.setTag).to.not.have.been.called
        expect(waf.run).to.not.have.been.called
      })

      it('should not call setTag when rootSpan is not available', () => {
        getRootSpan.returns(undefined)

        setUser(tracer, { id: 'user' })
        expect(getRootSpan).to.be.calledOnceWithExactly(tracer)
        expect(log.warn).to.have.been.calledOnceWithExactly('[ASM] Root span not available in setUser')
        expect(rootSpan.setTag).to.not.have.been.called
        expect(waf.run).to.not.have.been.called
      })

      it('should call setTag with every attribute', () => {
        const user = {
          id: '123',
          email: 'a@b.c',
          custom: 'hello',
          session_id: '133769'
        }

        setUser(tracer, user)
        expect(log.warn).to.not.have.been.called
        expect(rootSpan.setTag.callCount).to.equal(5)
        expect(rootSpan.setTag.getCall(0)).to.have.been.calledWithExactly('usr.id', '123')
        expect(rootSpan.setTag.getCall(1)).to.have.been.calledWithExactly('usr.email', 'a@b.c')
        expect(rootSpan.setTag.getCall(2)).to.have.been.calledWithExactly('usr.custom', 'hello')
        expect(rootSpan.setTag.getCall(3)).to.have.been.calledWithExactly('usr.session_id', '133769')
        expect(rootSpan.setTag.getCall(4)).to.have.been.calledWithExactly('_dd.appsec.user.collection_mode', 'sdk')
        expect(waf.run).to.have.been.calledOnceWithExactly({
          persistent: {
            'usr.id': '123',
            'usr.session_id': '133769'
          }
        })
      })
    })
  })

  describe('Integration with the tracer', () => {
    const config = new Config({
      appsec: {
        enabled: true,
        rules: path.join(__dirname, './user-blocking-rules.json')
      }
    })

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
      await agent.load('http')
      http = require('http')
    })

    before(done => {
      const server = new http.Server(listener)
      appListener = server
        .listen(port, 'localhost', () => {
          port = appListener.address().port
          done()
        })

      appsec.enable(config)
    })

    after(() => {
      appsec.disable()

      appListener.close()
      return agent.close({ ritmReset: false })
    })

    describe('setUser', () => {
      it('should set a proper user', (done) => {
        controller = (req, res) => {
          tracer.appsec.setUser({
            id: 'blockedUser',
            email: 'a@b.c',
            custom: 'hello',
            session_id: '133769'
          })
          res.end()
        }
        agent.assertSomeTraces(traces => {
          expect(traces[0][0].meta).to.have.property('usr.id', 'blockedUser')
          expect(traces[0][0].meta).to.have.property('usr.email', 'a@b.c')
          expect(traces[0][0].meta).to.have.property('usr.custom', 'hello')
          expect(traces[0][0].meta).to.have.property('usr.session_id', '133769')
          expect(traces[0][0].meta).to.have.property('_dd.appsec.user.collection_mode', 'sdk')
          expect(traces[0][0].meta).to.have.property('appsec.event', 'true')
          expect(traces[0][0].meta).to.not.have.property('appsec.blocked')
          expect(traces[0][0].meta).to.have.property('http.status_code', '200')
        }).then(done).catch(done)
        axios.get(`http://localhost:${port}/`)
      })

      it('should override user on consecutive callings', (done) => {
        controller = (req, res) => {
          tracer.appsec.setUser({ id: 'testUser' })
          tracer.appsec.setUser({ id: 'blockedUser' })
          res.end()
        }
        agent.assertSomeTraces(traces => {
          expect(traces[0][0].meta).to.have.property('usr.id', 'blockedUser')
          expect(traces[0][0].meta).to.have.property('_dd.appsec.user.collection_mode', 'sdk')
          expect(traces[0][0].meta).to.have.property('appsec.event', 'true')
          expect(traces[0][0].meta).to.not.have.property('appsec.blocked')
          expect(traces[0][0].meta).to.have.property('http.status_code', '200')
        }).then(done).catch(done)
        axios.get(`http://localhost:${port}/`)
      })
    })
  })
})
