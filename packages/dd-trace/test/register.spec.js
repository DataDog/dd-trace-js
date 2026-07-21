'use strict'

const assert = require('node:assert/strict')

const sinon = require('sinon')
const proxyquire = require('proxyquire').noCallThru().noPreserveCache()

require('./setup/core')

const SUPPORTED_SYNC_HOOKS_NODE_VERSION = {
  NODE_MAJOR: 24,
  NODE_MINOR: 11,
  NODE_PATCH: 1,
}
const SYNC_SOURCE_REWRITING_SYMBOL = Symbol.for('dd-trace.loader.sync-source-rewriting')

describe('register.js', () => {
  let emitWarning

  beforeEach(() => {
    delete globalThis[SYNC_SOURCE_REWRITING_SYMBOL]
    emitWarning = sinon.stub(process, 'emitWarning')
  })

  afterEach(() => {
    delete globalThis[SYNC_SOURCE_REWRITING_SYMBOL]
    emitWarning.restore()
  })

  for (const version of [
    { NODE_MAJOR: 22, NODE_MINOR: 22, NODE_PATCH: 2 },
    { NODE_MAJOR: 24, NODE_MINOR: 11, NODE_PATCH: 0 },
    { NODE_MAJOR: 25, NODE_MINOR: 0, NODE_PATCH: 0 },
  ]) {
    it(`falls back on the last unsupported Node.js ${formatVersion(version)} boundary`, () => {
      const register = sinon.stub()
      const registerSyncLoaderHooks = sinon.stub().returns(true)
      const supportsSyncHooks = sinon.stub().throws(new Error('should not be called'))

      loadRegister({ register, registerSyncLoaderHooks, supportsSyncHooks, version })

      sinon.assert.notCalled(registerSyncLoaderHooks)
      sinon.assert.notCalled(supportsSyncHooks)
      sinon.assert.calledOnceWithExactly(register, './loader-hook.mjs', sinon.match.instanceOf(URL))
      sinon.assert.notCalled(emitWarning)
      assertSyncSourceRewritingInactive()
    })
  }

  for (const version of [
    { NODE_MAJOR: 22, NODE_MINOR: 22, NODE_PATCH: 3 },
    { NODE_MAJOR: 24, NODE_MINOR: 11, NODE_PATCH: 1 },
    { NODE_MAJOR: 25, NODE_MINOR: 1, NODE_PATCH: 0 },
    { NODE_MAJOR: 26, NODE_MINOR: 0, NODE_PATCH: 0 },
  ]) {
    it(`registers sync loader hooks on the first supported Node.js ${formatVersion(version)} boundary`, () => {
      const register = sinon.stub()
      const registerSyncLoaderHooks = sinon.stub().returns(true)

      loadRegister({ register, registerSyncLoaderHooks, supportsSyncHooks: () => true, version })

      sinon.assert.calledOnce(registerSyncLoaderHooks)
      sinon.assert.notCalled(register)
      sinon.assert.notCalled(emitWarning)
      assert.strictEqual(globalThis[SYNC_SOURCE_REWRITING_SYMBOL], true)
    })
  }

  it('falls back if sync hook support detection returns false', () => {
    const register = sinon.stub()
    const registerSyncLoaderHooks = sinon.stub().returns(true)

    loadRegister({ register, registerSyncLoaderHooks, supportsSyncHooks: () => false })

    sinon.assert.notCalled(registerSyncLoaderHooks)
    sinon.assert.calledOnceWithExactly(register, './loader-hook.mjs', sinon.match.instanceOf(URL))
    sinon.assert.notCalled(emitWarning)
    assertSyncSourceRewritingInactive()
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
    sinon.assert.calledOnceWithExactly(register, './loader-hook.mjs', sinon.match.instanceOf(URL))
    sinon.assert.calledOnceWithMatch(emitWarning, /dd-trace could not register synchronous loader hooks/)
    assertSyncSourceRewritingInactive()
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
    sinon.assert.calledOnceWithExactly(register, './loader-hook.mjs', sinon.match.instanceOf(URL))
    sinon.assert.calledOnceWithMatch(
      emitWarning,
      /dd-trace could not register synchronous loader hooks.*sync hook failure/
    )
    assertSyncSourceRewritingInactive()
  })

  it('falls back to the async loader if require(esm) is disabled', () => {
    const register = sinon.stub()
    const error = new Error('require(esm) is disabled')
    error.code = 'ERR_REQUIRE_ESM'

    loadRegister({
      register,
      loaderHook: createThrowingLoaderHook(error),
      supportsSyncHooks: () => true,
    })

    sinon.assert.calledOnceWithExactly(register, './loader-hook.mjs', sinon.match.instanceOf(URL))
    sinon.assert.calledOnceWithMatch(
      emitWarning,
      /dd-trace could not register synchronous loader hooks.*require\(esm\) is disabled/
    )
    assertSyncSourceRewritingInactive()
  })

  it('warns and falls back if sync loader import fails', () => {
    const register = sinon.stub()
    const error = new Error('loader import failure')

    loadRegister({
      register,
      loaderHook: createThrowingLoaderHook(error),
      supportsSyncHooks: () => true,
    })

    sinon.assert.calledOnceWithExactly(register, './loader-hook.mjs', sinon.match.instanceOf(URL))
    sinon.assert.calledOnceWithMatch(
      emitWarning,
      /dd-trace could not register synchronous loader hooks.*loader import failure/
    )
    assertSyncSourceRewritingInactive()
  })

  it('warns and falls back if sync hook support detection fails', () => {
    const register = sinon.stub()
    const error = new Error('support detection failure')

    loadRegister({
      register,
      supportsSyncHooks: () => { throw error },
    })

    sinon.assert.calledOnceWithExactly(register, './loader-hook.mjs', sinon.match.instanceOf(URL))
    sinon.assert.calledOnceWithMatch(
      emitWarning,
      /dd-trace could not register synchronous loader hooks.*support detection failure/
    )
    assertSyncSourceRewritingInactive()
  })
})

function assertSyncSourceRewritingInactive () {
  assert.strictEqual(globalThis[SYNC_SOURCE_REWRITING_SYMBOL], undefined)
}

function formatVersion ({ NODE_MAJOR, NODE_MINOR, NODE_PATCH }) {
  return `${NODE_MAJOR}.${NODE_MINOR}.${NODE_PATCH}`
}

function createThrowingLoaderHook (error) {
  return Object.defineProperty({}, 'registerSyncLoaderHooks', {
    get () {
      throw error
    },
  })
}

function loadRegister ({ register, registerSyncLoaderHooks, loaderHook, supportsSyncHooks, version }) {
  proxyquire('../../../register.js', {
    'node:module': { register },
    'import-in-the-middle/create-hook.mjs': { supportsSyncHooks },
    './loader-hook.mjs': loaderHook || { registerSyncLoaderHooks },
    './version': version || SUPPORTED_SYNC_HOOKS_NODE_VERSION,
  })
}
