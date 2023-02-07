'use strict'

const proxyquire = require('proxyquire')
const agent = require('../../plugins/agent')
const tracer = require('../../../../../index')
const appsec = require('../../../src/appsec')
const Config = require('../../../src/config')
const getPort = require('get-port')
const axios = require('axios')

describe('Set user API', () => {
  describe('Check internal callings', () => {
    const tracer = {}
    let sdk, mockSetTag, mockRootSpan, getRootSpan

    beforeEach(() => {
      mockSetTag = sinon.stub()
      mockRootSpan = {
        context: () => {
          return { _tags: { 'usr.id': 'mockUser' } }
        },
        setTag: mockSetTag }
      getRootSpan = sinon.stub().returns(mockRootSpan)

      const { setUser } = proxyquire('../../../src/appsec/sdk/set_user', {
        './utils': { getRootSpan }
      })

      const AppsecSdk = proxyquire('../../../src/appsec/sdk', {
        './set_user': { setUser }
      })

      sdk = new AppsecSdk(tracer)
    })

    it('Check setUser', () => {
      const user = { id: 'user' }
      sdk.setUser(user)
      expect(mockSetTag).to.be.calledWith('usr.id', 'user')
    })

    it('Check setUser with no user', () => {
      sdk.setUser()
      expect(mockSetTag).not.to.have.been.called
    })

    it('Check setUser with no user id', () => {
      const user = {}
      sdk.setUser(user)
      expect(mockSetTag).not.to.have.been.called
    })

    it('Check setUser with a user with several attributes', () => {
      const user = {
        id: '123',
        email: 'a@b.c',
        custom: 'hello'
      }

      sdk.setUser(user)
      expect(mockSetTag).to.have.been.calledThrice
      expect(mockSetTag.firstCall).to.have.been.calledWithExactly('usr.id', '123')
      expect(mockSetTag.secondCall).to.have.been.calledWithExactly('usr.email', 'a@b.c')
      expect(mockSetTag.thirdCall).to.have.been.calledWithExactly('usr.custom', 'hello')
    })
  })

  describe('Check internal callings, no rootSpan', () => {
    const tracer = {}
    const getRootSpan = sinon.stub().returns(undefined)

    const { setUser } = proxyquire('../../../src/appsec/sdk/set_user', {
      './utils': { getRootSpan }
    })

    const AppsecSdk = proxyquire('../../../src/appsec/sdk', {
      './set_user': { setUser }
    })

    const sdk = new AppsecSdk(tracer)

    it('Check setUser no rootSpan', () => {
      sdk._setUser = sinon.stub()
      sdk.setUser({ id: 'user' })
      expect(getRootSpan).to.be.calledWith(tracer)
      expect(sdk._setUser).not.to.have.been.called
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
      appsec.disable()
      appListener.close()
      return agent.close({ ritmReset: false })
    })

    beforeEach(() => {
      const config = new Config({
        appsec: {
          enabled: true
        }
      })
      appsec.enable(config)
    })

    describe('setUser', () => {
      it('should set a proper user', (done) => {
        controller = (req, res) => {
          const user = { id: 'testUser' }
          tracer.appsec.setUser(user)
          res.end()
        }
        agent.use(traces => {
          expect(traces[0][0].meta).to.have.property('usr.id', 'testUser')
        }).then(done).catch(done)
        axios.get(`http://localhost:${port}/`)
      })

      it('Last user should prevail', (done) => {
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
