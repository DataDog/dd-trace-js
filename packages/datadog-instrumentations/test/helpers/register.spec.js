'use strict'

const Module = require('module')
const assert = require('node:assert/strict')

const { channel } = require('dc-polyfill')
const sinon = require('sinon')

const satisfies = require('../../../../vendor/dist/semifies')

describe('register', () => {
  let hooksMock
  let HookMock
  let instrumentationsMock
  let originalModuleProtoRequire
  let requiredModules
  let satisfiesMock
  let telemetryMock
  let logMock
  let getActivationSetupMock
  let subscriptions

  const clearRegisterCache = () => {
    const registerPath = require.resolve('../../src/helpers/register')
    const instrumentationUtilsPath = require.resolve('../../src/helpers/instrumentation-utils')
    delete require.cache[registerPath]
    delete require.cache[instrumentationUtilsPath]
  }

  beforeEach(() => {
    delete process.env.DD_TRACE_CONFLUENTINC_KAFKA_JAVASCRIPT_ENABLED
    delete process.env.DD_TRACE_DISABLED_INSTRUMENTATIONS

    hooksMock = {
      '@confluentinc/kafka-javascript': {
        fn: sinon.stub().returns('hooked'),
      },
      'mongodb-core': {
        fn: sinon.stub().returns('hooked'),
      },
    }

    HookMock = sinon.stub()
    instrumentationsMock = {}
    requiredModules = []
    satisfiesMock = sinon.spy(satisfies)
    telemetryMock = sinon.stub()
    logMock = { error: sinon.stub(), info: sinon.stub() }
    getActivationSetupMock = sinon.stub()
    subscriptions = []

    const registerPath = require.resolve('../../src/helpers/register')
    const instrumentationUtilsPath = require.resolve('../../src/helpers/instrumentation-utils')
    originalModuleProtoRequire = Module.prototype.require

    Module.prototype.require = function (request) {
      if (this.filename === instrumentationUtilsPath && request === '../../../../vendor/dist/semifies') {
        return satisfiesMock
      }
      if (this.filename === registerPath) {
        if (request === '../console') {
          requiredModules.push(request)
          return {}
        }
        const stubs = {
          './hooks': hooksMock,
          './hook': HookMock,
          './instrumentations': instrumentationsMock,
          './rewriter/instrumentation-registry': { getActivationSetup: getActivationSetupMock },
          '../../../dd-trace/src/log': logMock,
          '../../../dd-trace/src/guardrails/telemetry': telemetryMock,
          'dc-polyfill': {
            channel: name => {
              const ch = channel(name)
              return {
                publish: message => ch.publish(message),
                subscribe: subscriber => {
                  ch.subscribe(subscriber)
                  subscriptions.push(() => ch.unsubscribe(subscriber))
                },
              }
            },
          },
        }
        return stubs[request] || originalModuleProtoRequire.call(this, request)
      }
      return originalModuleProtoRequire.call(this, request)
    }

    clearRegisterCache()
  })

  afterEach(() => {
    for (const unsubscribe of subscriptions) unsubscribe()
    sinon.restore()
    Module.prototype.require = originalModuleProtoRequire
    clearRegisterCache()
  })

  const loadRegisterWithEnv = (env = undefined) => {
    env = env || {}
    clearRegisterCache()
    Object.entries(env).forEach(([key, value]) => {
      process.env[key] = value
    })
    return require('../../src/helpers/register')
  }

  const runHookCallbacks = (hookMock) => {
    for (let i = 0; i < hookMock.callCount; i++) {
      const callback = hookMock.args[i][2]
      const moduleName = hookMock.args[i][0][0]
      const moduleExports = 'original'
      const result = callback(moduleExports, moduleName, '/path/to/module', '1.0.0')
      assert.strictEqual(result, 'original')
    }
  }

  it('should disable hooks that are disabled by DD_TRACE_DISABLED_INSTRUMENTATIONS', () => {
    loadRegisterWithEnv({ DD_TRACE_DISABLED_INSTRUMENTATIONS: 'mongodb-core,@confluentinc/kafka-javascript' })

    assert.strictEqual(HookMock.callCount, 0)

    runHookCallbacks(HookMock)

    sinon.assert.notCalled(hooksMock['@confluentinc/kafka-javascript'].fn)
    sinon.assert.notCalled(hooksMock['mongodb-core'].fn)
  })

  for (const disabledName of ['fs', 'node:fs']) {
    it(`should disable both builtin hook names when ${disabledName} is disabled`, () => {
      hooksMock.fs = { fn: sinon.stub() }
      hooksMock['node:fs'] = { fn: sinon.stub() }

      loadRegisterWithEnv({ DD_TRACE_DISABLED_INSTRUMENTATIONS: disabledName })

      const registeredNames = []
      for (const [names] of HookMock.args) {
        registeredNames.push(names[0])
      }
      assert.deepStrictEqual(registeredNames.sort(), ['@confluentinc/kafka-javascript', 'mongodb-core'])
    })
  }

  for (const disabledName of ['console', 'node:console']) {
    it(`should not load console instrumentation when ${disabledName} is disabled`, () => {
      loadRegisterWithEnv({ DD_TRACE_DISABLED_INSTRUMENTATIONS: disabledName })

      assert.strictEqual(requiredModules.includes('../console'), false)
    })
  }

  it('should report the name and version correctly for scoped integration names', () => {
    loadRegisterWithEnv()

    const integrationName = '@confluentinc/kafka-javascript'
    const moduleVersion = '0.1.0'
    const hookCall = HookMock.getCalls().find(({ args }) => args[0][0] === integrationName)
    const hook = hookCall.args[2]

    hook('original', integrationName, '/path/to/module', moduleVersion)
    channel('dd-trace:exporter:first-flush').publish()

    sinon.assert.calledOnceWithExactly(telemetryMock, 'abort.integration', [
      `integration:${integrationName}`,
      `integration_version:${moduleVersion}`,
    ], {
      result: 'abort',
      result_class: 'incompatible_library',
      result_reason: `Incompatible integration version: ${integrationName}@${moduleVersion}`,
    })
  })

  it('should report unsupported pure Orchestrion targets at flush', () => {
    loadRegisterWithEnv()

    channel('dd-trace:instrumentation:load:orchestrion').publish({
      moduleName: 'bullmq',
      result: 'unsupported',
      version: '5.65.0',
    })
    channel('dd-trace:instrumentation:load:orchestrion').publish({
      moduleName: 'bullmq',
      result: 'unsupported',
      version: '5.65.0',
    })
    channel('dd-trace:exporter:first-flush').publish()
    channel('dd-trace:instrumentation:load:orchestrion').publish({
      moduleName: 'bullmq',
      result: 'unsupported',
      version: '5.65.0',
    })
    channel('dd-trace:exporter:first-flush').publish()

    sinon.assert.calledOnceWithExactly(telemetryMock, 'abort.integration', [
      'integration:bullmq',
      'integration_version:5.65.0',
    ], {
      result: 'abort',
      result_class: 'incompatible_library',
      result_reason: 'Incompatible integration version: bullmq@5.65.0',
    })
  })

  it('should keep pure Orchestrion compatibility success monotonic and activate only rewritten targets', () => {
    loadRegisterWithEnv()
    const activations = []
    const loadChannel = channel('dd-trace:instrumentation:load')
    const subscriber = message => activations.push(message)
    loadChannel.subscribe(subscriber)
    const orchestrionChannel = channel('dd-trace:instrumentation:load:orchestrion')
    const message = { moduleName: '@langchain/core', version: '1.0.0' }

    try {
      orchestrionChannel.publish({ ...message, result: 'unsupported' })
      orchestrionChannel.publish({ ...message, result: 'matched' })
      orchestrionChannel.publish({ ...message, result: 'unsupported' })
      assert.deepStrictEqual(activations, [])

      orchestrionChannel.publish({ ...message, result: 'rewritten' })
      assert.ok(activations.length > 0)
      assert.ok(activations.every(({ name }) => name === '@langchain/core'))
      channel('dd-trace:exporter:first-flush').publish()
      orchestrionChannel.publish({ ...message, result: 'unsupported' })
      channel('dd-trace:exporter:first-flush').publish()

      sinon.assert.notCalled(telemetryMock)
    } finally {
      loadChannel.unsubscribe(subscriber)
    }
  })

  it('passes metadata to setup before activating every module in a group', () => {
    const setup = sinon.stub().returns({ ignored: true })
    getActivationSetupMock.withArgs('first').returns(setup)
    getActivationSetupMock.withArgs('second').returns(setup)
    const load = sinon.stub(channel('dd-trace:instrumentation:load'), 'publish')
    const { activate } = loadRegisterWithEnv()

    channel('dd-trace:instrumentation:load:orchestrion').publish({
      moduleName: 'first', version: '1.0.0', result: 'matched',
    })
    sinon.assert.notCalled(setup)
    sinon.assert.notCalled(load)

    channel('dd-trace:instrumentation:load:orchestrion').publish({
      moduleName: 'first', version: '1.0.0', result: 'rewritten',
    })
    activate('second', '2.0.0')
    activate('first', '1.0.1')

    assert.deepStrictEqual(setup.args, [
      [{ moduleName: 'first', version: '1.0.0' }],
      [{ moduleName: 'second', version: '2.0.0' }],
      [{ moduleName: 'first', version: '1.0.1' }],
    ])
    sinon.assert.callOrder(setup, load)
    assert.ok(setup.getCall(1).calledBefore(load.getCall(1)))
    assert.ok(setup.getCall(2).calledBefore(load.getCall(2)))
    assert.deepStrictEqual(load.args, [[{ name: 'first' }], [{ name: 'second' }], [{ name: 'first' }]])
  })

  it('runs distinct setup functions independently and still activates modules without setup', () => {
    const firstSetup = sinon.stub()
    const secondSetup = sinon.stub()
    getActivationSetupMock.withArgs('first').returns(firstSetup)
    getActivationSetupMock.withArgs('second').returns(secondSetup)
    const load = sinon.stub(channel('dd-trace:instrumentation:load'), 'publish')
    const { activate } = loadRegisterWithEnv()

    activate('first')
    activate('second')
    activate('without-setup')

    sinon.assert.calledOnceWithExactly(firstSetup, { moduleName: 'first', version: undefined })
    sinon.assert.calledOnceWithExactly(secondSetup, { moduleName: 'second', version: undefined })
    assert.deepStrictEqual(load.args, [[{ name: 'first' }], [{ name: 'second' }], [{ name: 'without-setup' }]])
  })

  it('permanently blocks a group when a later activation setup fails', () => {
    const error = new Error('metadata failed')
    const setup = sinon.stub().onSecondCall().throws(error)
    getActivationSetupMock.withArgs('first').returns(setup)
    getActivationSetupMock.withArgs('second').returns(setup)
    const load = sinon.stub(channel('dd-trace:instrumentation:load'), 'publish')
    const { activate } = loadRegisterWithEnv()

    activate('first', '1.0.0')
    activate('second', '2.0.0')
    activate('first', '1.0.1')

    assert.strictEqual(setup.callCount, 2)
    sinon.assert.calledOnceWithExactly(load, { name: 'first' })
    sinon.assert.calledOnceWithExactly(logMock.error,
      'Error during activation setup of %s: %s', 'second', 'metadata failed', error)
    sinon.assert.calledOnceWithExactly(telemetryMock, 'error', [
      'error_type:Error', 'integration:second', 'integration_version:2.0.0',
    ], {
      result: 'error',
      result_class: 'internal_error',
      result_reason: 'Error during activation of second: metadata failed',
    })
  })

  it('does not publish re-entrant group activations before setup has completed', () => {
    const load = sinon.stub(channel('dd-trace:instrumentation:load'), 'publish')
    const setup = sinon.stub().callsFake(() => {
      const publishCount = load.callCount
      activate('second')
      assert.strictEqual(load.callCount, publishCount)
    })
    getActivationSetupMock.withArgs('first').returns(setup)
    getActivationSetupMock.withArgs('second').returns(setup)
    const { activate } = loadRegisterWithEnv()

    activate('first')
    activate('second')

    assert.strictEqual(setup.callCount, 2)
    assert.deepStrictEqual(load.args, [[{ name: 'first' }], [{ name: 'second' }]])
  })

  for (const error of [new TypeError('setup failed'), 'setup failed', null]) {
    it(`permanently blocks a group after setup throws ${String(error)}`, () => {
      const setup = sinon.stub().callsFake(() => { throw error })
      getActivationSetupMock.withArgs('first').returns(setup)
      getActivationSetupMock.withArgs('second').returns(setup)
      const load = sinon.stub(channel('dd-trace:instrumentation:load'), 'publish')
      const { activate } = loadRegisterWithEnv()
      const message = String(error?.message ?? error)

      channel('dd-trace:instrumentation:load:orchestrion').publish({
        moduleName: 'first', version: '1.0.0', result: 'rewritten',
      })
      activate('second')
      activate('first')

      sinon.assert.calledOnceWithExactly(setup, { moduleName: 'first', version: '1.0.0' })
      sinon.assert.notCalled(load)
      sinon.assert.calledOnceWithExactly(logMock.error,
        'Error during activation setup of %s: %s', 'first', message, error)
      sinon.assert.calledOnceWithExactly(telemetryMock, 'error', [
        `error_type:${error?.constructor?.name ?? typeof error}`,
        'integration:first',
        'integration_version:1.0.0',
      ], {
        result: 'error',
        result_class: 'internal_error',
        result_reason: `Error during activation of first: ${message}`,
      })
    })
  }

  it('should only unwrap an IITM default export after its instrumentation matches', () => {
    const patch = sinon.stub()
    hooksMock.mariadb = { esmFirst: true, fn: sinon.stub() }
    instrumentationsMock.mariadb = [{
      file: 'lib/cmd/query.js',
      versions: ['>=3.5.1'],
      patchDefault: true,
      hook: patch,
    }]
    loadRegisterWithEnv()

    const hookCall = HookMock.getCalls().find(({ args }) => args[0][0] === 'mariadb')
    const hook = hookCall.args[2]
    const moduleExports = { default: class Execute {} }

    const result = hook(moduleExports, 'mariadb/lib/cmd/execute.js', '/path/to/mariadb', '3.5.1', true)

    assert.strictEqual(result, moduleExports)
    sinon.assert.notCalled(patch)

    const unsupportedModuleExports = { default: class Query {} }
    const unsupportedVersion = hook(
      unsupportedModuleExports,
      'mariadb/lib/cmd/query.js',
      '/path/to/mariadb',
      '3.5.0',
      true
    )

    assert.strictEqual(unsupportedVersion, unsupportedModuleExports)
    sinon.assert.notCalled(patch)

    const Query = class Query {}
    patch.returns('patched')

    const patched = hook({ default: Query }, 'mariadb/lib/cmd/query.js', '/path/to/mariadb', '3.5.1', true)

    assert.strictEqual(patched, 'patched')
    sinon.assert.calledOnceWithExactly(patch, Query, '3.5.1', true, {
      moduleBaseDir: '/path/to/mariadb',
      moduleName: 'mariadb/lib/cmd/query.js',
    })
  })

  it('should reject a nonmatching file before checking its version', () => {
    const patch = sinon.stub()
    hooksMock.example = { fn: sinon.stub() }
    instrumentationsMock.example = [{
      file: 'index.js',
      versions: ['>=1'],
      hook: patch,
    }]
    loadRegisterWithEnv()

    const hookCall = HookMock.getCalls().find(({ args }) => args[0][0] === 'example')
    const hook = hookCall.args[2]
    const moduleExports = {}

    assert.strictEqual(hook(moduleExports, 'example/internal.js', '/path/to/example', '1.0.0'), moduleExports)
    sinon.assert.notCalled(satisfiesMock)
    sinon.assert.notCalled(patch)
  })

  it('should patch a package root namespace without also patching its default callback', () => {
    const patch = sinon.stub()
    hooksMock.mocha = { fn: sinon.stub() }
    instrumentationsMock.mocha = [{
      versions: ['>=12.0.0'],
      patchDefault: false,
      hook (moduleExports) {
        patch(moduleExports.default ?? moduleExports)
        return moduleExports
      },
    }]
    loadRegisterWithEnv()

    const hookCall = HookMock.getCalls().find(({ args }) => args[0][0] === 'mocha')
    const hook = hookCall.args[2]
    const Mocha = class Mocha {}
    const namespace = { default: Mocha, Mocha }

    assert.strictEqual(hook(Mocha, 'mocha', '/path/to/mocha', '12.0.0', true), Mocha)
    sinon.assert.notCalled(patch)

    assert.strictEqual(hook(namespace, 'mocha', '/path/to/mocha', '12.0.0', true), namespace)
    sinon.assert.calledOnceWithExactly(patch, Mocha)
  })

  it('should match file patterns', () => {
    const patch = sinon.stub()
    hooksMock.example = { fn: sinon.stub() }
    instrumentationsMock.example = [{ filePattern: 'dist/cli.*', hook: patch }]
    loadRegisterWithEnv()

    const hookCall = HookMock.getCalls().find(({ args }) => args[0][0] === 'example')
    const hook = hookCall.args[2]
    const moduleExports = {}

    assert.strictEqual(
      hook(moduleExports, 'example/dist/cli-123.js', '/path/to/example', '1.0.0'),
      moduleExports
    )
    sinon.assert.calledOnceWithExactly(patch, moduleExports, '1.0.0', undefined, {
      moduleBaseDir: '/path/to/example',
      moduleName: 'example/dist/cli-123.js',
    })
  })

  it('should match relative instrumentation names', () => {
    const name = './runtime/library.js'
    const patch = sinon.stub()
    hooksMock[name] = { fn: sinon.stub() }
    instrumentationsMock[name] = [{ hook: patch }]
    loadRegisterWithEnv()

    const hookCall = HookMock.getCalls().find(({ args }) => args[0][0] === name)
    const hook = hookCall.args[2]
    const moduleExports = {}

    assert.strictEqual(hook(moduleExports, 'different/path.js', '/path/to/package', '1.0.0'), moduleExports)
    sinon.assert.calledOnceWithExactly(patch, moduleExports, '1.0.0', undefined, {
      moduleBaseDir: '/path/to/package',
      moduleName: 'different/path.js',
    })
  })

  it('should not treat an empty file pattern as a wildcard', () => {
    const patch = sinon.stub()
    hooksMock.example = { fn: sinon.stub() }
    instrumentationsMock.example = [{ filePattern: '', hook: patch }]
    loadRegisterWithEnv()

    const hookCall = HookMock.getCalls().find(({ args }) => args[0][0] === 'example')
    const hook = hookCall.args[2]
    const moduleExports = {}

    assert.strictEqual(hook(moduleExports, 'example/internal.js', '/path/to/example', '1.0.0'), moduleExports)
    sinon.assert.notCalled(patch)
  })
})
