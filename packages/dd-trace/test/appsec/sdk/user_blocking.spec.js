'use strict'

const proxyquire = require('proxyquire')
const agent = require('../../plugins/agent')
const tracer = require('../../../../../index')
const appsec = require('../../../src/appsec')
const Config = require('../../../src/config')
const getPort = require('get-port')
const axios = require('axios')
const RuleManager = require('../../../src/appsec/rule_manager')
const fs = require('fs')
const crypto = require('crypto')

describe('User blocking API', () => {
  describe('Test internal API', () => {
    const tracer = {}
    const mockReq = { protocol: 'https' }
    const mockRes = { headersSent: false }
    const storage = { getStore: () => {
      return { req: mockReq, res: mockRes }
    } }

    let block, getRootSpan, mockRootSpan, mockSetTag, userBlocking, isUserBlocked

    beforeEach(() => {
      block = sinon.stub()
      mockSetTag = sinon.stub()
      mockRootSpan = {
        context: () => {
          return { _tags: { 'usr.id': 'mockUser' } }
        },
        setTag: mockSetTag
      }
      getRootSpan = sinon.stub().returns(mockRootSpan)
      isUserBlocked = sinon.stub()
      userBlocking = proxyquire('../../../src/appsec/sdk/user_blocking', {
        './utils': { getRootSpan },
        '../blocking': { block },
        '../../../../datadog-core': { storage },
        'isUserBlocked': isUserBlocked
      })
    })

    it('checkUserAndSetUser should return false with an empty user', () => {
      const user = {}
      const ret = userBlocking.checkUserAndSetUser(tracer, user)
      expect(ret).to.be.false
      expect(isUserBlocked).not.to.have.been.called
    })

    it('checkUserAndSetUser should return false with no user', () => {
      const ret = userBlocking.checkUserAndSetUser()
      expect(ret).to.be.false
      expect(isUserBlocked).not.to.have.been.called
    })

    it('blockRequest should call block with proper arguments', () => {
      userBlocking.blockRequest(tracer, {}, {})
      expect(block).to.be.calledWith({ req: {}, res: {}, topSpan: mockRootSpan })
    })

    it('blockRequest should get req and res from local storage when they are not passed', () => {
      userBlocking.blockRequest(tracer)
      expect(block).to.be.calledWith({ req: mockReq, res: mockRes, topSpan: mockRootSpan })
    })
  })

  describe('Test internal API, no rootSpan', () => {
    const tracer = {}
    const mockReq = { protocol: 'https' }
    const mockRes = { headersSent: false }
    const storage = { getStore: () => {
      return { req: mockReq, res: mockRes }
    } }

    let block, getRootSpan, userBlocking, isUserBlocked

    beforeEach(() => {
      block = sinon.stub()
      getRootSpan = sinon.stub().returns(undefined)
      isUserBlocked = sinon.stub()
      userBlocking = proxyquire('../../../src/appsec/sdk/user_blocking', {
        './utils': { getRootSpan },
        '../blocking': { block },
        '../../../../datadog-core': { storage },
        'isUserBlocked': isUserBlocked
      })
    })

    it('blockRequest should return proper value when there is no rootSpan available', () => {
      const ret = userBlocking.blockRequest({}, {})
      expect(ret).to.be.false
      expect(block).not.to.have.been.called
    })

    it('checkUserAndSetUser should return false when there is no rootSpan available', () => {
      const ret = userBlocking.checkUserAndSetUser(tracer, { id: 'user' })
      expect(getRootSpan).to.be.calledWith(tracer)
      expect(ret).to.be.false
      expect(isUserBlocked).not.to.have.been.called
    })
  })

  describe('Test internal API, no storage', () => {
    const tracer = {}
    const storage = { getStore: () => {
      return undefined
    } }

    let block, getRootSpan, userBlocking, isUserBlocked

    beforeEach(() => {
      block = sinon.stub()
      getRootSpan = sinon.stub().returns(undefined)
      isUserBlocked = sinon.stub()
      userBlocking = proxyquire('../../../src/appsec/sdk/user_blocking', {
        './utils': { getRootSpan },
        '../blocking': { block },
        '../../../../datadog-core': { storage },
        'isUserBlocked': isUserBlocked
      })
    })

    it('blockRequest should return false when the storage is not available', () => {
      const ret = userBlocking.blockRequest(tracer)
      expect(ret).to.be.false
      expect(getRootSpan).not.to.have.been.called
    })
  })

  describe('Integration with the tracer', () => {
    let http
    let controller
    let appListener
    let port
    const blockedUser = 'blockedUser'
    const blockRuleData = {
      rules_data: [{
        data: [
          { value: blockedUser }
        ],
        id: 'blocked_users',
        type: 'data_with_expiration'
      }
      ] }
    const rules = JSON.stringify({
      version: '2.2',
      metadata: {
        rules_version: '1.4.2'
      },
      rules: [
        {
          id: 'blk-001-002',
          name: 'Block User Addresses',
          tags: {
            type: 'block_user',
            category: 'security_response'
          },
          conditions: [
            {
              parameters: {
                inputs: [
                  {
                    address: 'usr.id'
                  }
                ],
                data: 'blocked_users'
              },
              operator: 'exact_match'
            }
          ],
          transformers: [],
          on_match: [
            'block'
          ]
        }
      ]
    })

    const rulesPath = `block_rule_${crypto.randomUUID()}`

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
      fs.writeFileSync(rulesPath, rules)
      const server = new http.Server(listener)
      appListener = server
        .listen(port, 'localhost', () => done())
    })

    after(() => {
      fs.rmSync(rulesPath)
      appsec.disable()
      appListener.close()
      return agent.close({ ritmReset: false })
    })

    beforeEach(() => {
      const config = new Config({
        appsec: {
          enabled: true,
          rules: rulesPath
        }
      })
      appsec.enable(config)
      RuleManager.updateAsmData('apply', blockRuleData, 'asm_data')
    })

    describe('isUserBlocked', () => {
      it('should set the user if user is not defined', (done) => {
        controller = (req, res) => {
          const ret = tracer.appsec.isUserBlocked({ id: 'testUser3' })
          expect(ret).to.be.false
          res.end()
        }
        agent.use(traces => {
          expect(traces[0][0].meta).to.have.property('usr.id', 'testUser3')
        }).then(done).catch(done)
        axios.get(`http://localhost:${port}/`)
      })

      it('should not set the user if user is already defined', (done) => {
        controller = (req, res) => {
          tracer.setUser({ id: 'testUser' })
          const ret = tracer.appsec.isUserBlocked({ id: 'testUser3' })
          expect(ret).to.be.false
          res.end()
        }
        agent.use(traces => {
          expect(traces[0][0].meta).to.have.property('usr.id', 'testUser')
        }).then(done).catch(done)
        axios.get(`http://localhost:${port}/`)
      })

      it('should return true if user is in the blocklist', (done) => {
        controller = (req, res) => {
          const ret = tracer.appsec.isUserBlocked({ id: 'blockedUser' })
          expect(ret).to.be.true
          res.end()
        }
        agent.use(traces => {
          expect(traces[0][0].meta).to.have.property('usr.id', 'blockedUser')
        }).then(done).catch(done)
        axios.get(`http://localhost:${port}/`)
      })
    })

    describe('blockRequest', () => {
      it('should set the proper tag', (done) => {
        controller = (req, res) => {
          tracer.appsec.blockRequest(req, res)
        }
        agent.use(traces => {
          expect(traces[0][0].meta).to.have.property('appsec.blocked', 'true')
        }).then(done).catch(done)
        axios.get(`http://localhost:${port}/`)
      })

      it('should get the params from the store if they are not passed', (done) => {
        controller = (req, res) => {
          if (!tracer.appsec.blockRequest()) {
            res.end()
          }
        }
        agent.use(traces => {
          expect(traces[0][0].meta).to.have.property('appsec.blocked', 'true')
        }).then(done).catch(done)
        axios.get(`http://localhost:${port}/`)
      })
    })
  })
})
