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
  let satisfiesMock
  let telemetryMock

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
    satisfiesMock = sinon.spy(satisfies)
    telemetryMock = sinon.stub()

    const registerPath = require.resolve('../../src/helpers/register')
    const instrumentationUtilsPath = require.resolve('../../src/helpers/instrumentation-utils')
    originalModuleProtoRequire = Module.prototype.require

    Module.prototype.require = function (request) {
      if (this.filename === instrumentationUtilsPath && request === '../../../../vendor/dist/semifies') {
        return satisfiesMock
      }
      if (this.filename === registerPath) {
        const stubs = {
          './hooks': hooksMock,
          './hook': HookMock,
          './instrumentations': instrumentationsMock,
          '../../../dd-trace/src/guardrails/telemetry': telemetryMock,
        }
        return stubs[request] || originalModuleProtoRequire.call(this, request)
      }
      return originalModuleProtoRequire.call(this, request)
    }

    clearRegisterCache()
  })

  afterEach(() => {
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
    require('../../src/helpers/register')
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

  /**
   * @param {string} name
   * @param {string} version
   * @param {string} errorType
   * @param {string} errorMessage
   */
  function assertInstrumentationError (name, version, errorType, errorMessage) {
    sinon.assert.calledOnceWithExactly(telemetryMock, 'error', [
      `error_type:${errorType}`,
      `integration:${name}`,
      `integration_version:${version}`,
    ], {
      result: 'error',
      result_class: 'internal_error',
      result_reason: `Error during instrumentation of ${name}@${version}: ${errorMessage}`,
    })
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

  it('should instrument an already evaluated module through the registered hook', () => {
    const patch = sinon.stub().returns({ patched: true })
    hooksMock.example = { fn: sinon.stub() }
    instrumentationsMock.example = [{ file: 'logger.js', hook: patch }]
    loadRegisterWithEnv()
    const { instrumentModule } = require('../../src/helpers/register')
    const moduleExports = { original: true }

    const uninstrumented = instrumentModule(moduleExports, 'missing', 'missing', '/path/to/missing', '1.0.0')
    assert.strictEqual(uninstrumented, moduleExports)
    const result = instrumentModule(
      moduleExports,
      'example',
      'example/logger.js',
      '/path/to/example',
      '1.0.0'
    )

    assert.deepStrictEqual(result, { patched: true })
    sinon.assert.calledOnceWithExactly(patch, moduleExports, '1.0.0', undefined, {
      moduleBaseDir: '/path/to/example',
      moduleName: 'example/logger.js',
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

  for (const [error, errorType, errorMessage] of [
    [new Error('hook load failed'), 'Error', 'hook load failed'],
    ['hook load failed', 'string', 'string'],
  ]) {
    it(`should return original exports when loading an integration throws ${errorType}`, () => {
      hooksMock.example = { fn: sinon.stub().callsFake(() => { throw error }) }
      loadRegisterWithEnv()

      const hookCall = HookMock.getCalls().find(({ args }) => args[0][0] === 'example')
      const hook = hookCall.args[2]

      assert.strictEqual(hook('original', 'example', '/path/to/example', '1.0.0'), 'original')
      assertInstrumentationError('example', '1.0.0', errorType, errorMessage)
    })
  }

  it('should return original exports when an instrumentation patch throws', () => {
    const moduleExports = {}
    hooksMock.example = { fn: sinon.stub() }
    instrumentationsMock.example = [{ hook: sinon.stub().throws(new Error('patch failed')) }]
    loadRegisterWithEnv()

    const hookCall = HookMock.getCalls().find(({ args }) => args[0][0] === 'example')
    const hook = hookCall.args[2]

    assert.strictEqual(hook(moduleExports, 'example', '/path/to/example', '1.0.0'), moduleExports)
    assertInstrumentationError('example', '1.0.0', 'Error', 'patch failed')
  })

  it('should not load a relative hook owned by a disabled integration', () => {
    const load = sinon.stub()
    const patch = sinon.stub()
    hooksMock['./runtime/library.js'] = { fn: load }
    instrumentationsMock['./runtime/library.js'] = [{ hook: patch }]
    loadRegisterWithEnv({ DD_TRACE_DISABLED_INSTRUMENTATIONS: '@prisma/client' })

    const hookCall = HookMock.getCalls().find(({ args }) => args[0][0] === './runtime/library.js')
    const hook = hookCall.args[2]

    assert.strictEqual(
      hook('original', './runtime/library.js', '/path/to/runtime', '6.1.0', false, '@prisma/client'),
      'original'
    )
    sinon.assert.notCalled(load)
    sinon.assert.notCalled(patch)
  })
})
