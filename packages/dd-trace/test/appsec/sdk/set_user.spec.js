'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const axios = require('axios')

const { after, before, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

const tracer = require('../../../../../index')
const appsec = require('../../../src/appsec')
const { getConfigFresh } = require('../../helpers/config')
const agent = require('../../plugins/agent')

describe('set_user', () => {
  describe('Internal API', () => {
    const tracer = {}

    let rootSpan, getRootSpan, log, waf, setUser

    beforeEach(() => {
      rootSpan = {
        setTag: sinon.stub(),
      }
      getRootSpan = sinon.stub().returns(rootSpan)

      log = {
        warn: sinon.stub(),
      }

      waf = {
        run: sinon.stub(),
      }

      const setUserModule = proxyquire('../../../src/appsec/sdk/set_user', {
        './utils': { getRootSpan },
        '../../log': log,
        '../waf': waf,
      })

      setUser = setUserModule.setUser
    })

    describe('setUser', () => {
      it('should not call setTag when no user is passed', () => {
        setUser(tracer)
        sinon.assert.calledOnceWithExactly(log.warn, '[ASM] Invalid user provided to setUser')
        sinon.assert.notCalled(rootSpan.setTag)
        sinon.assert.notCalled(waf.run)
      })

      it('should not call setTag when user is empty', () => {
        const user = {}
        setUser(tracer, user)
        sinon.assert.calledOnceWithExactly(log.warn, '[ASM] Invalid user provided to setUser')
        sinon.assert.notCalled(rootSpan.setTag)
        sinon.assert.notCalled(waf.run)
      })

      it('should not call setTag when rootSpan is not available', () => {
        getRootSpan.returns(undefined)

        setUser(tracer, { id: 'user' })
        sinon.assert.calledOnceWithExactly(getRootSpan, tracer)
        sinon.assert.calledOnceWithExactly(log.warn, '[ASM] Root span not available in setUser')
        sinon.assert.notCalled(rootSpan.setTag)
        sinon.assert.notCalled(waf.run)
      })

      it('should call setTag with every attribute', () => {
        const user = {
          id: '123',
          email: 'a@b.c',
          custom: 'hello',
          session_id: '133769',
        }

        setUser(tracer, user)
        sinon.assert.notCalled(log.warn)
        assert.strictEqual(rootSpan.setTag.callCount, 5)
        assert.strictEqual(rootSpan.setTag.getCall(0).calledWithExactly('usr.id', '123'), true)
        assert.strictEqual(rootSpan.setTag.getCall(1).calledWithExactly('usr.email', 'a@b.c'), true)
        assert.strictEqual(rootSpan.setTag.getCall(2).calledWithExactly('usr.custom', 'hello'), true)
        assert.strictEqual(rootSpan.setTag.getCall(3).calledWithExactly('usr.session_id', '133769'), true)
        assert.strictEqual(rootSpan.setTag.getCall(4).calledWithExactly('_dd.appsec.user.collection_mode', 'sdk'), true)
        sinon.assert.calledOnceWithExactly(waf.run, {
          persistent: {
            'usr.id': '123',
            'usr.session_id': '133769',
          },
        })
      })
    })
  })

  describe('Integration with the tracer', () => {
    const config = getConfigFresh({
      appsec: {
        enabled: true,
        rules: path.join(__dirname, './user_blocking_rules.json'),
      },
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
            session_id: '133769',
          })
          res.end()
        }
        agent.assertSomeTraces(traces => {
          assert.strictEqual(traces[0][0].meta['usr.id'], 'blockedUser')
          assert.strictEqual(traces[0][0].meta['usr.email'], 'a@b.c')
          assert.strictEqual(traces[0][0].meta['usr.custom'], 'hello')
          assert.strictEqual(traces[0][0].meta['usr.session_id'], '133769')
          assert.strictEqual(traces[0][0].meta['_dd.appsec.user.collection_mode'], 'sdk')
          assert.strictEqual(traces[0][0].meta['appsec.event'], 'true')
          assert.ok(!('appsec.blocked' in traces[0][0].meta))
          assert.strictEqual(traces[0][0].meta['http.status_code'], '200')
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
          assert.strictEqual(traces[0][0].meta['usr.id'], 'blockedUser')
          assert.strictEqual(traces[0][0].meta['_dd.appsec.user.collection_mode'], 'sdk')
          assert.strictEqual(traces[0][0].meta['appsec.event'], 'true')
          assert.ok(!('appsec.blocked' in traces[0][0].meta))
          assert.strictEqual(traces[0][0].meta['http.status_code'], '200')
        }).then(done).catch(done)
        axios.get(`http://localhost:${port}/`)
      })
    })
  })
})
