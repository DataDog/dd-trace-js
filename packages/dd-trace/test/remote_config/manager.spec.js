'use strict'

const Capabilities = require('../../src/remote_config/capabilities')
const { UNACKNOWLEDGED, ACKNOWLEDGED, ERROR } = require('../../src/remote_config/apply_states')

const noop = () => {}

describe('RemoteConfigManager', () => {
  let uuid
  let scheduler
  let Scheduler
  let request
  let log
  let extraServices
  let RemoteConfigManager
  let config
  let rc
  let tagger

  beforeEach(() => {
    uuid = sinon.stub().returns('1234-5678')

    scheduler = {
      start: sinon.spy(),
      stop: sinon.spy()
    }

    Scheduler = sinon.stub().returns(scheduler)

    request = sinon.stub()

    log = {
      error: sinon.spy()
    }

    tagger = {
      add: sinon.stub()
    }

    extraServices = []

    RemoteConfigManager = proxyquire('../src/remote_config/manager', {
      'crypto-randomuuid': uuid,
      './scheduler': Scheduler,
      '../../../../../package.json': { version: '3.0.0' },
      '../../exporters/common/request': request,
      '../../log': log,
      '../tagger': tagger,
      '../../service-naming/extra-services': {
        getExtraServices: () => extraServices
      }
    })

    config = {
      url: 'http://127.0.0.1:1337',
      hostname: '127.0.0.1',
      port: '1337',
      tags: {
        'runtime-id': 'runtimeId'
      },
      service: 'serviceName',
      env: 'serviceEnv',
      version: 'appVersion',
      remoteConfig: {
        pollInterval: 5
      }
    }

    rc = new RemoteConfigManager(config)
  })

  it('should instantiate RemoteConfigManager', () => {
    sinon.stub(rc, 'poll')

    expect(Scheduler).to.have.been.calledOnce
    const [firstArg, secondArg] = Scheduler.firstCall.args
    expect(firstArg).to.be.a('function')
    expect(secondArg).to.equal(5e3)

    firstArg(noop)
    expect(rc.poll).to.have.calledOnceWithExactly(noop)

    expect(rc.scheduler).to.equal(scheduler)

    expect(rc.url).to.equal(config.url)

    expect(tagger.add).to.have.been.calledOnceWithExactly(config.tags, {
      '_dd.rc.client_id': '1234-5678'
    })

    expect(rc.state).to.deep.equal({
      client: {
        state: {
          root_version: 1,
          targets_version: 0,
          config_states: [],
          has_error: false,
          error: '',
          backend_client_state: ''
        },
        id: '1234-5678',
        products: [],
        is_tracer: true,
        client_tracer: {
          runtime_id: config.tags['runtime-id'],
          language: 'node',
          tracer_version: '3.0.0',
          service: config.service,
          env: config.env,
          app_version: config.version,
          extra_services: [],
          tags: ['runtime-id:runtimeId']
        },
        capabilities: 'AA=='
      },
      cached_target_files: []
    })

    expect(rc.appliedConfigs).to.be.an.instanceOf(Map)
  })

  it('should add git metadata to tags if present', () => {
    const configWithGit = {
      ...config,
      repositoryUrl: 'https://github.com/DataDog/dd-trace-js',
      commitSHA: '1234567890'
    }
    const rc = new RemoteConfigManager(configWithGit)
    expect(rc.state.client.client_tracer.tags).to.deep.equal([
      'runtime-id:runtimeId',
      'git.repository_url:https://github.com/DataDog/dd-trace-js',
      'git.commit.sha:1234567890'
    ])
  })

  describe('updateCapabilities', () => {
    it('should set multiple capabilities to true', () => {
      rc.updateCapabilities(Capabilities.ASM_ACTIVATION, true)
      expect(rc.state.client.capabilities).to.equal('Ag==')

      rc.updateCapabilities(Capabilities.ASM_IP_BLOCKING, true)
      expect(rc.state.client.capabilities).to.equal('Bg==')

      rc.updateCapabilities(Capabilities.ASM_DD_RULES, true)
      expect(rc.state.client.capabilities).to.equal('Dg==')

      rc.updateCapabilities(Capabilities.ASM_USER_BLOCKING, true)
      expect(rc.state.client.capabilities).to.equal('jg==')
    })

    it('should set multiple capabilities to false', () => {
      rc.state.client.capabilities = 'jg=='

      rc.updateCapabilities(Capabilities.ASM_USER_BLOCKING, false)
      expect(rc.state.client.capabilities).to.equal('Dg==')

      rc.updateCapabilities(Capabilities.ASM_ACTIVATION, false)
      expect(rc.state.client.capabilities).to.equal('DA==')

      rc.updateCapabilities(Capabilities.ASM_IP_BLOCKING, false)
      expect(rc.state.client.capabilities).to.equal('CA==')

      rc.updateCapabilities(Capabilities.ASM_DD_RULES, false)
      expect(rc.state.client.capabilities).to.equal('AA==')
    })

    it('should set an arbitrary amount of capabilities', () => {
      rc.updateCapabilities(1n << 1n, true)
      rc.updateCapabilities(1n << 200n, true)
      expect(rc.state.client.capabilities).to.equal('AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAI=')

      rc.updateCapabilities(1n << 200n, false)
      expect(rc.state.client.capabilities).to.equal('Ag==')
    })
  })

  describe('setProductHandler/removeProductHandler', () => {
    it('should update the product list and autostart or autostop', () => {
      expect(rc.scheduler.start).to.not.have.been.called

      rc.setProductHandler('ASM_FEATURES', noop)

      expect(rc.state.client.products).to.deep.equal(['ASM_FEATURES'])
      expect(rc.scheduler.start).to.have.been.called

      rc.setProductHandler('ASM_DATA', noop)
      rc.setProductHandler('ASM_DD', noop)

      expect(rc.state.client.products).to.deep.equal(['ASM_FEATURES', 'ASM_DATA', 'ASM_DD'])

      rc.removeProductHandler('ASM_FEATURES')

      expect(rc.state.client.products).to.deep.equal(['ASM_DATA', 'ASM_DD'])

      rc.removeProductHandler('ASM_DATA')

      expect(rc.scheduler.stop).to.not.have.been.called

      rc.removeProductHandler('ASM_DD')

      expect(rc.scheduler.stop).to.have.been.called
      expect(rc.state.client.products).to.be.empty
    })
  })

  describe('poll', () => {
    let expectedPayload

    beforeEach(() => {
      sinon.stub(rc, 'parseConfig')
      expectedPayload = {
        url: rc.url,
        method: 'POST',
        path: '/v0.7/config',
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      }
    })

    it('should request and do nothing when received status 404', (cb) => {
      request.yieldsRight(new Error('Response received 404'), '{"a":"b"}', 404)

      const payload = JSON.stringify(rc.state)

      rc.poll(() => {
        expect(request).to.have.been.calledOnceWith(payload, expectedPayload)
        expect(log.error).to.not.have.been.called
        expect(rc.parseConfig).to.not.have.been.called
        cb()
      })
    })

    it('should request and log when received error', (cb) => {
      const err = new Error('Response received 500')
      request.yieldsRight(err, '{"a":"b"}', 500)

      const payload = JSON.stringify(rc.state)

      rc.poll(() => {
        expect(request).to.have.been.calledOnceWith(payload, expectedPayload)
        expect(log.error).to.have.been.calledOnceWithExactly('[RC] Error in request', err)
        expect(rc.parseConfig).to.not.have.been.called
        cb()
      })
    })

    it('should request and call parseConfig when payload is not empty', (cb) => {
      request.yieldsRight(null, '{"a":"b"}', 200)

      const payload = JSON.stringify(rc.state)

      rc.poll(() => {
        expect(request).to.have.been.calledOnceWith(payload, expectedPayload)
        expect(log.error).to.not.have.been.called
        expect(rc.parseConfig).to.have.been.calledOnceWithExactly({ a: 'b' })
        cb()
      })
    })

    it('should catch exceptions, update the error state, and clear the error state at next request', (cb) => {
      const error = new Error('Unable to parse config')
      request
        .onFirstCall().yieldsRight(null, '{"a":"b"}', 200)
        .onSecondCall().yieldsRight(null, null, 200)
      rc.parseConfig.onFirstCall().throws(error)

      const payload = JSON.stringify(rc.state)

      rc.poll(() => {
        expect(request).to.have.been.calledOnceWith(payload, expectedPayload)
        expect(rc.parseConfig).to.have.been.calledOnceWithExactly({ a: 'b' })
        expect(log.error).to.have.been
          .calledOnceWithExactly('[RC] Could not parse remote config response', error)
        expect(rc.state.client.state.has_error).to.be.true
        expect(rc.state.client.state.error).to.equal('Error: Unable to parse config')

        const payload2 = JSON.stringify(rc.state)

        rc.poll(() => {
          expect(request).to.have.been.calledTwice
          expect(request.secondCall).to.have.been.calledWith(payload2, expectedPayload)
          expect(rc.parseConfig).to.have.been.calledOnce
          expect(log.error).to.have.been.calledOnce
          expect(rc.state.client.state.has_error).to.be.false
          expect(rc.state.client.state.error).to.be.empty
          cb()
        })
      })
    })

    it('should request and do nothing when payload is empty JSON object', (cb) => {
      request.yieldsRight(null, '{}', 200)

      const payload = JSON.stringify(rc.state)

      rc.poll(() => {
        expect(request).to.have.been.calledOnceWith(payload, expectedPayload)
        expect(log.error).to.not.have.been.called
        expect(rc.parseConfig).to.not.have.been.called
        cb()
      })
    })

    it('should include extra_services in the payload', (cb) => {
      request.yieldsRight(null, '{}', 200)

      extraServices = ['test-service']

      // getPayload includes the new extraServices that might be available
      const payload = rc.getPayload()
      expect(JSON.parse(payload).client.client_tracer.extra_services).to.deep.equal(extraServices)

      rc.poll(() => {
        expect(request).to.have.been.calledOnceWith(payload, expectedPayload)
        cb()
      })
    })
  })

  describe('parseConfig', () => {
    let payload
    const func = () => rc.parseConfig(payload)
    let previousState

    beforeEach(() => {
      sinon.stub(rc, 'dispatch').callsFake((list, action) => {
        for (const item of list) {
          item.apply_state = ACKNOWLEDGED

          if (action === 'unapply') rc.appliedConfigs.delete(item.path)
          else rc.appliedConfigs.set(item.path, item)
        }
      })

      previousState = JSON.parse(JSON.stringify(rc.state))
    })

    it('should do nothing if passed an empty payload', () => {
      payload = {}

      expect(func).to.not.throw()
      expect(rc.dispatch).to.not.have.been.called
      expect(rc.state).to.deep.equal(previousState)
    })

    it('should throw when target is not found', () => {
      payload = {
        client_configs: ['datadog/42/PRODUCT/confId/config'],
        targets: toBase64({
          signed: {
            targets: {
              'datadog/42/OTHERPRODUCT/confId/config': {}
            }
          }
        })
      }

      expect(func).to.throw('Unable to find target for path datadog/42/PRODUCT/confId/config')
      expect(rc.dispatch).to.not.have.been.called
      expect(rc.state).to.deep.equal(previousState)
    })

    it('should throw when target file is not found', () => {
      payload = {
        client_configs: ['datadog/42/PRODUCT/confId/config'],
        targets: toBase64({
          signed: {
            targets: {
              'datadog/42/PRODUCT/confId/config': {
                hashes: {
                  sha256: 'haaaxx'
                }
              }
            }
          }
        })
      }

      expect(func).to.throw('Unable to find file for path datadog/42/PRODUCT/confId/config')
      expect(rc.dispatch).to.not.have.been.called
      expect(rc.state).to.deep.equal(previousState)
    })

    it('should throw when config path cannot be parsed', () => {
      payload = {
        client_configs: ['datadog/42/confId/config'],
        targets: toBase64({
          signed: {
            targets: {
              'datadog/42/confId/config': {
                hashes: {
                  sha256: 'haaaxx'
                }
              }
            }
          }
        }),
        target_files: [{
          path: 'datadog/42/confId/config',
          raw: toBase64({})
        }]
      }

      expect(func).to.throw('Unable to parse path datadog/42/confId/config')
      expect(rc.dispatch).to.not.have.been.called
      expect(rc.state).to.deep.equal(previousState)
    })

    it('should parse the config, call dispatch, and update the state', () => {
      rc.appliedConfigs.set('datadog/42/UNAPPLY/confId/config', {
        path: 'datadog/42/UNAPPLY/confId/config',
        product: 'UNAPPLY',
        id: 'confId',
        version: 69,
        apply_state: ACKNOWLEDGED,
        apply_error: '',
        length: 147,
        hashes: { sha256: 'anotherHash' },
        file: { asm: { enabled: true } }
      })
      rc.appliedConfigs.set('datadog/42/IGNORE/confId/config', {
        path: 'datadog/42/IGNORE/confId/config',
        product: 'IGNORE',
        id: 'confId',
        version: 43,
        apply_state: ACKNOWLEDGED,
        apply_error: '',
        length: 420,
        hashes: { sha256: 'sameHash' },
        file: {}
      })
      rc.appliedConfigs.set('datadog/42/MODIFY/confId/config', {
        path: 'datadog/42/MODIFY/confId/config',
        product: 'MODIFY',
        id: 'confId',
        version: 11,
        apply_state: ACKNOWLEDGED,
        apply_error: '',
        length: 147,
        hashes: { sha256: 'oldHash' },
        file: { config: 'oldConf' }
      })

      payload = {
        client_configs: [
          'datadog/42/IGNORE/confId/config',
          'datadog/42/MODIFY/confId/config',
          'datadog/42/APPLY/confId/config'
        ],
        targets: toBase64({
          signed: {
            custom: {
              opaque_backend_state: 'opaquestateinbase64'
            },
            targets: {
              'datadog/42/IGNORE/confId/config': {
                custom: {
                  v: 43
                },
                hashes: {
                  sha256: 'sameHash'
                },
                length: 420
              },
              'datadog/42/MODIFY/confId/config': {
                custom: {
                  v: 12
                },
                hashes: {
                  sha256: 'newHash'
                },
                length: 147
              },
              'datadog/42/APPLY/confId/config': {
                custom: {
                  v: 1
                },
                hashes: {
                  sha256: 'haaaxx'
                },
                length: 0
              }
            },
            version: 12345
          }
        }),
        target_files: [
          {
            path: 'datadog/42/MODIFY/confId/config',
            raw: toBase64({ config: 'newConf' })
          },
          {
            path: 'datadog/42/APPLY/confId/config',
            raw: ''
          }
        ]
      }

      expect(func).to.not.throw()

      expect(rc.state.client.state.targets_version).to.equal(12345)
      expect(rc.state.client.state.backend_client_state).to.equal('opaquestateinbase64')

      expect(rc.dispatch).to.have.been.calledThrice
      expect(rc.dispatch.firstCall).to.have.been.calledWithExactly([{
        path: 'datadog/42/UNAPPLY/confId/config',
        product: 'UNAPPLY',
        id: 'confId',
        version: 69,
        apply_state: ACKNOWLEDGED,
        apply_error: '',
        length: 147,
        hashes: { sha256: 'anotherHash' },
        file: { asm: { enabled: true } }
      }], 'unapply')
      expect(rc.dispatch.secondCall).to.have.been.calledWithExactly([{
        path: 'datadog/42/APPLY/confId/config',
        product: 'APPLY',
        id: 'confId',
        version: 1,
        apply_state: ACKNOWLEDGED,
        apply_error: '',
        length: 0,
        hashes: { sha256: 'haaaxx' },
        file: null
      }], 'apply')
      expect(rc.dispatch.thirdCall).to.have.been.calledWithExactly([{
        path: 'datadog/42/MODIFY/confId/config',
        product: 'MODIFY',
        id: 'confId',
        version: 12,
        apply_state: ACKNOWLEDGED,
        apply_error: '',
        length: 147,
        hashes: { sha256: 'newHash' },
        file: { config: 'newConf' }
      }], 'modify')

      expect(rc.state.client.state.config_states).to.deep.equal([
        {
          id: 'confId',
          version: 43,
          product: 'IGNORE',
          apply_state: ACKNOWLEDGED,
          apply_error: ''
        },
        {
          id: 'confId',
          version: 12,
          product: 'MODIFY',
          apply_state: ACKNOWLEDGED,
          apply_error: ''
        },
        {
          id: 'confId',
          version: 1,
          product: 'APPLY',
          apply_state: ACKNOWLEDGED,
          apply_error: ''
        }
      ])
      expect(rc.state.cached_target_files).to.deep.equal([
        {
          path: 'datadog/42/IGNORE/confId/config',
          length: 420,
          hashes: [{ algorithm: 'sha256', hash: 'sameHash' }]
        },
        {
          path: 'datadog/42/MODIFY/confId/config',
          length: 147,
          hashes: [{ algorithm: 'sha256', hash: 'newHash' }]
        },
        {
          path: 'datadog/42/APPLY/confId/config',
          length: 0,
          hashes: [{ algorithm: 'sha256', hash: 'haaaxx' }]
        }
      ])
    })
  })

  describe('dispatch', () => {
    it('should call registered handler for each config, catch errors, and update the state', (done) => {
      const syncGoodNonAckHandler = sinon.spy()
      const syncBadNonAckHandler = sinon.spy(() => { throw new Error('sync fn') })
      const asyncGoodHandler = sinon.spy(async () => {})
      const asyncBadHandler = sinon.spy(async () => { throw new Error('async fn') })
      const syncGoodAckHandler = sinon.spy((action, conf, id, ack) => { ack() })
      const syncBadAckHandler = sinon.spy((action, conf, id, ack) => { ack(new Error('sync ack fn')) })
      const asyncGoodAckHandler = sinon.spy((action, conf, id, ack) => { setImmediate(ack) })
      const asyncBadAckHandler = sinon.spy((action, conf, id, ack) => {
        setImmediate(ack.bind(null, new Error('async ack fn')))
      })
      const unackHandler = sinon.spy((action, conf, id, ack) => {})

      rc.setProductHandler('PRODUCT_0', syncGoodNonAckHandler)
      rc.setProductHandler('PRODUCT_1', syncBadNonAckHandler)
      rc.setProductHandler('PRODUCT_2', asyncGoodHandler)
      rc.setProductHandler('PRODUCT_3', asyncBadHandler)
      rc.setProductHandler('PRODUCT_4', syncGoodAckHandler)
      rc.setProductHandler('PRODUCT_5', syncBadAckHandler)
      rc.setProductHandler('PRODUCT_6', asyncGoodAckHandler)
      rc.setProductHandler('PRODUCT_7', asyncBadAckHandler)
      rc.setProductHandler('PRODUCT_8', unackHandler)

      const list = []
      for (let i = 0; i < 9; i++) {
        list[i] = {
          id: `id_${i}`,
          path: `datadog/42/PRODUCT_${i}/confId/config`,
          product: `PRODUCT_${i}`,
          apply_state: UNACKNOWLEDGED,
          apply_error: '',
          file: { index: i }
        }
      }

      rc.dispatch(list, 'apply')

      expect(syncGoodNonAckHandler).to.have.been.calledOnceWithExactly('apply', list[0].file, list[0].id)
      expect(syncBadNonAckHandler).to.have.been.calledOnceWithExactly('apply', list[1].file, list[1].id)
      expect(asyncGoodHandler).to.have.been.calledOnceWithExactly('apply', list[2].file, list[2].id)
      expect(asyncBadHandler).to.have.been.calledOnceWithExactly('apply', list[3].file, list[3].id)
      assertAsyncHandlerCallArguments(syncGoodAckHandler, 'apply', list[4].file, list[4].id)
      assertAsyncHandlerCallArguments(syncBadAckHandler, 'apply', list[5].file, list[5].id)
      assertAsyncHandlerCallArguments(asyncGoodAckHandler, 'apply', list[6].file, list[6].id)
      assertAsyncHandlerCallArguments(asyncBadAckHandler, 'apply', list[7].file, list[7].id)
      assertAsyncHandlerCallArguments(unackHandler, 'apply', list[8].file, list[8].id)

      expect(list[0].apply_state).to.equal(ACKNOWLEDGED)
      expect(list[0].apply_error).to.equal('')
      expect(list[1].apply_state).to.equal(ERROR)
      expect(list[1].apply_error).to.equal('Error: sync fn')
      expect(list[2].apply_state).to.equal(UNACKNOWLEDGED)
      expect(list[2].apply_error).to.equal('')
      expect(list[3].apply_state).to.equal(UNACKNOWLEDGED)
      expect(list[3].apply_error).to.equal('')
      expect(list[4].apply_state).to.equal(ACKNOWLEDGED)
      expect(list[4].apply_error).to.equal('')
      expect(list[5].apply_state).to.equal(ERROR)
      expect(list[5].apply_error).to.equal('Error: sync ack fn')
      expect(list[6].apply_state).to.equal(UNACKNOWLEDGED)
      expect(list[6].apply_error).to.equal('')
      expect(list[7].apply_state).to.equal(UNACKNOWLEDGED)
      expect(list[7].apply_error).to.equal('')
      expect(list[8].apply_state).to.equal(UNACKNOWLEDGED)
      expect(list[8].apply_error).to.equal('')

      for (let i = 0; i < list.length; i++) {
        expect(rc.appliedConfigs.get(`datadog/42/PRODUCT_${i}/confId/config`)).to.equal(list[i])
      }

      setImmediate(() => {
        expect(list[2].apply_state).to.equal(ACKNOWLEDGED)
        expect(list[2].apply_error).to.equal('')
        expect(list[3].apply_state).to.equal(ERROR)
        expect(list[3].apply_error).to.equal('Error: async fn')
        expect(list[6].apply_state).to.equal(ACKNOWLEDGED)
        expect(list[6].apply_error).to.equal('')
        expect(list[7].apply_state).to.equal(ERROR)
        expect(list[7].apply_error).to.equal('Error: async ack fn')
        expect(list[8].apply_state).to.equal(UNACKNOWLEDGED)
        expect(list[8].apply_error).to.equal('')
        done()
      })

      function assertAsyncHandlerCallArguments (handler, ...expectedArgs) {
        expect(handler).to.have.been.calledOnceWith(...expectedArgs)
        expect(handler.args[0].length).to.equal(expectedArgs.length + 1)
        expect(handler.args[0][handler.args[0].length - 1]).to.be.a('function')
      }
    })

    it('should delete config from state when action is unapply', () => {
      const handler = sinon.spy()
      rc.setProductHandler('ASM_FEATURES', handler)

      rc.appliedConfigs.set('datadog/42/ASM_FEATURES/confId/config', {
        id: 'asm_data',
        path: 'datadog/42/ASM_FEATURES/confId/config',
        product: 'ASM_FEATURES',
        apply_state: ACKNOWLEDGED,
        apply_error: '',
        file: { asm: { enabled: true } }
      })

      rc.dispatch([rc.appliedConfigs.get('datadog/42/ASM_FEATURES/confId/config')], 'unapply')

      expect(handler).to.have.been.calledOnceWithExactly('unapply', { asm: { enabled: true } }, 'asm_data')
      expect(rc.appliedConfigs).to.be.empty
    })
  })
})

function toBase64 (data) {
  return Buffer.from(JSON.stringify(data), 'utf8').toString('base64')
}
