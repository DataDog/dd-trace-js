'use strict'

const Capabilities = require('../../src/remote_config/capabilities')

const noop = () => {}

describe('RemoteConfigManager', () => {
  let uuid
  let scheduler
  let Scheduler
  let request
  let log
  let RemoteConfigManager
  let config
  let rc

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

    RemoteConfigManager = proxyquire('../src/remote_config', {
      'crypto-randomuuid': uuid,
      './scheduler': Scheduler,
      '../../../../package.json': { version: '3.0.0' },
      '../exporters/common/request': request,
      '../log': log
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
      version: 'appVersion'
    }

    sinon.spy(RemoteConfigManager.prototype, 'on')
    sinon.spy(RemoteConfigManager.prototype, 'emit')

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

    expect(rc.requestOptions).to.deep.equal({
      method: 'POST',
      url: config.url,
      hostname: config.hostname,
      port: config.port,
      path: '/v0.7/config'
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
          app_version: config.version
        },
        capabilities: 'AA=='
      },
      cached_target_files: []
    })

    expect(rc.appliedConfigs).to.be.an.instanceOf(Map)

    expect(rc.on).to.have.been.calledTwice
    expect(rc.on.firstCall).to.have.been.calledWithExactly('newListener', rc.updateProducts)
    expect(rc.on.secondCall).to.have.been.calledWithExactly('removeListener', rc.updateProducts)
  })

  describe('updateCapabilities', () => {
    it('should set multiple capabilities to true', () => {
      rc.updateCapabilities(Capabilities.ASM_ACTIVATION, true)
      expect(rc.state.client.capabilities).to.equal('Ag==')

      rc.updateCapabilities(Capabilities.ASM_IP_BLOCKING, true)
      expect(rc.state.client.capabilities).to.equal('Bg==')

      rc.updateCapabilities(Capabilities.ASM_DD_RULES, true)
      expect(rc.state.client.capabilities).to.equal('Dg==')
    })

    it('should set multiple capabilities to false', () => {
      rc.state.client.capabilities = 'Dg=='

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

  describe('updateProducts', () => {
    it('should update the product list and autostart', (cb) => {
      rc.on('ASM_FEATURES', noop)
      rc.on('ASM_DATA', noop)
      rc.on('ASM_DD', noop)

      expect(rc.state.client.products).to.be.empty

      process.nextTick(() => {
        expect(rc.scheduler.start).to.have.been.calledThrice
        expect(rc.state.client.products).to.deep.equal(['ASM_FEATURES', 'ASM_DATA', 'ASM_DD'])
        cb()
      })
    })

    it('should update the product list and autostop', (cb) => {
      rc.scheduler.stop.resetHistory()

      rc.on('ASM_FEATURES', noop)
      rc.on('ASM_DATA', noop)
      rc.on('ASM_DD', noop)

      process.nextTick(() => {
        rc.off('ASM_FEATURES', noop)
        rc.off('ASM_DATA', noop)
        rc.off('ASM_DD', noop)

        expect(rc.state.client.products).to.deep.equal(['ASM_FEATURES', 'ASM_DATA', 'ASM_DD'])

        process.nextTick(() => {
          expect(rc.scheduler.stop).to.have.been.calledThrice
          expect(rc.state.client.products).to.be.empty
          cb()
        })
      })
    })
  })

  describe('poll', () => {
    beforeEach(() => {
      sinon.stub(rc, 'parseConfig')
    })

    it('should request and do nothing when received status 404', (cb) => {
      request.yieldsRight(new Error('Response received 404'), '{"a":"b"}', 404)

      const payload = JSON.stringify(rc.state)

      rc.poll(() => {
        expect(request).to.have.been.calledOnceWith(payload, rc.requestOptions)
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
        expect(request).to.have.been.calledOnceWith(payload, rc.requestOptions)
        expect(log.error).to.have.been.calledOnceWithExactly(err)
        expect(rc.parseConfig).to.not.have.been.called
        cb()
      })
    })

    it('should request and call parseConfig when payload is not empty', (cb) => {
      request.yieldsRight(null, '{"a":"b"}', 200)

      const payload = JSON.stringify(rc.state)

      rc.poll(() => {
        expect(request).to.have.been.calledOnceWith(payload, rc.requestOptions)
        expect(log.error).to.not.have.been.called
        expect(rc.parseConfig).to.have.been.calledOnceWithExactly({ a: 'b' })
        cb()
      })
    })

    it('should catch exceptions, update the error state, and clear the error state at next request', (cb) => {
      request
        .onFirstCall().yieldsRight(null, '{"a":"b"}', 200)
        .onSecondCall().yieldsRight(null, null, 200)
      rc.parseConfig.onFirstCall().throws(new Error('Unable to parse config'))

      const payload = JSON.stringify(rc.state)

      rc.poll(() => {
        expect(request).to.have.been.calledOnceWith(payload, rc.requestOptions)
        expect(rc.parseConfig).to.have.been.calledOnceWithExactly({ a: 'b' })
        expect(log.error).to.have.been
          .calledOnceWithExactly('Could not parse remote config response: Error: Unable to parse config')
        expect(rc.state.client.state.has_error).to.be.true
        expect(rc.state.client.state.error).to.equal('Error: Unable to parse config')

        const payload2 = JSON.stringify(rc.state)

        rc.poll(() => {
          expect(request).to.have.been.calledTwice
          expect(request.secondCall).to.have.been.calledWith(payload2, rc.requestOptions)
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
        expect(request).to.have.been.calledOnceWith(payload, rc.requestOptions)
        expect(log.error).to.not.have.been.called
        expect(rc.parseConfig).to.not.have.been.called
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
          item.apply_state = 2

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
        apply_state: 2,
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
        apply_state: 2,
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
        apply_state: 2,
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
        apply_state: 2,
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
        apply_state: 2,
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
        apply_state: 2,
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
          apply_state: 2,
          apply_error: ''
        },
        {
          id: 'confId',
          version: 12,
          product: 'MODIFY',
          apply_state: 2,
          apply_error: ''
        },
        {
          id: 'confId',
          version: 1,
          product: 'APPLY',
          apply_state: 2,
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
    beforeEach(() => {
      rc.emit.restore()
      sinon.stub(rc, 'emit')
    })

    it('should call emit for each config, catch errors, and update the state', () => {
      rc.emit.onSecondCall().throws(new Error('Unable to apply config'))

      const list = [
        {
          path: 'datadog/42/ASM_FEATURES/confId/config',
          product: 'ASM_FEATURES',
          apply_state: 1,
          apply_error: '',
          file: { asm: { enabled: true } }
        },
        {
          path: 'datadog/42/ASM_DATA/confId/config',
          product: 'ASM_DATA',
          apply_state: 1,
          apply_error: '',
          file: { data: [1, 2, 3] }
        },
        {
          path: 'datadog/42/ASM_DD/confId/config',
          product: 'ASM_DD',
          apply_state: 1,
          apply_error: '',
          file: { rules: [4, 5, 6] }
        }
      ]

      rc.dispatch(list, 'apply')

      expect(rc.emit).to.have.been.calledThrice
      expect(rc.emit.firstCall).to.have.been.calledWithExactly('ASM_FEATURES', 'apply', { asm: { enabled: true } })
      expect(rc.emit.secondCall).to.have.been.calledWithExactly('ASM_DATA', 'apply', { data: [1, 2, 3] })
      expect(rc.emit.thirdCall).to.have.been.calledWithExactly('ASM_DD', 'apply', { rules: [4, 5, 6] })

      expect(list[0].apply_state).to.equal(2)
      expect(list[0].apply_error).to.equal('')
      expect(list[1].apply_state).to.equal(3)
      expect(list[1].apply_error).to.equal('Error: Unable to apply config')
      expect(list[2].apply_state).to.equal(2)
      expect(list[2].apply_error).to.equal('')

      expect(rc.appliedConfigs.get('datadog/42/ASM_FEATURES/confId/config')).to.equal(list[0])
      expect(rc.appliedConfigs.get('datadog/42/ASM_DATA/confId/config')).to.equal(list[1])
      expect(rc.appliedConfigs.get('datadog/42/ASM_DD/confId/config')).to.equal(list[2])
    })

    it('should delete config from state when action is unapply', () => {
      rc.appliedConfigs.set('datadog/42/ASM_FEATURES/confId/config', {
        path: 'datadog/42/ASM_FEATURES/confId/config',
        product: 'ASM_FEATURES',
        apply_state: 2,
        apply_error: '',
        file: { asm: { enabled: true } }
      })

      rc.dispatch([rc.appliedConfigs.get('datadog/42/ASM_FEATURES/confId/config')], 'unapply')

      expect(rc.emit).to.have.been.calledOnceWithExactly('ASM_FEATURES', 'unapply', { asm: { enabled: true } })
      expect(rc.appliedConfigs).to.be.empty
    })
  })
})

function toBase64 (data) {
  return Buffer.from(JSON.stringify(data), 'utf8').toString('base64')
}
