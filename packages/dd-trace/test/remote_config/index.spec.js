'use strict'

const assert = require('node:assert/strict')
const { inspect } = require('node:util')

const { describe, it, beforeEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')
const { channel } = require('dc-polyfill')

require('../setup/core')
const Capabilities = require('../../src/remote_config/capabilities')
const { UNACKNOWLEDGED, ACKNOWLEDGED, ERROR } = require('../../src/remote_config/apply_states')

const noop = () => {}

describe('RemoteConfig', () => {
  let uuid
  let scheduler
  let Scheduler
  let RemoteConfigFetcher
  let setStorage
  let storage
  let storageRun
  let fetcher
  let request
  let log
  let extraServices
  let RemoteConfig
  let config
  let rc
  let tagger
  let getGitMetadata
  let getHostname

  before(() => {
    require('../../src/process-tags').initialize()
  })

  beforeEach(() => {
    uuid = sinon.stub().returns('1234-5678')

    scheduler = {
      start: sinon.spy(),
      stop: sinon.spy(),
    }

    Scheduler = sinon.stub().returns(scheduler)

    fetcher = {
      fetchChanges: sinon.stub().resolves([]),
      setConfigState: sinon.stub(),
      setExtraServices: sinon.stub(),
      setProductCapabilities: sinon.stub().returns([]),
    }
    RemoteConfigFetcher = sinon.stub().returns(fetcher)
    setStorage = sinon.stub()
    storageRun = sinon.stub().callsFake((_store, callback) => callback())
    storage = sinon.stub().returns({ run: storageRun })

    request = sinon.stub()

    log = {
      error: sinon.spy(),
      errorWithoutTelemetry: sinon.spy(),
    }

    tagger = {
      add: sinon.stub(),
    }

    extraServices = []

    getGitMetadata = sinon.stub().returns({ commitSHA: undefined, repositoryUrl: undefined })
    getHostname = sinon.stub().returns('application-host')

    RemoteConfig = proxyquire('../../src/remote_config', {
      'node:os': { hostname: getHostname },
      '../../../datadog-core': { storage },
      '@datadog/libdatadog/remote-config': { RemoteConfigFetcher, setStorage, '@noCallThru': true },
      '../../../../vendor/dist/crypto-randomuuid': uuid,
      './scheduler': Scheduler,
      '../../../../package.json': { version: '3.0.0' },
      '../exporters/common/request': request,
      '../log': log,
      '../tagger': tagger,
      '../git_metadata': getGitMetadata,
      '../service-naming/extra-services': {
        getExtraServices: () => extraServices,
      },
    })

    config = {
      DD_AGENTLESS_ENABLED: false,
      DD_API_KEY: 'api-key',
      url: new URL('http://127.0.0.1:1337'),
      hostname: 'host',
      site: 'datadoghq.com',
      tags: {
        'runtime-id': 'runtimeId',
      },
      service: 'serviceName',
      env: 'serviceEnv',
      version: 'appVersion',
      remoteConfig: {
        pollInterval: 5,
      },
    }

    rc = new RemoteConfig(config)
  })

  function poll () {
    return new Promise(resolve => rc.poll(resolve))
  }

  it('should instantiate RemoteConfig', () => {
    sinon.stub(rc, 'poll')

    sinon.assert.calledOnce(Scheduler)
    const [firstArg, secondArg] = Scheduler.firstCall.args
    assert.strictEqual(typeof firstArg, 'function')
    assert.strictEqual(secondArg, 5e3)

    firstArg(noop)
    sinon.assert.calledOnceWithExactly(rc.poll, noop)

    assert.strictEqual(rc.scheduler, scheduler)

    assert.strictEqual(rc.url.toString(), 'http://127.0.0.1:1337/')

    sinon.assert.calledOnceWithExactly(tagger.add, config.tags, {
      '_dd.rc.client_id': '1234-5678',
    })

    assert.deepStrictEqual(rc.state, {
      client: {
        state: {
          root_version: 1,
          targets_version: 0,
          config_states: [],
          has_error: false,
          error: '',
          backend_client_state: '',
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
          tags: ['runtime-id:runtimeId'],
          process_tags: rc.state.client.client_tracer.process_tags,
        },
        capabilities: 'AA==',
      },
      cached_target_files: [],
    })

    assert.ok(rc.appliedConfigs instanceof Map)
    sinon.assert.notCalled(RemoteConfigFetcher)
    sinon.assert.notCalled(setStorage)
  })

  describe('agentless', () => {
    beforeEach(() => {
      config.DD_AGENTLESS_ENABLED = true
      rc = new RemoteConfig(config)
    })

    it('should configure the native client before polling', async () => {
      RemoteConfigFetcher.resetHistory()
      setStorage.resetHistory()
      storage.resetHistory()
      storageRun.resetHistory()
      config.env = undefined
      config.version = undefined
      rc = new RemoteConfig(config)
      rc.updateCapabilities(Capabilities.APM_TRACING_ENABLE_DYNAMIC_INSTRUMENTATION, true)
      rc.setProductHandler('LIVE_DEBUGGING', noop)
      extraServices.push('extra-service')
      fetcher.setProductCapabilities.returns(['UNKNOWN'])

      await poll()

      const options = RemoteConfigFetcher.lastCall.firstArg
      assert.strictEqual(options.clientId, '1234-5678')
      assert.strictEqual(options.runtimeId, 'runtimeId')
      assert.strictEqual(options.env, '')
      assert.strictEqual(options.appVersion, '')
      assert.strictEqual(options.url, 'https://datadoghq.com')
      assert.strictEqual(options.timeoutMs, 5000)
      assert.strictEqual(options.apiKey, 'api-key')
      assert.strictEqual(options.hostname, 'application-host')
      sinon.assert.calledOnceWithExactly(
        fetcher.setProductCapabilities,
        ['LIVE_DEBUGGING'],
        ['APM_TRACING_ENABLE_DYNAMIC_INSTRUMENTATION']
      )
      sinon.assert.calledOnceWithExactly(fetcher.setExtraServices, ['extra-service'])
      sinon.assert.calledOnce(fetcher.fetchChanges)
      sinon.assert.calledOnceWithExactly(
        log.error,
        '[RC] Unrecognized remote config products or capabilities: %s',
        'UNKNOWN'
      )

      sinon.assert.calledOnceWithExactly(setStorage, sinon.match.func)
      const runWithoutTracing = setStorage.firstCall.firstArg
      const callback = sinon.spy()
      runWithoutTracing(callback)
      sinon.assert.calledOnceWithExactly(storage, 'legacy')
      sinon.assert.calledOnceWithExactly(storageRun, { noop: true }, callback)
    })

    it('should apply, modify, and remove configs through the registered handler', async () => {
      const acknowledgements = []
      const handler = sinon.spy((action, file, id, acknowledge) => acknowledgements.push(acknowledge))
      rc.setProductHandler('LIVE_DEBUGGING', handler)
      const path = 'datadog/42/LIVE_DEBUGGING/probe/config'
      fetcher.fetchChanges.resolves([{
        kind: 'add',
        path,
        product: 'LIVE_DEBUGGING',
        configId: 'probe',
        version: 1,
        contents: '{"id":"probe","version":1}',
      }])

      await poll()

      sinon.assert.calledOnceWithExactly(handler, 'apply', { id: 'probe', version: 1 }, 'probe', sinon.match.func)
      sinon.assert.calledWithExactly(fetcher.setConfigState, path, UNACKNOWLEDGED, '')

      fetcher.fetchChanges.resolves([{
        kind: 'update',
        path,
        product: 'LIVE_DEBUGGING',
        configId: 'probe',
        version: 2,
        contents: '{"id":"probe","version":2}',
      }])
      await poll()

      sinon.assert.calledWithExactly(handler, 'modify', { id: 'probe', version: 2 }, 'probe', sinon.match.func)
      fetcher.setConfigState.resetHistory()
      acknowledgements[0]()
      sinon.assert.notCalled(fetcher.setConfigState)
      acknowledgements[1]()
      sinon.assert.calledOnceWithExactly(fetcher.setConfigState, path, ACKNOWLEDGED, '')

      fetcher.fetchChanges.resolves([{
        kind: 'remove',
        path,
        product: 'LIVE_DEBUGGING',
        configId: 'probe',
        version: 2,
      }])
      await poll()

      sinon.assert.calledWithExactly(handler, 'unapply', { id: 'probe', version: 2 }, 'probe', sinon.match.func)
      assert.strictEqual(rc.appliedConfigs.size, 0)
    })

    it('should report delayed unapply outcomes unless the config was replaced', async () => {
      const removedPath = 'datadog/42/LIVE_DEBUGGING/removed/config'
      const replacedPath = 'datadog/42/LIVE_DEBUGGING/replaced/config'
      const acknowledgements = []
      rc.setProductHandler('LIVE_DEBUGGING', (action, file, id, acknowledge) => {
        acknowledgements.push(acknowledge)
      })
      for (const [path, id] of [[removedPath, 'removed'], [replacedPath, 'replaced']]) {
        rc.appliedConfigs.set(path, {
          path,
          product: 'LIVE_DEBUGGING',
          id,
          version: 1,
          apply_state: ACKNOWLEDGED,
          apply_error: '',
          file: { id, version: 1 },
        })
      }
      fetcher.fetchChanges.resolves([
        { kind: 'remove', path: removedPath, product: 'LIVE_DEBUGGING', configId: 'removed', version: 1 },
        { kind: 'remove', path: replacedPath, product: 'LIVE_DEBUGGING', configId: 'replaced', version: 1 },
      ])

      await poll()

      fetcher.fetchChanges.resolves([{
        kind: 'add',
        path: replacedPath,
        product: 'LIVE_DEBUGGING',
        configId: 'replaced',
        version: 2,
        contents: '{"id":"replaced","version":2}',
      }])
      await poll()

      fetcher.setConfigState.resetHistory()
      acknowledgements[0]()
      acknowledgements[1]()

      sinon.assert.calledOnceWithExactly(fetcher.setConfigState, removedPath, ACKNOWLEDGED, '')
      assert.strictEqual(rc.appliedConfigs.get(replacedPath).version, 2)
    })

    it('should report invalid config contents without dispatching them', async () => {
      const handler = sinon.spy()
      rc.setProductHandler('LIVE_DEBUGGING', handler)
      const path = 'datadog/42/LIVE_DEBUGGING/probe/config'
      fetcher.fetchChanges.resolves([{
        kind: 'add',
        path,
        product: 'LIVE_DEBUGGING',
        configId: 'probe',
        version: 1,
        contents: '{invalid',
      }])

      await poll()

      sinon.assert.notCalled(handler)
      sinon.assert.calledOnceWithExactly(fetcher.setConfigState, path, ERROR, sinon.match.string)
      assert.strictEqual(rc.appliedConfigs.size, 0)

      fetcher.setConfigState.resetHistory()
      fetcher.fetchChanges.resolves([{
        kind: 'remove',
        path,
        product: 'LIVE_DEBUGGING',
        configId: 'probe',
        version: 1,
      }])
      await poll()

      sinon.assert.notCalled(fetcher.setConfigState)
      sinon.assert.notCalled(handler)
    })

    it('should dispatch one change per path', async () => {
      const handler = sinon.spy()
      rc.setProductHandler('LIVE_DEBUGGING', handler)
      const change = {
        kind: 'add',
        path: 'datadog/42/LIVE_DEBUGGING/probe/config',
        product: 'LIVE_DEBUGGING',
        configId: 'probe',
        version: 1,
        contents: '',
      }
      fetcher.fetchChanges.resolves([change, { ...change, kind: 'update' }])

      await poll()

      sinon.assert.calledOnceWithExactly(handler, 'apply', null, 'probe')
    })

    it('should report batch-handler outcomes to the native client', async () => {
      const path = 'datadog/42/ASM_FEATURES/config/config'
      const unrelatedHandler = sinon.spy()
      rc.setBatchHandler(['ASM_FEATURES'], transaction => transaction.ack(path))
      rc.setBatchHandler(['ASM_DATA'], unrelatedHandler)
      rc.subscribeProducts('ASM_FEATURES')
      fetcher.fetchChanges.resolves([{
        kind: 'add',
        path,
        product: 'ASM_FEATURES',
        configId: 'config',
        version: 1,
        contents: '{}',
      }])

      await poll()

      sinon.assert.calledOnceWithExactly(fetcher.setConfigState, path, ACKNOWLEDGED, '')
      sinon.assert.notCalled(unrelatedHandler)
      assert.strictEqual(rc.appliedConfigs.get(path).apply_state, ACKNOWLEDGED)
    })

    it('should stop when the API key is missing', () => {
      config.DD_API_KEY = undefined
      RemoteConfigFetcher.resetHistory()
      setStorage.resetHistory()
      scheduler.start.resetHistory()
      log.error.resetHistory()

      rc = new RemoteConfig(config)
      rc.setProductHandler('LIVE_DEBUGGING', noop)

      sinon.assert.notCalled(RemoteConfigFetcher)
      sinon.assert.notCalled(setStorage)
      sinon.assert.notCalled(scheduler.start)
      sinon.assert.calledOnceWithExactly(
        log.error,
        '[RC] DD_API_KEY is required for agentless Remote Config; Remote Config is disabled'
      )
    })

    it('should stop when the site is invalid', () => {
      config.site = 'datadoghq.com@evil.example'
      RemoteConfigFetcher.resetHistory()
      setStorage.resetHistory()
      scheduler.start.resetHistory()
      log.error.resetHistory()

      rc = new RemoteConfig(config)
      rc.setProductHandler('LIVE_DEBUGGING', noop)

      sinon.assert.notCalled(RemoteConfigFetcher)
      sinon.assert.notCalled(setStorage)
      sinon.assert.notCalled(scheduler.start)
      sinon.assert.calledOnceWithExactly(
        log.error,
        '[RC] Invalid DD_SITE for agentless Remote Config: %s; Remote Config is disabled',
        config.site
      )
    })

    it('should continue polling after native client failures', async () => {
      const error = new Error('request failed')
      rc.setProductHandler('LIVE_DEBUGGING', noop)
      fetcher.fetchChanges.rejects(error)

      await poll()

      sinon.assert.calledOnceWithExactly(log.errorWithoutTelemetry, '[RC] Error in request', error)
    })
  })

  it('should include process_tags in client_tracer', () => {
    const clientTracer = rc.state.client.client_tracer

    assert.ok(clientTracer.process_tags, 'process_tags should exist')
    assert.ok(Array.isArray(clientTracer.process_tags), 'process_tags should be an array')

    // Verify expected process tag keys are present
    assert.ok(
      clientTracer.process_tags.some(tag => tag.startsWith('entrypoint.basedir:')),
      `Got: ${inspect(clientTracer.process_tags)}`
    )
    assert.ok(
      clientTracer.process_tags.some(tag => tag.startsWith('entrypoint.name:')),
      `Got: ${inspect(clientTracer.process_tags)}`
    )
    assert.ok(
      clientTracer.process_tags.some(tag => tag.startsWith('entrypoint.type:')),
      `Got: ${inspect(clientTracer.process_tags)}`
    )
    assert.ok(
      clientTracer.process_tags.some(tag => tag.startsWith('entrypoint.workdir:')),
      `Got: ${inspect(clientTracer.process_tags)}`
    )

    // Verify entrypoint.type has expected value
    assert.ok(
      clientTracer.process_tags.some(tag => tag === 'entrypoint.type:script'),
      `Got: ${inspect(clientTracer.process_tags)}`
    )
  })

  it('should add git metadata to tags if present', () => {
    getGitMetadata.returns({
      commitSHA: '1234567890',
      repositoryUrl: 'https://github.com/DataDog/dd-trace-js',
    })
    const rc = new RemoteConfig(config)
    assert.deepStrictEqual(rc.state.client.client_tracer.tags, [
      'runtime-id:runtimeId',
      'git.repository_url:https://github.com/DataDog/dd-trace-js',
      'git.commit.sha:1234567890',
    ])
  })

  describe('updateCapabilities', () => {
    it('should set multiple capabilities to true', () => {
      rc.updateCapabilities(Capabilities.ASM_ACTIVATION, true)
      assert.strictEqual(rc.state.client.capabilities, 'Ag==')

      rc.updateCapabilities(Capabilities.ASM_IP_BLOCKING, true)
      assert.strictEqual(rc.state.client.capabilities, 'Bg==')

      rc.updateCapabilities(Capabilities.ASM_DD_RULES, true)
      assert.strictEqual(rc.state.client.capabilities, 'Dg==')

      rc.updateCapabilities(Capabilities.ASM_USER_BLOCKING, true)
      assert.strictEqual(rc.state.client.capabilities, 'jg==')
    })

    it('should set multiple capabilities to false', () => {
      rc.updateCapabilities(Capabilities.ASM_ACTIVATION, true)
      rc.updateCapabilities(Capabilities.ASM_IP_BLOCKING, true)
      rc.updateCapabilities(Capabilities.ASM_DD_RULES, true)
      rc.updateCapabilities(Capabilities.ASM_USER_BLOCKING, true)

      rc.updateCapabilities(Capabilities.ASM_USER_BLOCKING, false)
      assert.strictEqual(rc.state.client.capabilities, 'Dg==')

      rc.updateCapabilities(Capabilities.ASM_ACTIVATION, false)
      assert.strictEqual(rc.state.client.capabilities, 'DA==')

      rc.updateCapabilities(Capabilities.ASM_IP_BLOCKING, false)
      assert.strictEqual(rc.state.client.capabilities, 'CA==')

      rc.updateCapabilities(Capabilities.ASM_DD_RULES, false)
      assert.strictEqual(rc.state.client.capabilities, 'AA==')
    })

    it('should set an arbitrary amount of capabilities', () => {
      rc.updateCapabilities(1n << 1n, true)
      rc.updateCapabilities(1n << 200n, true)
      assert.strictEqual(rc.state.client.capabilities, 'AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAI=')

      rc.updateCapabilities(1n << 200n, false)
      assert.strictEqual(rc.state.client.capabilities, 'Ag==')
    })
  })

  describe('setProductHandler/removeProductHandler', () => {
    it('should update the product list and autostart or autostop', () => {
      sinon.assert.notCalled(rc.scheduler.start)

      rc.setProductHandler('ASM_FEATURES', noop)

      assert.deepStrictEqual(rc.state.client.products, ['ASM_FEATURES'])
      sinon.assert.called(rc.scheduler.start)

      rc.setProductHandler('ASM_DATA', noop)
      rc.setProductHandler('ASM_DD', noop)

      assert.deepStrictEqual(rc.state.client.products, ['ASM_FEATURES', 'ASM_DATA', 'ASM_DD'])

      rc.removeProductHandler('ASM_FEATURES')

      assert.deepStrictEqual(rc.state.client.products, ['ASM_DATA', 'ASM_DD'])

      rc.removeProductHandler('ASM_DATA')

      sinon.assert.notCalled(rc.scheduler.stop)

      rc.removeProductHandler('ASM_DD')

      sinon.assert.called(rc.scheduler.stop)
      assert.strictEqual(rc.state.client.products.length, 0)
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
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      }
    })

    it('should request and do nothing when received status 404', (cb) => {
      request.yieldsRight(new Error('Response received 404'), '{"a":"b"}', 404)

      const payload = JSON.stringify(rc.state)

      rc.poll(() => {
        sinon.assert.calledOnceWithMatch(request, payload, expectedPayload)
        sinon.assert.notCalled(log.error)
        sinon.assert.notCalled(rc.parseConfig)
        cb()
      })
    })

    it('should request when received error', (cb) => {
      const err = new Error('Response received 500')
      request.yieldsRight(err, '{"a":"b"}', 500)

      const payload = JSON.stringify(rc.state)

      rc.poll(() => {
        sinon.assert.calledOnceWithMatch(request, payload, expectedPayload)
        sinon.assert.notCalled(rc.parseConfig)
        cb()
      })
    })

    it('should request and call parseConfig when payload is not empty', (cb) => {
      request.yieldsRight(null, '{"a":"b"}', 200)

      const payload = JSON.stringify(rc.state)

      rc.poll(() => {
        sinon.assert.calledOnceWithMatch(request, payload, expectedPayload)
        sinon.assert.notCalled(log.error)
        sinon.assert.calledOnceWithExactly(rc.parseConfig, { a: 'b' })
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
        sinon.assert.calledOnceWithMatch(request, payload, expectedPayload)
        sinon.assert.calledOnceWithExactly(rc.parseConfig, { a: 'b' })
        sinon.assert.calledOnceWithExactly(log.error, '[RC] Could not parse remote config response', error)
        assert.strictEqual(rc.state.client.state.has_error, true)
        assert.strictEqual(rc.state.client.state.error, 'Error: Unable to parse config')

        const payload2 = JSON.stringify(rc.state)

        rc.poll(() => {
          sinon.assert.calledTwice(request)
          sinon.assert.calledWith(request.secondCall, payload2, expectedPayload)
          sinon.assert.calledOnce(rc.parseConfig)
          sinon.assert.calledOnce(log.error)
          assert.strictEqual(rc.state.client.state.has_error, false)
          assert.strictEqual(rc.state.client.state.error.length, 0)
          cb()
        })
      })
    })

    it('should request and do nothing when payload is empty JSON object', (cb) => {
      request.yieldsRight(null, '{}', 200)

      const payload = JSON.stringify(rc.state)

      rc.poll(() => {
        sinon.assert.calledOnceWithMatch(request, payload, expectedPayload)
        sinon.assert.notCalled(log.error)
        sinon.assert.notCalled(rc.parseConfig)
        cb()
      })
    })

    it('should include extra_services in the payload', (cb) => {
      request.yieldsRight(null, '{}', 200)

      extraServices = ['test-service']

      // getPayload includes the new extraServices that might be available
      const payload = rc.getPayload()
      assert.deepStrictEqual(JSON.parse(payload).client.client_tracer.extra_services, extraServices)

      rc.poll(() => {
        sinon.assert.calledOnceWithMatch(request, payload, expectedPayload)
        cb()
      })
    })
  })

  describe('parseConfig', () => {
    let payload
    const parsePayload = () => rc.parseConfig(payload)
    let previousState

    beforeEach(() => {
      sinon.stub(rc, 'dispatch').callsFake((list, action) => {
        const items = /** @type {Array<{path: string, apply_state: number}>} */ (list)
        for (const item of items) {
          item.apply_state = ACKNOWLEDGED

          if (action === 'unapply') rc.appliedConfigs.delete(item.path)
          else rc.appliedConfigs.set(item.path, item)
        }
      })

      previousState = JSON.parse(JSON.stringify(rc.state))
    })

    it('should do nothing if passed an empty payload', () => {
      payload = {}
      parsePayload()
      sinon.assert.notCalled(rc.dispatch)
      assert.deepStrictEqual(rc.state, previousState)
    })

    it('should throw when target is not found', () => {
      payload = {
        client_configs: ['datadog/42/PRODUCT/confId/config'],
        targets: toBase64({
          signed: {
            targets: {
              'datadog/42/OTHERPRODUCT/confId/config': {},
            },
          },
        }),
      }

      assert.throws(parsePayload, { message: 'Unable to find target for path datadog/42/PRODUCT/confId/config' })
      sinon.assert.notCalled(rc.dispatch)
      assert.deepStrictEqual(rc.state, previousState)
    })

    it('should throw when target file is not found', () => {
      payload = {
        client_configs: ['datadog/42/PRODUCT/confId/config'],
        targets: toBase64({
          signed: {
            targets: {
              'datadog/42/PRODUCT/confId/config': {
                hashes: {
                  sha256: 'haaaxx',
                },
              },
            },
          },
        }),
      }

      assert.throws(parsePayload, { message: 'Unable to find file for path datadog/42/PRODUCT/confId/config' })
      sinon.assert.notCalled(rc.dispatch)
      assert.deepStrictEqual(rc.state, previousState)
    })

    it('should throw when a target file contains invalid JSON', () => {
      const path = 'datadog/42/PRODUCT/confId/config'
      payload = {
        client_configs: [path],
        targets: toBase64({
          signed: {
            custom: { opaque_backend_state: 'state' },
            targets: {
              [path]: {
                custom: { v: 1 },
                hashes: { sha256: 'haaaxx' },
              },
            },
            version: 1,
          },
        }),
        target_files: [{
          path,
          raw: Buffer.from('{invalid').toString('base64'),
        }],
      }

      assert.throws(parsePayload, SyntaxError)
      sinon.assert.notCalled(rc.dispatch)
      assert.deepStrictEqual(rc.state, previousState)
    })

    it('should throw when config path cannot be parsed', () => {
      payload = {
        client_configs: ['datadog/42/confId/config'],
        targets: toBase64({
          signed: {
            targets: {
              'datadog/42/confId/config': {
                hashes: {
                  sha256: 'haaaxx',
                },
              },
            },
          },
        }),
        target_files: [{
          path: 'datadog/42/confId/config',
          raw: toBase64({}),
        }],
      }

      assert.throws(parsePayload, { message: 'Unable to parse path datadog/42/confId/config' })
      sinon.assert.notCalled(rc.dispatch)
      assert.deepStrictEqual(rc.state, previousState)
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
        file: { asm: { enabled: true } },
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
        file: {},
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
        file: { config: 'oldConf' },
      })

      payload = {
        client_configs: [
          'datadog/42/IGNORE/confId/config',
          'datadog/42/MODIFY/confId/config',
          'datadog/42/APPLY/confId/config',
        ],
        targets: toBase64({
          signed: {
            custom: {
              opaque_backend_state: 'opaquestateinbase64',
            },
            targets: {
              'datadog/42/IGNORE/confId/config': {
                custom: {
                  v: 43,
                },
                hashes: {
                  sha256: 'sameHash',
                },
                length: 420,
              },
              'datadog/42/MODIFY/confId/config': {
                custom: {
                  v: 12,
                },
                hashes: {
                  sha256: 'newHash',
                },
                length: 147,
              },
              'datadog/42/APPLY/confId/config': {
                custom: {
                  v: 1,
                },
                hashes: {
                  sha256: 'haaaxx',
                },
                length: 0,
              },
            },
            version: 12345,
          },
        }),
        target_files: [
          {
            path: 'datadog/42/MODIFY/confId/config',
            raw: toBase64({ config: 'newConf' }),
          },
          {
            path: 'datadog/42/APPLY/confId/config',
            raw: '',
          },
        ],
      }

      // Calling parsePayload should not throw.
      parsePayload()

      assert.strictEqual(rc.state.client.state.targets_version, 12345)
      assert.strictEqual(rc.state.client.state.backend_client_state, 'opaquestateinbase64')

      sinon.assert.calledThrice(rc.dispatch)
      sinon.assert.calledWithMatch(rc.dispatch.firstCall, [{
        path: 'datadog/42/UNAPPLY/confId/config',
        product: 'UNAPPLY',
        id: 'confId',
        version: 69,
        apply_state: ACKNOWLEDGED,
        apply_error: '',
        length: 147,
        hashes: { sha256: 'anotherHash' },
        file: { asm: { enabled: true } },
      }], 'unapply', sinon.match.instanceOf(Map))
      sinon.assert.calledWithMatch(rc.dispatch.secondCall, [{
        path: 'datadog/42/APPLY/confId/config',
        product: 'APPLY',
        id: 'confId',
        version: 1,
        apply_state: ACKNOWLEDGED,
        apply_error: '',
        length: 0,
        hashes: { sha256: 'haaaxx' },
        file: null,
      }], 'apply', sinon.match.instanceOf(Map))
      sinon.assert.calledWithMatch(rc.dispatch.thirdCall, [{
        path: 'datadog/42/MODIFY/confId/config',
        product: 'MODIFY',
        id: 'confId',
        version: 12,
        apply_state: ACKNOWLEDGED,
        apply_error: '',
        length: 147,
        hashes: { sha256: 'newHash' },
        file: { config: 'newConf' },
      }], 'modify', sinon.match.instanceOf(Map))

      assert.deepStrictEqual(rc.state.client.state.config_states, [
        {
          id: 'confId',
          version: 43,
          product: 'IGNORE',
          apply_state: ACKNOWLEDGED,
          apply_error: '',
        },
        {
          id: 'confId',
          version: 12,
          product: 'MODIFY',
          apply_state: ACKNOWLEDGED,
          apply_error: '',
        },
        {
          id: 'confId',
          version: 1,
          product: 'APPLY',
          apply_state: ACKNOWLEDGED,
          apply_error: '',
        },
      ])
      assert.deepStrictEqual(rc.state.cached_target_files, [
        {
          path: 'datadog/42/IGNORE/confId/config',
          length: 420,
          hashes: [{ algorithm: 'sha256', hash: 'sameHash' }],
        },
        {
          path: 'datadog/42/MODIFY/confId/config',
          length: 147,
          hashes: [{ algorithm: 'sha256', hash: 'newHash' }],
        },
        {
          path: 'datadog/42/APPLY/confId/config',
          length: 0,
          hashes: [{ algorithm: 'sha256', hash: 'haaaxx' }],
        },
      ])
    })

    it('should allow batch handlers to ack + handle items and skip per-product handlers (including unapply)', () => {
      // Arrange: two configs already applied, one will be unapplied.
      const unapplyPath = 'datadog/42/ASM/confId/config'
      rc.appliedConfigs.set(unapplyPath, {
        path: unapplyPath,
        product: 'ASM',
        id: 'confId',
        version: 1,
        apply_state: ACKNOWLEDGED,
        apply_error: '',
        length: 1,
        hashes: { sha256: 'oldHash' },
        file: { a: 1 },
      })

      const handler = sinon.spy()
      rc.setProductHandler('ASM', handler)

      // Batch hook will handle the unapply and report success.
      rc.setBatchHandler(['ASM'], (transaction) => {
        for (const item of transaction.toUnapply) {
          transaction.ack(item.path)
        }
      })

      payload = {
        client_configs: [],
        targets: toBase64({
          signed: {
            custom: { opaque_backend_state: 'state' },
            targets: {},
            version: 2,
          },
        }),
        target_files: [],
      }

      // Act
      parsePayload()

      // Assert: handler should not be invoked, but state should be updated (unapplied).
      sinon.assert.notCalled(handler)
      assert.strictEqual(rc.appliedConfigs.has(unapplyPath), false)
    })

    it('should call per-product handlers when batch handlers do not ack/error (including unapply)', () => {
      const unapplyPath = 'datadog/42/ASM/confId/config'
      const conf = {
        path: unapplyPath,
        product: 'ASM',
        id: 'confId',
        version: 1,
        apply_state: ACKNOWLEDGED,
        apply_error: '',
        length: 1,
        hashes: { sha256: 'oldHash' },
        file: { a: 1 },
      }
      rc.appliedConfigs.set(unapplyPath, conf)

      const handler = sinon.spy()
      rc.setProductHandler('ASM', handler)

      // Batch hook does nothing (does not ack/error), so per-product handler should run.
      rc.setBatchHandler(['ASM'], () => {})

      // This test needs the real dispatch path in order to verify handler invocation.
      rc.dispatch.restore()

      payload = {
        client_configs: [],
        targets: toBase64({
          signed: {
            custom: { opaque_backend_state: 'state' },
            targets: {},
            version: 2,
          },
        }),
        target_files: [],
      }

      parsePayload()

      sinon.assert.calledOnceWithExactly(handler, 'unapply', conf.file, conf.id)
      assert.strictEqual(rc.appliedConfigs.has(unapplyPath), false)
    })
  })

  describe('dispatch', () => {
    it('should call registered handler for each config, catch errors, and update the state', (done) => {
      const syncGoodNonAckHandler = sinon.spy()
      const syncBadNonAckHandler = sinon.spy((action, conf, id) => { throw new Error('sync fn') })
      const asyncGoodHandler = sinon.spy(async (action, conf, id) => {})
      const asyncBadHandler = sinon.spy(async (action, conf, id) => { throw new Error('async fn') })
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
          file: { index: i },
        }
      }

      rc.dispatch(list, 'apply', new Map())

      sinon.assert.calledOnceWithExactly(syncGoodNonAckHandler, 'apply', list[0].file, list[0].id)
      sinon.assert.calledOnceWithExactly(syncBadNonAckHandler, 'apply', list[1].file, list[1].id)
      sinon.assert.calledOnceWithExactly(asyncGoodHandler, 'apply', list[2].file, list[2].id)
      sinon.assert.calledOnceWithExactly(asyncBadHandler, 'apply', list[3].file, list[3].id)
      assertAsyncHandlerCallArguments(syncGoodAckHandler, 'apply', list[4].file, list[4].id)
      assertAsyncHandlerCallArguments(syncBadAckHandler, 'apply', list[5].file, list[5].id)
      assertAsyncHandlerCallArguments(asyncGoodAckHandler, 'apply', list[6].file, list[6].id)
      assertAsyncHandlerCallArguments(asyncBadAckHandler, 'apply', list[7].file, list[7].id)
      assertAsyncHandlerCallArguments(unackHandler, 'apply', list[8].file, list[8].id)

      assert.strictEqual(list[0].apply_state, ACKNOWLEDGED)
      assert.strictEqual(list[0].apply_error, '')
      assert.strictEqual(list[1].apply_state, ERROR)
      assert.strictEqual(list[1].apply_error, 'Error: sync fn')
      assert.strictEqual(list[2].apply_state, UNACKNOWLEDGED)
      assert.strictEqual(list[2].apply_error, '')
      assert.strictEqual(list[3].apply_state, UNACKNOWLEDGED)
      assert.strictEqual(list[3].apply_error, '')
      assert.strictEqual(list[4].apply_state, ACKNOWLEDGED)
      assert.strictEqual(list[4].apply_error, '')
      assert.strictEqual(list[5].apply_state, ERROR)
      assert.strictEqual(list[5].apply_error, 'Error: sync ack fn')
      assert.strictEqual(list[6].apply_state, UNACKNOWLEDGED)
      assert.strictEqual(list[6].apply_error, '')
      assert.strictEqual(list[7].apply_state, UNACKNOWLEDGED)
      assert.strictEqual(list[7].apply_error, '')
      assert.strictEqual(list[8].apply_state, UNACKNOWLEDGED)
      assert.strictEqual(list[8].apply_error, '')

      for (let i = 0; i < list.length; i++) {
        assert.strictEqual(rc.appliedConfigs.get(`datadog/42/PRODUCT_${i}/confId/config`), list[i])
      }

      setImmediate(() => {
        assert.strictEqual(list[2].apply_state, ACKNOWLEDGED)
        assert.strictEqual(list[2].apply_error, '')
        assert.strictEqual(list[3].apply_state, ERROR)
        assert.strictEqual(list[3].apply_error, 'Error: async fn')
        assert.strictEqual(list[6].apply_state, ACKNOWLEDGED)
        assert.strictEqual(list[6].apply_error, '')
        assert.strictEqual(list[7].apply_state, ERROR)
        assert.strictEqual(list[7].apply_error, 'Error: async ack fn')
        assert.strictEqual(list[8].apply_state, UNACKNOWLEDGED)
        assert.strictEqual(list[8].apply_error, '')
        done()
      })

      function assertAsyncHandlerCallArguments (handler, ...expectedArgs) {
        sinon.assert.calledOnceWithMatch(handler, ...expectedArgs)
        assert.strictEqual(handler.args[0].length, expectedArgs.length + 1)
        assert.strictEqual(typeof handler.args[0][handler.args[0].length - 1], 'function')
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
        file: { asm: { enabled: true } },
      })

      rc.dispatch([rc.appliedConfigs.get('datadog/42/ASM_FEATURES/confId/config')], 'unapply', new Map())

      sinon.assert.calledOnceWithExactly(handler, 'unapply', { asm: { enabled: true } }, 'asm_data')
      assert.strictEqual(rc.appliedConfigs.size, 0)
    })
  })

  describe('identity state refresh', () => {
    it('should replace state.client.id when identity is updated', () => {
      const originalId = rc.state.client.id

      uuid.returns('refreshed-client-id')
      channel('datadog:identity:update').publish(config)

      assert.strictEqual(rc.state.client.id, 'refreshed-client-id')
      assert.notStrictEqual(rc.state.client.id, originalId)
    })

    it('should replace client_tracer.runtime_id when identity is updated', () => {
      assert.strictEqual(rc.state.client.client_tracer.runtime_id, 'runtimeId')

      config.tags['runtime-id'] = 'refreshed-runtime-id'
      channel('datadog:identity:update').publish(config)

      assert.strictEqual(rc.state.client.client_tracer.runtime_id, 'refreshed-runtime-id')

      config.tags['runtime-id'] = 'runtimeId' // restore for other tests
    })

    it('should include refreshed runtime_id and id in the JSON payload', () => {
      uuid.returns('refreshed-client-id')
      config.tags['runtime-id'] = 'live-runtime-id'
      channel('datadog:identity:update').publish(config)
      const payload = JSON.parse(rc.getPayload())

      assert.strictEqual(payload.client.client_tracer.runtime_id, 'live-runtime-id')
      assert.strictEqual(payload.client.id, 'refreshed-client-id')

      config.tags['runtime-id'] = 'runtimeId'
    })

    it('should cache client_tracer.tags and only refresh it on datadog:identity:update', () => {
      const originalTags = rc.state.client.client_tracer.tags

      config.tags['new-tag'] = 'new-value'

      // unlike runtime_id, tags is a cached string, so a direct config mutation isn't picked up
      assert.strictEqual(rc.state.client.client_tracer.tags, originalTags)

      channel('datadog:identity:update').publish(config)

      assert.notStrictEqual(rc.state.client.client_tracer.tags, originalTags)
      assert.ok(rc.state.client.client_tracer.tags.includes('new-tag:new-value'))

      delete config.tags['new-tag']
    })
  })

  describe('refreshClientId', () => {
    let refreshIdentity
    let uuidStub
    let RemoteConfigWithId

    beforeEach(() => {
      uuidStub = sinon.stub()
      // first call is the module-load-time `let clientId = uuid()`, second is the refresh
      uuidStub.onFirstCall().returns('1234-5678')
      uuidStub.onSecondCall().returns('new-client-id-uuid')

      RemoteConfigWithId = proxyquire('../../src/remote_config', {
        'dc-polyfill': {
          channel: sinon.stub().returns({
            subscribe: (listener) => { refreshIdentity = listener },
          }),
        },
        '../../../../vendor/dist/crypto-randomuuid': uuidStub,
        './scheduler': Scheduler,
        '../../../../package.json': { version: '3.0.0' },
        '../exporters/common/request': request,
        '../log': log,
        '../tagger': tagger,
        '../git_metadata': getGitMetadata,
        '../service-naming/extra-services': {
          getExtraServices: () => extraServices,
        },
      })
    })

    it('should update state.client.id on the existing instance after refresh', () => {
      const rcInstance = new RemoteConfigWithId(config)
      assert.strictEqual(rcInstance.state.client.id, '1234-5678')

      refreshIdentity(config)

      assert.strictEqual(rcInstance.state.client.id, 'new-client-id-uuid')
    })

    it('should rebuild client_tracer.tags to reflect the refreshed _dd.rc.client_id', () => {
      const rcConfig = {
        url: new URL('http://127.0.0.1:1337'),
        tags: { 'runtime-id': 'runtimeId', '_dd.rc.client_id': 'old-client-id' },
        service: 'serviceName',
        env: 'serviceEnv',
        version: 'appVersion',
        remoteConfig: { pollInterval: 5 },
      }
      const rcInstance = new RemoteConfigWithId(rcConfig)
      assert.deepStrictEqual(rcInstance.state.client.client_tracer.tags, [
        'runtime-id:runtimeId',
        '_dd.rc.client_id:old-client-id',
      ])

      delete rcConfig.tags['_dd.rc.client_id']
      refreshIdentity(rcConfig)

      assert.strictEqual(rcConfig.tags['_dd.rc.client_id'], 'new-client-id-uuid')
      const refreshedTags = rcInstance.state.client.client_tracer.tags
      assert.deepStrictEqual(refreshedTags, [
        'runtime-id:runtimeId',
        '_dd.rc.client_id:new-client-id-uuid',
      ])
    })

    it('should set clientId to the value returned by uuid after a client exists', () => {
      const rcConfig = {
        url: new URL('http://127.0.0.1:1337'),
        tags: { 'runtime-id': 'runtimeId', '_dd.rc.client_id': 'old' },
        service: 'serviceName',
        env: 'serviceEnv',
        version: 'appVersion',
        remoteConfig: { pollInterval: 5 },
      }
      const rcInstance = new RemoteConfigWithId(rcConfig)
      assert.strictEqual(rcInstance.state.client.id, '1234-5678')

      refreshIdentity(rcConfig)

      assert.strictEqual(rcConfig.tags['_dd.rc.client_id'], 'new-client-id-uuid')
    })

    it('should not add config.tags[_dd.rc.client_id] before a client exists', () => {
      const rcConfig = {
        url: new URL('http://127.0.0.1:1337'),
        tags: { 'runtime-id': 'runtimeId' },
        service: 'serviceName',
        env: 'serviceEnv',
        version: 'appVersion',
        remoteConfig: { pollInterval: 5 },
      }
      refreshIdentity(rcConfig)

      assert.strictEqual(rcConfig.tags['_dd.rc.client_id'], undefined)
    })

    it('should call uuid again to generate the new ID', () => {
      refreshIdentity(config)

      // once at module load for the initial clientId, once on refresh
      sinon.assert.calledTwice(uuidStub)
      // the buffered pool is drained by the publisher, so the refresh must not opt out of it
      assert.deepStrictEqual(uuidStub.secondCall.args, [])
    })
  })
})

function toBase64 (data) {
  return Buffer.from(JSON.stringify(data), 'utf8').toString('base64')
}
