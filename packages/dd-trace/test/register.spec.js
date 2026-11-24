'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const path = require('node:path')
const { MessagePort } = require('node:worker_threads')

const sinon = require('sinon')
const proxyquire = require('proxyquire').noCallThru().noPreserveCache()

require('./setup/core')

const SUPPORTED_SYNC_HOOKS_NODE_VERSION = {
  NODE_MAJOR: 24,
  NODE_MINOR: 11,
  NODE_PATCH: 1,
}

// The asynchronous loader receives the port it reports unwrapped module loads through.
const asyncLoaderOptions = sinon.match({
  data: { moduleLoadPort: sinon.match.instanceOf(MessagePort) },
  transferList: sinon.match.array,
})

describe('register.js', () => {
  let emitWarning

  beforeEach(() => {
    emitWarning = sinon.stub(process, 'emitWarning')
  })

  afterEach(() => {
    emitWarning.restore()
  })

  it('falls back to the async loader on unsupported Node.js versions', () => {
    const register = sinon.stub()
    const registerSyncLoaderHooks = sinon.stub().returns(true)
    const supportsSyncHooks = sinon.stub().throws(new Error('should not be called'))

    loadRegister({
      register,
      registerSyncLoaderHooks,
      supportsSyncHooks,
      version: {
        NODE_MAJOR: 24,
        NODE_MINOR: 11,
        NODE_PATCH: 0,
      },
    })

    sinon.assert.notCalled(registerSyncLoaderHooks)
    sinon.assert.notCalled(supportsSyncHooks)
    sinon.assert.calledOnceWithExactly(register, './loader-hook.mjs', sinon.match.instanceOf(URL), asyncLoaderOptions)
    sinon.assert.notCalled(emitWarning)
  })

  it('registers sync loader hooks on supported Node.js versions', () => {
    const register = sinon.stub()
    const registerSyncLoaderHooks = sinon.stub().returns(true)

    loadRegister({
      register,
      registerSyncLoaderHooks,
      supportsSyncHooks: () => true,
    })

    sinon.assert.calledOnce(registerSyncLoaderHooks)
    sinon.assert.notCalled(register)
    sinon.assert.notCalled(emitWarning)
  })

  it('warns and falls back if sync loader registration returns false', () => {
    const register = sinon.stub()
    const registerSyncLoaderHooks = sinon.stub().returns(false)

    loadRegister({
      register,
      registerSyncLoaderHooks,
      supportsSyncHooks: () => true,
    })

    sinon.assert.calledOnce(registerSyncLoaderHooks)
    sinon.assert.calledOnceWithExactly(register, './loader-hook.mjs', sinon.match.instanceOf(URL), asyncLoaderOptions)
    sinon.assert.calledOnceWithMatch(emitWarning, /dd-trace could not register synchronous loader hooks/)
  })

  it('warns and falls back if sync loader registration throws', () => {
    const error = new Error('sync hook failure')
    const register = sinon.stub()
    const registerSyncLoaderHooks = sinon.stub().throws(error)

    loadRegister({
      register,
      registerSyncLoaderHooks,
      supportsSyncHooks: () => true,
    })

    sinon.assert.calledOnce(registerSyncLoaderHooks)
    sinon.assert.calledOnceWithExactly(register, './loader-hook.mjs', sinon.match.instanceOf(URL), asyncLoaderOptions)
    sinon.assert.calledOnceWithMatch(
      emitWarning,
      /dd-trace could not register synchronous loader hooks.*sync hook failure/
    )
  })

  it('falls back to the async loader if require(esm) is disabled', () => {
    const register = sinon.stub()
    const error = Object.assign(new Error('require(esm) is disabled'), { code: 'ERR_REQUIRE_ESM' })

    loadRegister({
      register,
      loaderHook: createThrowingLoaderHook(error),
      supportsSyncHooks: () => true,
    })

    sinon.assert.calledOnceWithExactly(register, './loader-hook.mjs', sinon.match.instanceOf(URL), asyncLoaderOptions)
    sinon.assert.calledOnceWithMatch(
      emitWarning,
      /dd-trace could not register synchronous loader hooks.*require\(esm\) is disabled/
    )
  })

  it('warns and falls back if sync loader import fails', () => {
    const register = sinon.stub()
    const error = new Error('loader import failure')

    loadRegister({
      register,
      loaderHook: createThrowingLoaderHook(error),
      supportsSyncHooks: () => true,
    })

    sinon.assert.calledOnceWithExactly(register, './loader-hook.mjs', sinon.match.instanceOf(URL), asyncLoaderOptions)
    sinon.assert.calledOnceWithMatch(
      emitWarning,
      /dd-trace could not register synchronous loader hooks.*loader import failure/
    )
  })

  it('skips the async loader if module.register has been removed', () => {
    const requireEsmError = Object.assign(new Error('require(esm) is disabled'), { code: 'ERR_REQUIRE_ESM' })

    loadRegister({
      register: undefined,
      registerSyncLoaderHooks: sinon.stub().throws(new Error('should not be called')),
      supportsSyncHooks: sinon.stub().throws(requireEsmError),
    })

    sinon.assert.notCalled(emitWarning)
  })

  it('does not announce an async fallback when module.register is unavailable', () => {
    loadRegister({
      register: undefined,
      registerSyncLoaderHooks: sinon.stub().returns(false),
      supportsSyncHooks: () => true,
    })

    sinon.assert.calledOnceWithExactly(emitWarning, 'dd-trace could not register synchronous loader hooks.')
  })

  it('warns and falls back if sync hook support detection fails', () => {
    const register = sinon.stub()
    const error = new Error('support detection failure')

    loadRegister({
      register,
      supportsSyncHooks: () => { throw error },
    })

    sinon.assert.calledOnceWithExactly(register, './loader-hook.mjs', sinon.match.instanceOf(URL), asyncLoaderOptions)
    sinon.assert.calledOnceWithMatch(
      emitWarning,
      /dd-trace could not register synchronous loader hooks.*support detection failure/
    )
  })
})

