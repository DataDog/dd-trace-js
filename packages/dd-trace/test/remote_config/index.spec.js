'use strict'

const assert = require('node:assert/strict')
const { inspect } = require('node:util')

const { describe, it, before, beforeEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

require('../setup/core')
const Capabilities = require('../../src/remote_config/capabilities')
const { UNACKNOWLEDGED, ACKNOWLEDGED, ERROR } = require('../../src/remote_config/apply_states')

const noop = () => {}

describe('RemoteConfig', () => {
  let uuid
  let scheduler
  let Scheduler
  let fetcher
  let createFetcher
  let log
  let extraServices
  let RemoteConfig
  let config
  let rc
  let tagger
  let getGitMetadata
  let processTags

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
      fetchChanges: sinon.stub().yields(null, []),
      setConfigState: sinon.spy(),
      setExtraServices: sinon.spy(),
      setProductCapabilities: sinon.stub().returns([]),
    }

    createFetcher = sinon.stub().returns(fetcher)

    log = {
      error: sinon.spy(),
      errorWithoutTelemetry: sinon.spy(),
    }

    tagger = {
      add: sinon.stub(),
    }

    extraServices = []

    getGitMetadata = sinon.stub().returns({ commitSHA: undefined, repositoryUrl: undefined })
    processTags = {
      tagsArray: require('../../src/process-tags').tagsArray,
    }

    RemoteConfig = proxyquire('../../src/remote_config', {
      '../../../../vendor/dist/crypto-randomuuid': uuid,
      './scheduler': Scheduler,
      '../../../../package.json': { version: '3.0.0' },
      './fetcher': createFetcher,
      '../log': log,
      '../process-tags': processTags,
      '../tagger': tagger,
      '../git_metadata': getGitMetadata,
      '../service-naming/extra-services': {
        getExtraServices: () => extraServices,
      },
    })

    config = {
      url: new URL('http://127.0.0.1:1337'),
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

  /**
   * Runs one poll and resolves once the scheduler callback fired.
   */
  const poll = () => new Promise((resolve) => rc.poll(resolve))

  /**
   * @param {'add' | 'update' | 'remove'} kind
   * @param {string} product
   * @param {object} [options]
   * @param {unknown} [options.file]
   * @param {number} [options.version]
   * @param {string} [options.configId]
   */
  function change (kind, product, { file = {}, version = 1, configId = 'confId' } = {}) {
    return {
      kind,
      path: `datadog/42/${product}/${configId}/config`,
      product,
      configId,
      name: 'config',
      version,
      contents: kind === 'remove' ? undefined : JSON.stringify(file),
    }
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

    sinon.assert.calledOnceWithExactly(tagger.add, config.tags, {
      '_dd.rc.client_id': '1234-5678',
    })

    sinon.assert.calledOnceWithExactly(createFetcher, {
      clientId: '1234-5678',
      runtimeId: 'runtimeId',
      service: 'serviceName',
      env: 'serviceEnv',
      appVersion: 'appVersion',
      tags: ['runtime-id:runtimeId'],
      processTags: processTags.tagsArray,
      language: 'node',
      tracerVersion: '3.0.0',
      url: 'http://127.0.0.1:1337/',
      timeoutMs: 2000,
    })

    assert.ok(rc.appliedConfigs instanceof Map)
    assert.strictEqual(rc.appliedConfigs.size, 0)
  })

  it('should default an absent env and version to the empty string', () => {
    createFetcher.resetHistory()

    new RemoteConfig({ ...config, env: undefined, version: undefined }) // eslint-disable-line no-new

    const { env, appVersion } = createFetcher.firstCall.firstArg
    assert.strictEqual(env, '')
    assert.strictEqual(appVersion, '')
  })

  it('should default absent process tags to an empty array', () => {
    processTags.tagsArray = undefined
    createFetcher.resetHistory()

    new RemoteConfig(config) // eslint-disable-line no-new

    assert.deepStrictEqual(createFetcher.firstCall.firstArg.processTags, [])
  })

  it('should configure the agentless fetcher with the tracer client identity', () => {
    createFetcher.resetHistory()
    config.DD_AGENTLESS_ENABLED = true
    config.DD_API_KEY = 'api-key'
    config.hostname = 'host'
    config.site = 'us3.datadoghq.com'

    new RemoteConfig(config) // eslint-disable-line no-new

    const options = createFetcher.firstCall.firstArg
    assert.strictEqual(options.agentless, true)
    assert.strictEqual(options.apiKey, 'api-key')
    assert.strictEqual(options.clientId, '1234-5678')
    assert.strictEqual(options.hostname, 'host')
    assert.strictEqual(options.timeoutMs, 5000)
    assert.strictEqual(options.url, 'https://us3.datadoghq.com')
  })

  it('should include process_tags in the fetcher options', () => {
    const { processTags } = createFetcher.firstCall.firstArg

    assert.ok(Array.isArray(processTags), 'processTags should be an array')

    for (const prefix of ['entrypoint.basedir:', 'entrypoint.name:', 'entrypoint.type:', 'entrypoint.workdir:']) {
      assert.ok(processTags.some(tag => tag.startsWith(prefix)), `Got: ${inspect(processTags)}`)
    }

    assert.ok(processTags.includes('entrypoint.type:script'), `Got: ${inspect(processTags)}`)
  })

  it('should add git metadata to tags if present', () => {
    getGitMetadata.returns({
      commitSHA: '1234567890',
      repositoryUrl: 'https://github.com/DataDog/dd-trace-js',
    })

    createFetcher.resetHistory()

    new RemoteConfig(config) // eslint-disable-line no-new

    assert.deepStrictEqual(createFetcher.firstCall.firstArg.tags, [
      'runtime-id:runtimeId',
      'git.repository_url:https://github.com/DataDog/dd-trace-js',
      'git.commit.sha:1234567890',
    ])
  })

  it('should disable itself when no remote config client can be built', async () => {
    const error = new Error('no fetcher for you')
    createFetcher.throws(error)

    rc = new RemoteConfig(config)

    sinon.assert.calledOnceWithExactly(
      log.error,
      '[RC] Could not start the remote config client, remote config is disabled',
      error
    )

    rc.setProductHandler('ASM_FEATURES', noop)

    sinon.assert.notCalled(scheduler.start)

    // A poll triggered by hand must not throw either.
    await poll()
    sinon.assert.notCalled(fetcher.fetchChanges)
  })

  describe('updateCapabilities', () => {
    it('should send the enabled capabilities by name on the next poll', async () => {
      rc.updateCapabilities(Capabilities.ASM_ACTIVATION, true)
      rc.updateCapabilities(Capabilities.ASM_IP_BLOCKING, true)
      rc.subscribeProducts('ASM_FEATURES')

      await poll()

      sinon.assert.calledOnceWithExactly(
        fetcher.setProductCapabilities,
        ['ASM_FEATURES'],
        ['ASM_ACTIVATION', 'ASM_IP_BLOCKING']
      )
    })

    it('should remove disabled capabilities', async () => {
      rc.updateCapabilities(Capabilities.ASM_ACTIVATION, true)
      rc.updateCapabilities(Capabilities.ASM_IP_BLOCKING, true)
      rc.subscribeProducts('ASM_FEATURES')

      await poll()

      rc.updateCapabilities(Capabilities.ASM_ACTIVATION, false)

      await poll()

      sinon.assert.calledTwice(fetcher.setProductCapabilities)
      sinon.assert.calledWithExactly(
        fetcher.setProductCapabilities.secondCall,
        ['ASM_FEATURES'],
        ['ASM_IP_BLOCKING']
      )
    })

    it('should not resend an unchanged capability set', async () => {
      rc.subscribeProducts('ASM_FEATURES')

      await poll()
      sinon.assert.calledOnce(fetcher.setProductCapabilities)

      rc.updateCapabilities(Capabilities.ASM_ACTIVATION, false)

      await poll()
      sinon.assert.calledOnce(fetcher.setProductCapabilities)
    })

    it('should ignore capability masks that are not in capabilities.js', async () => {
      const unknown = 1n << 200n

      rc.updateCapabilities(unknown, true)
      rc.subscribeProducts('ASM_FEATURES')

      sinon.assert.calledOnceWithExactly(
        log.error,
        '[RC] Ignoring unknown remote config capability 0x%s',
        unknown.toString(16)
      )

      await poll()

      sinon.assert.calledOnceWithExactly(fetcher.setProductCapabilities, ['ASM_FEATURES'], [])
    })
  })

  describe('setProductHandler/removeProductHandler', () => {
    it('should update the product list and autostart or autostop', async () => {
      sinon.assert.notCalled(rc.scheduler.start)

      rc.setProductHandler('ASM_FEATURES', noop)

      sinon.assert.called(rc.scheduler.start)

      rc.setProductHandler('ASM_DATA', noop)
      rc.setProductHandler('ASM_DD', noop)

      await poll()

      sinon.assert.calledWithExactly(
        fetcher.setProductCapabilities,
        ['ASM_FEATURES', 'ASM_DATA', 'ASM_DD'],
        []
      )

      rc.removeProductHandler('ASM_FEATURES')

      await poll()

      sinon.assert.calledWithExactly(fetcher.setProductCapabilities.secondCall, ['ASM_DATA', 'ASM_DD'], [])

      rc.removeProductHandler('ASM_DATA')

      sinon.assert.notCalled(rc.scheduler.stop)

      rc.removeProductHandler('ASM_DD')

      sinon.assert.called(rc.scheduler.stop)
    })
  })

  describe('poll', () => {
    it('should report extra services on every poll', async () => {
      await poll()
      sinon.assert.calledOnceWithExactly(fetcher.setExtraServices, [])

      extraServices = ['test-service']

      await poll()
      sinon.assert.calledWithExactly(fetcher.setExtraServices.secondCall, ['test-service'])
    })

    it('should report the names the native client did not recognize', async () => {
      fetcher.setProductCapabilities.returns(['NOT_A_PRODUCT', 'NOT_A_CAPABILITY'])
      rc.subscribeProducts('NOT_A_PRODUCT')

      await poll()

      sinon.assert.calledOnceWithExactly(
        log.error,
        '[RC] Unrecognized remote config products or capabilities: %s',
        'NOT_A_PRODUCT, NOT_A_CAPABILITY'
      )
      sinon.assert.calledOnce(fetcher.fetchChanges)
    })

    it('should survive a client that rejects the subscription update', async () => {
      const error = new Error('Unknown remote config product')
      fetcher.setProductCapabilities.throws(error)
      rc.subscribeProducts('ASM')

      // A throw escaping `poll` would reach the scheduler's timer as an uncaught exception.
      await poll()

      sinon.assert.calledOnceWithExactly(log.error, '[RC] Could not update the remote config client', error)
      sinon.assert.notCalled(fetcher.fetchChanges)

      // The next poll must retry rather than silently drop the subscription.
      fetcher.setProductCapabilities.returns([])
      await poll()

      sinon.assert.calledWithExactly(fetcher.setProductCapabilities.secondCall, ['ASM'], [])
      sinon.assert.calledOnce(fetcher.fetchChanges)
    })

    it('should log request errors without failing the poll', async () => {
      const error = new Error('Response received 500')
      fetcher.fetchChanges.yields(error)

      await poll()

      sinon.assert.calledOnceWithExactly(log.errorWithoutTelemetry, '[RC] Error in request', error)
      sinon.assert.notCalled(log.error)
    })

    it('should catch request errors thrown before the fetch starts', async () => {
      const error = new Error('Could not start request')
      fetcher.fetchChanges.throws(error)

      await poll()

      sinon.assert.calledOnceWithExactly(log.errorWithoutTelemetry, '[RC] Error in request', error)
      sinon.assert.notCalled(log.error)
    })

    it('should catch errors thrown while applying an update', async () => {
      const error = new Error('batch handler blew up')
      rc.subscribeProducts('ASM')
      rc.setBatchHandler(['ASM'], () => { throw error })
      fetcher.fetchChanges.yields(null, [change('add', 'ASM')])

      await poll()

      sinon.assert.calledOnceWithExactly(log.error, '[RC] Could not apply remote config update', error)
    })
  })

  describe('applying changes', () => {
    beforeEach(() => {
      sinon.stub(rc, 'dispatch').callsFake((list, action) => {
        const items = /** @type {Array<{path: string, apply_state: number}>} */ (list)
        for (const item of items) {
          item.apply_state = ACKNOWLEDGED

          if (action === 'unapply') rc.appliedConfigs.delete(item.path)
          else rc.appliedConfigs.set(item.path, item)
        }
      })
    })

    it('should do nothing when there are no changes', async () => {
      await poll()

      sinon.assert.notCalled(rc.dispatch)
      assert.strictEqual(rc.appliedConfigs.size, 0)
    })

    it('should map adds, updates and removals onto the dispatch lists', async () => {
      fetcher.fetchChanges.yields(null, [
        change('add', 'APPLY', { file: { config: 'newConf' } }),
        change('update', 'MODIFY', { file: { config: 'newConf' }, version: 12 }),
        change('remove', 'UNAPPLY'),
      ])

      rc.appliedConfigs.set('datadog/42/MODIFY/confId/config', {
        path: 'datadog/42/MODIFY/confId/config',
        product: 'MODIFY',
        id: 'confId',
        version: 11,
        apply_state: ACKNOWLEDGED,
        apply_error: '',
        file: { config: 'oldConf' },
      })

      const unapplied = {
        path: 'datadog/42/UNAPPLY/confId/config',
        product: 'UNAPPLY',
        id: 'confId',
        version: 69,
        apply_state: ACKNOWLEDGED,
        apply_error: '',
        file: { asm: { enabled: true } },
      }
      rc.appliedConfigs.set(unapplied.path, unapplied)

      await poll()

      sinon.assert.calledThrice(rc.dispatch)
      sinon.assert.calledWithMatch(rc.dispatch.firstCall, [unapplied], 'unapply', sinon.match.instanceOf(Map))
      sinon.assert.calledWithMatch(rc.dispatch.secondCall, [{
        path: 'datadog/42/APPLY/confId/config',
        product: 'APPLY',
        id: 'confId',
        version: 1,
        // Set by the `dispatch` stub above, which runs before this assertion.
        apply_state: ACKNOWLEDGED,
        apply_error: '',
        file: { config: 'newConf' },
      }], 'apply', sinon.match.instanceOf(Map))
      sinon.assert.calledWithMatch(rc.dispatch.thirdCall, [{
        path: 'datadog/42/MODIFY/confId/config',
        product: 'MODIFY',
        id: 'confId',
        version: 12,
        apply_state: ACKNOWLEDGED,
        apply_error: '',
        file: { config: 'newConf' },
      }], 'modify', sinon.match.instanceOf(Map))

      assert.deepStrictEqual([...rc.appliedConfigs.keys()], [
        'datadog/42/MODIFY/confId/config',
        'datadog/42/APPLY/confId/config',
      ])
    })

    it('should treat an update of a config it never applied as an apply', async () => {
      fetcher.fetchChanges.yields(null, [change('update', 'APPLY')])

      await poll()

      sinon.assert.calledThrice(rc.dispatch)
      assert.deepStrictEqual(rc.dispatch.firstCall.firstArg, [])
      assert.strictEqual(rc.dispatch.secondCall.firstArg.length, 1)
      assert.deepStrictEqual(rc.dispatch.thirdCall.firstArg, [])
    })

    it('should reapply an update when the previous apply failed', async () => {
      const record = change('update', 'APPLY', { version: 2 })
      rc.appliedConfigs.set(record.path, {
        ...record,
        id: record.configId,
        apply_state: ERROR,
        apply_error: 'Error: could not apply',
        file: {},
      })
      fetcher.fetchChanges.yields(null, [record])

      await poll()

      assert.strictEqual(rc.dispatch.secondCall.firstArg.length, 1)
      assert.deepStrictEqual(rc.dispatch.thirdCall.firstArg, [])
    })

    it('should dispatch a path reported as both added and updated only once', async () => {
      fetcher.fetchChanges.yields(null, [
        change('add', 'APPLY', { file: { a: 2 }, version: 2 }),
        change('update', 'APPLY', { file: { a: 2 }, version: 2 }),
      ])

      await poll()

      assert.strictEqual(rc.dispatch.secondCall.firstArg.length, 1)
      assert.deepStrictEqual(rc.dispatch.secondCall.firstArg[0].file, { a: 2 })
      assert.deepStrictEqual(rc.dispatch.thirdCall.firstArg, [])
    })

    it('should ignore the removal of a config it never applied', async () => {
      fetcher.fetchChanges.yields(null, [change('remove', 'UNAPPLY')])

      await poll()

      sinon.assert.notCalled(rc.dispatch)
    })

    it('should treat empty contents as an absent config', async () => {
      const record = change('add', 'APPLY')
      record.contents = ''
      fetcher.fetchChanges.yields(null, [record])

      await poll()

      assert.strictEqual(rc.dispatch.secondCall.firstArg[0].file, null)
    })

    it('should report unparsable contents as an error and not apply them', async () => {
      const record = change('add', 'APPLY')
      record.contents = '{not json'
      fetcher.fetchChanges.yields(null, [record])

      await poll()

      sinon.assert.notCalled(rc.dispatch)
      sinon.assert.calledOnce(log.error)
      assert.strictEqual(log.error.firstCall.args[0], '[RC] Could not parse the config file at path %s')
      assert.strictEqual(log.error.firstCall.args[1], 'datadog/42/APPLY/confId/config')
      sinon.assert.calledOnceWithExactly(
        fetcher.setConfigState,
        'datadog/42/APPLY/confId/config',
        ERROR,
        sinon.match.string
      )
      assert.strictEqual(rc.appliedConfigs.size, 0)
    })

    it('should report missing contents as an error and not apply the config', async () => {
      const record = change('add', 'APPLY')
      delete record.contents
      fetcher.fetchChanges.yields(null, [record])

      await poll()

      sinon.assert.notCalled(rc.dispatch)
      sinon.assert.calledOnceWithExactly(
        fetcher.setConfigState,
        record.path,
        ERROR,
        'Error: Missing config contents'
      )
      assert.strictEqual(rc.appliedConfigs.size, 0)
    })

    it('should let batch handlers ack items and skip per-product handlers (including unapply)', async () => {
      const unapplyPath = 'datadog/42/ASM/confId/config'
      rc.appliedConfigs.set(unapplyPath, {
        path: unapplyPath,
        product: 'ASM',
        id: 'confId',
        version: 1,
        apply_state: ACKNOWLEDGED,
        apply_error: '',
        file: { a: 1 },
      })

      const handler = sinon.spy()
      rc.setProductHandler('ASM', handler)

      rc.setBatchHandler(['ASM'], (transaction) => {
        for (const item of transaction.toUnapply) {
          transaction.ack(item.path)
        }
      })
      rc.dispatch.restore()

      fetcher.fetchChanges.yields(null, [change('remove', 'ASM')])

      await poll()

      sinon.assert.notCalled(handler)
      assert.strictEqual(rc.appliedConfigs.has(unapplyPath), false)
      sinon.assert.calledWithExactly(fetcher.setConfigState, unapplyPath, ACKNOWLEDGED, '')
    })

    it('should call per-product handlers when batch handlers do not ack/error (including unapply)', async () => {
      const unapplyPath = 'datadog/42/ASM/confId/config'
      const conf = {
        path: unapplyPath,
        product: 'ASM',
        id: 'confId',
        version: 1,
        apply_state: ACKNOWLEDGED,
        apply_error: '',
        file: { a: 1 },
      }
      rc.appliedConfigs.set(unapplyPath, conf)

      const handler = sinon.spy()
      rc.setProductHandler('ASM', handler)

      rc.setBatchHandler(['ASM'], () => {})

      // This test needs the real dispatch path in order to verify handler invocation.
      rc.dispatch.restore()

      fetcher.fetchChanges.yields(null, [change('remove', 'ASM')])

      await poll()

      sinon.assert.calledOnceWithExactly(handler, 'unapply', conf.file, conf.id)
      assert.strictEqual(rc.appliedConfigs.has(unapplyPath), false)
    })

    it('should stop handing updates to a removed batch handler', async () => {
      const handler = sinon.spy()
      rc.subscribeProducts('ASM')
      rc.setBatchHandler(['ASM'], handler)

      fetcher.fetchChanges.yields(null, [change('add', 'ASM', { file: { a: 1 } })])
      await poll()

      fetcher.fetchChanges.yields(null, [change('update', 'ASM', { file: { a: 2 }, version: 2 })])
      await poll()

      sinon.assert.calledTwice(handler)
      assert.strictEqual(handler.firstCall.firstArg.toApply.length, 1)
      assert.strictEqual(handler.secondCall.firstArg.toModify.length, 1)

      rc.removeBatchHandler(handler)

      fetcher.fetchChanges.yields(null, [change('update', 'ASM', { file: { a: 3 }, version: 3 })])
      await poll()

      sinon.assert.calledTwice(handler)
    })

    it('should report a batch handler error for the config it was reported against', async () => {
      const error = new Error('waf update failed')
      rc.subscribeProducts('ASM')
      rc.setBatchHandler(['ASM'], (transaction) => {
        for (const item of transaction.toApply) {
          transaction.error(item.path, error)
        }
      })
      rc.dispatch.restore()

      fetcher.fetchChanges.yields(null, [change('add', 'ASM')])

      await poll()

      sinon.assert.calledOnceWithExactly(
        fetcher.setConfigState,
        'datadog/42/ASM/confId/config',
        ERROR,
        'Error: waf update failed'
      )
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

      // Handlers that have not acknowledged yet must be reported as unacknowledged, overriding the
      // native client's optimistic acknowledgement of every stored config.
      for (const index of [2, 3, 6, 7, 8]) {
        sinon.assert.calledWithExactly(
          fetcher.setConfigState,
          `datadog/42/PRODUCT_${index}/confId/config`,
          UNACKNOWLEDGED,
          ''
        )
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

        sinon.assert.calledWithExactly(
          fetcher.setConfigState,
          'datadog/42/PRODUCT_3/confId/config',
          ERROR,
          'Error: async fn'
        )
        sinon.assert.calledWithExactly(
          fetcher.setConfigState,
          'datadog/42/PRODUCT_6/confId/config',
          ACKNOWLEDGED,
          ''
        )
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

    it('should report a rejected thenable from a product handler', () => {
      const error = new Error('could not apply')
      rc.setProductHandler('ASM_FEATURES', () => ({
        /**
         * @param {() => void} _resolve
         * @param {(error: Error) => void} reject
         */
        then (_resolve, reject) {
          reject(error)
        },
      }))
      const item = {
        id: 'asm_data',
        path: 'datadog/42/ASM_FEATURES/confId/config',
        product: 'ASM_FEATURES',
        apply_state: UNACKNOWLEDGED,
        apply_error: '',
        file: { asm: { enabled: true } },
      }

      rc.dispatch([item], 'apply', new Map())

      assert.strictEqual(item.apply_state, ERROR)
      assert.strictEqual(item.apply_error, error.toString())
      sinon.assert.calledWithExactly(fetcher.setConfigState, item.path, ERROR, error.toString())
    })

    it('should acknowledge a synchronous result with a non-callable then property', () => {
      rc.setProductHandler('ASM_FEATURES', () => ({ then: true }))
      const item = {
        id: 'asm_data',
        path: 'datadog/42/ASM_FEATURES/confId/config',
        product: 'ASM_FEATURES',
        apply_state: UNACKNOWLEDGED,
        apply_error: '',
        file: { asm: { enabled: true } },
      }

      rc.dispatch([item], 'apply', new Map())

      assert.strictEqual(item.apply_state, ACKNOWLEDGED)
      assert.strictEqual(item.apply_error, '')
      sinon.assert.calledWithExactly(fetcher.setConfigState, item.path, ACKNOWLEDGED, '')
    })

    it('should ignore an asynchronous acknowledgement for a replaced config', async () => {
      const acknowledgements = []
      const handler = sinon.spy((action, conf, id, acknowledge) => acknowledgements.push(acknowledge))
      rc.setProductHandler('ASM_FEATURES', handler)
      fetcher.fetchChanges.onFirstCall().yields(null, [change('add', 'ASM_FEATURES')])
      fetcher.fetchChanges.onSecondCall().yields(null, [change('update', 'ASM_FEATURES', { version: 2 })])

      await poll()
      await poll()
      fetcher.setConfigState.resetHistory()

      acknowledgements[0]()

      sinon.assert.notCalled(fetcher.setConfigState)
      assert.strictEqual(rc.appliedConfigs.get('datadog/42/ASM_FEATURES/confId/config').version, 2)

      acknowledgements[1]()
      sinon.assert.calledOnceWithExactly(
        fetcher.setConfigState,
        'datadog/42/ASM_FEATURES/confId/config',
        ACKNOWLEDGED,
        ''
      )
    })
  })
})
