'use strict'

const Module = require('module')
const assert = require('node:assert/strict')

const { channel } = require('dc-polyfill')
const sinon = require('sinon')

describe('register', () => {
  let hooksMock
  let HookMock
  let instrumentationsMock
  let originalModuleProtoRequire
  let telemetryMock

  const clearRegisterCache = () => {
    const registerPath = require.resolve('../../src/helpers/register')
    delete require.cache[registerPath]
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
    telemetryMock = sinon.stub()

    const registerPath = require.resolve('../../src/helpers/register')
    originalModuleProtoRequire = Module.prototype.require

    Module.prototype.require = function (request) {
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
})