describe('register.mjs', () => {
  const { register } = require('node:module')
  let supportsSyncHooks

  before(async () => {
    ({ supportsSyncHooks } = await import('import-in-the-middle/supports-sync-hooks.mjs'))
  })

  it('instruments ES modules without require(esm), as on AWS Lambda', () => {
    const { result } = runRegisterMjsApp()
    assert.deepStrictEqual(result, {
      wrapped: true,
      asyncRegistrations: supportsSyncHooks() ? 0 : 1,
      syncRegistrations: supportsSyncHooks() ? 1 : 0,
    })
  })

  it('instruments ES modules via initialize.mjs without require(esm) or module.register', function () {
    if (!supportsSyncHooks()) {
      // Older Node.js releases cannot instrument ESM without the asynchronous loader.
      this.skip()
    }

    const { result } = runRegisterMjsApp('without-async-loader')
    assert.deepStrictEqual(result, { wrapped: true, asyncRegistrations: 0, syncRegistrations: 1 })
  })

  it('does not register again if register.js already installed the asynchronous loader', function () {
    if (!register) {
      // This order requires the asynchronous loader because require(esm) is disabled.
      this.skip()
    }

    const { result } = runRegisterMjsApp('commonjs-first')
    assert.deepStrictEqual(result, { wrapped: true, asyncRegistrations: 1, syncRegistrations: 0 })
  })

  it('does not register again if initialize.mjs already installed the loader', () => {
    const { result } = runRegisterMjsApp('initialize-first')
    assert.deepStrictEqual(result, {
      wrapped: true,
      asyncRegistrations: supportsSyncHooks() ? 0 : 1,
      syncRegistrations: supportsSyncHooks() ? 1 : 0,
    })
  })

  it('warns and falls back to the async loader if sync loader registration fails', function () {
    if (!supportsSyncHooks() || !register) {
      // Without sync hook support there is no sync registration to fail, and without
      // `module.register` there is no async loader to fall back to.
      this.skip()
    }

    const { result, stderr } = runRegisterMjsApp('without-sync-hooks')

    assert.match(stderr, /dd-trace could not register synchronous loader hooks\. Falling back/)
    assert.deepStrictEqual(result, { wrapped: true, asyncRegistrations: 1, syncRegistrations: 0 })
  })
})

/**
 * @param {string} [mode]
 */
function runRegisterMjsApp (mode) {
  const app = path.join(__dirname, 'fixtures', 'esm', 'register-mjs-app.mjs')
  // Node.js releases without require(esm) also reject the flag that disables it.
  const args = process.allowedNodeEnvironmentFlags.has('--no-experimental-require-module')
    ? ['--no-experimental-require-module', app]
    : [app]
  if (mode) args.push(mode)
  const { error, status, stderr, stdout } = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    timeout: 10000,
    env: {
      ...process.env,
      NODE_OPTIONS: '',
      DD_INJECTION_ENABLED: '',
      DD_INJECT_FORCE: 'true',
      DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'false',
      DD_TRACE_STARTUP_LOGS: 'false',
    },
  })
  assert.ifError(error)
  assert.strictEqual(status, 0, stderr)
  return { result: JSON.parse(stdout), stderr }
}

function createThrowingLoaderHook (error) {
  return Object.defineProperty({}, 'registerSyncLoaderHooks', {
    get () {
      throw error
    },
  })
}

/**
 * @param {{
 *   register: sinon.SinonStub | undefined,
 *   registerSyncLoaderHooks?: () => boolean,
 *   loaderHook?: object,
 *   supportsSyncHooks: () => boolean,
 *   version?: typeof SUPPORTED_SYNC_HOOKS_NODE_VERSION
 * }} stubs
 */
function loadRegister ({ register, registerSyncLoaderHooks, loaderHook, supportsSyncHooks, version }) {
  proxyquire('../../../register.js', {
    'node:module': { register },
    'import-in-the-middle/create-hook.mjs': { supportsSyncHooks },
    './loader-hook.mjs': loaderHook || { registerSyncLoaderHooks },
    './packages/dd-trace/src/register-loader': proxyquire('../src/register-loader', {
      '../../../version': version || SUPPORTED_SYNC_HOOKS_NODE_VERSION,
    }),
  })
}
