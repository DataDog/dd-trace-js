'use strict'

const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const timers = require('node:timers')
const { promisify } = require('node:util')

const proxyquire = require('proxyquire').noCallThru()
const sinon = require('sinon')

const execFileAsync = promisify(execFile)

describe('Hook', () => {
  let Hook
  let iitm
  let ritm
  let requirePackageJson
  let clock
  let schedule

  beforeEach(() => {
    clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    schedule = sinon.spy(timers, 'setTimeout')
    iitm = sinon.stub()
    ritm = sinon.stub()
    requirePackageJson = sinon.stub().returns({ version: '1.0.0' })
    Hook = proxyquire('../../src/helpers/hook', {
      '../../../dd-trace/src/iitm': iitm,
      '../../../dd-trace/src/require-package-json': requirePackageJson,
      '../../../dd-trace/src/ritm': ritm,
    })
  })

  afterEach(() => {
    sinon.restore()
  })

  it('reuses a package version across CommonJS files and ESM views', () => {
    const onrequire = sinon.stub().returnsArg(0)
    Hook(['test-package'], onrequire)
    const cjsHook = ritm.args[0][2]
    const esmHook = iitm.args[0][2]

    const first = {}
    const second = {}
    const namespace = { default: first }
    assert.strictEqual(cjsHook(first, 'test-package/first', '/test-package'), first)
    assert.strictEqual(cjsHook(second, 'test-package/second', '/test-package'), second)
    assert.strictEqual(esmHook(namespace, 'test-package/first', '/test-package'), namespace)

    sinon.assert.calledOnce(requirePackageJson)
    for (const call of onrequire.getCalls()) assert.strictEqual(call.args[3], '1.0.0')
  })

  it('keeps versions separate for different package installations', () => {
    requirePackageJson.withArgs('/first/test-package').returns({ version: '1.0.0' })
    requirePackageJson.withArgs('/second/test-package').returns({ version: '2.0.0' })
    const onrequire = sinon.stub().returnsArg(0)
    Hook(['test-package'], onrequire)
    const hook = ritm.args[0][2]

    hook({}, 'test-package/first', '/first/test-package')
    hook({}, 'test-package/first', '/second/test-package')
    hook({}, 'test-package/second', '/first/test-package')
    hook({}, 'test-package/second', '/second/test-package')

    assert.deepStrictEqual(onrequire.getCalls().map(call => call.args[3]), ['1.0.0', '2.0.0', '1.0.0', '2.0.0'])
    sinon.assert.calledTwice(requirePackageJson)
  })

  it('retries version lookup after a package metadata read fails', () => {
    requirePackageJson.onFirstCall().throws(new Error('metadata unavailable'))
    const onrequire = sinon.stub().returnsArg(0)
    Hook(['test-package'], onrequire)
    const hook = ritm.args[0][2]
    const first = {}

    assert.strictEqual(hook(first, 'test-package/first', '/test-package'), first)
    sinon.assert.notCalled(onrequire)
    hook({}, 'test-package/second', '/test-package')
    hook({}, 'test-package/third', '/test-package')

    sinon.assert.calledTwice(requirePackageJson)
    assert.deepStrictEqual(onrequire.getCalls().map(call => call.args[3]), ['1.0.0', '1.0.0'])
  })

  it('resolves package versions again for a new hook', () => {
    const onrequire = sinon.stub().returnsArg(0)
    Hook(['test-package'], onrequire)
    ritm.args[0][2]({}, 'test-package/first', '/test-package')
    requirePackageJson.returns({ version: '2.0.0' })
    Hook(['test-package'], onrequire)
    ritm.args[1][2]({}, 'test-package/first', '/test-package')

    assert.deepStrictEqual(onrequire.getCalls().map(call => call.args[3]), ['1.0.0', '2.0.0'])
    sinon.assert.calledTwice(requirePackageJson)
  })

  for (const first of ['cjs', 'esm']) {
    it(`clears versions after loading becomes idle, starting with ${first}`, () => {
      const onrequire = sinon.stub().returnsArg(0)
      Hook(['test-package'], onrequire)
      const hooks = { cjs: ritm.args[0][2], esm: iitm.args[0][2] }
      const second = first === 'cjs' ? 'esm' : 'cjs'

      hooks[first]({}, 'test-package/first', '/test-package')
      requirePackageJson.returns({ version: '2.0.0' })
      for (let i = 0; i < 4; i++) {
        clock.tick(500)
        hooks[second]({}, `test-package/file-${i}`, '/test-package')
      }
      clock.tick(999)
      hooks[first]({}, 'test-package/before-expiry', '/test-package')
      sinon.assert.calledOnce(requirePackageJson)
      assert.ok(onrequire.getCalls().every(call => call.args[3] === '1.0.0'))

      clock.tick(1000)
      hooks[second]({}, 'test-package/after-expiry', '/test-package')
      assert.strictEqual(onrequire.lastCall.args[3], '2.0.0')
      sinon.assert.calledTwice(requirePackageJson)

      requirePackageJson.returns({ version: '3.0.0' })
      clock.tick(1000)
      hooks[first]({}, 'test-package/after-second-expiry', '/test-package')
      assert.strictEqual(onrequire.lastCall.args[3], '3.0.0')
      sinon.assert.calledThrice(requirePackageJson)
      sinon.assert.callCount(schedule, 3)
      for (const call of schedule.getCalls()) assert.strictEqual(call.returnValue.hasRef(), false)
    })
  }

  it('keeps instrumentation active with browser-style global timers', () => {
    const globalTimeout = sinon.stub(globalThis, 'setTimeout').returns(1)
    const onrequire = sinon.stub().returnsArg(0)
    Hook(['test-package'], onrequire)
    const hook = ritm.args[0][2]

    hook({}, 'test-package/first', '/test-package')
    requirePackageJson.returns({ version: '2.0.0' })
    clock.tick(500)
    hook({}, 'test-package/second', '/test-package')
    clock.tick(999)
    hook({}, 'test-package/before-expiry', '/test-package')
    clock.tick(1000)
    hook({}, 'test-package/after-expiry', '/test-package')

    sinon.assert.notCalled(globalTimeout)
    assert.deepStrictEqual(onrequire.getCalls().map(call => call.args[3]), ['1.0.0', '1.0.0', '1.0.0', '2.0.0'])
  })

  it('does not schedule cache cleanup for unused hooks, builtins, or supplied versions', () => {
    const onrequire = sinon.stub().returnsArg(0)
    Hook(['test-package'], onrequire)
    assert.strictEqual(clock.countTimers(), 0)

    ritm.args[0][2]({}, 'test-package/first', '/test-package', '1.0.0')
    Hook(['url'], onrequire)
    ritm.args[1][2]({}, 'url', undefined)

    sinon.assert.notCalled(requirePackageJson)
    assert.strictEqual(clock.countTimers(), 0)
  })

  it('does not read ESM exports from a CommonJS hook result', () => {
    const onrequire = sinon.stub()

    Hook(['test-package'], onrequire)

    const hook = ritm.args[0][2]
    assert.strictEqual(hook(undefined, 'test-package', '/test-package', '1.0.0'), undefined)
    sinon.assert.calledOnceWithExactly(onrequire, undefined, 'test-package', '/test-package', '1.0.0', undefined)
  })

  it('rebinds named aliases on the ESM namespace', () => {
    const original = sinon.stub()
    const wrapped = sinon.stub()
    const namespace = {
      default: original,
      named: original,
    }
    const onrequire = sinon.stub()
    onrequire.withArgs(original).returns(wrapped)
    onrequire.withArgs(namespace).returns(wrapped)

    Hook(['test-package'], onrequire)

    const hook = iitm.args[0][2]
    assert.strictEqual(hook(namespace, 'test-package', '/test-package'), wrapped)
    assert.strictEqual(namespace.named, wrapped)
    assert.strictEqual(wrapped.default, wrapped)
  })

  it('wraps a builtin once and mirrors the result onto its named ESM exports', () => {
    const original = sinon.stub()
    const wrapped = sinon.stub()
    const cjsExports = { parse: original }
    const namespace = { default: cjsExports, parse: original }
    const onrequire = sinon.stub().callsFake(() => {
      cjsExports.parse = wrapped
      return cjsExports
    })

    Hook(['url'], onrequire)

    const hook = iitm.args[0][2]
    assert.strictEqual(hook(namespace, 'url', undefined), namespace)
    assert.strictEqual(namespace.parse, wrapped)
    sinon.assert.calledOnceWithExactly(onrequire, cjsExports, 'url', undefined, process.version, true)
  })

  it('leaves a builtin export the ESM view does not carry', () => {
    const cjsExports = { parse: sinon.stub() }
    const namespace = { default: cjsExports }
    const onrequire = sinon.stub().returns(cjsExports)

    Hook(['url'], onrequire)

    const hook = iitm.args[0][2]
    assert.strictEqual(hook(namespace, 'url', undefined), namespace)
    assert.deepStrictEqual(Object.keys(namespace), ['default'])
  })

  it('mirrors an accessor-backed builtin export, as `replaceGetter` leaves behind', () => {
    const wrapped = sinon.stub()
    const cjsExports = {}
    Object.defineProperty(cjsExports, 'opendir', { get: () => wrapped, enumerable: true, configurable: true })
    const namespace = { default: cjsExports, opendir: sinon.stub() }
    const onrequire = sinon.stub().returns(cjsExports)

    Hook(['fs'], onrequire)

    const hook = iitm.args[0][2]
    assert.strictEqual(hook(namespace, 'fs', undefined), namespace)
    assert.strictEqual(namespace.opendir, wrapped)
  })

  it('leaves electron to the regular hook, since it is not a Node builtin', () => {
    const cjsExports = { app: sinon.stub() }
    const namespace = { default: cjsExports, app: cjsExports.app }
    const onrequire = sinon.stub().returns(cjsExports)

    Hook(['electron'], onrequire)

    const hook = iitm.args[0][2]
    assert.strictEqual(hook(namespace, 'electron', undefined), cjsExports)
    sinon.assert.calledTwice(onrequire)
  })

  it('rebinds a builtin ESM view when the hook replaces the default export', () => {
    const original = sinon.stub()
    const replacement = { parse: sinon.stub() }
    const cjsExports = { parse: original }
    const namespace = { default: cjsExports, parse: original }
    const onrequire = sinon.stub().returns(replacement)

    Hook(['url'], onrequire)

    const hook = iitm.args[0][2]
    assert.strictEqual(hook(namespace, 'url', undefined), namespace)
    assert.strictEqual(namespace.default, replacement)
    assert.strictEqual(namespace.parse, replacement.parse)
  })

  it('does not inspect named ESM exports when the default export is unchanged', () => {
    const original = sinon.stub()
    const ownKeys = sinon.stub().returns(['default', 'named'])
    const namespace = new Proxy({
      default: original,
      named: original,
    }, { ownKeys })
    const onrequire = sinon.stub()
    onrequire.withArgs(original).returns(original)
    onrequire.withArgs(namespace).returns(namespace)

    Hook(['test-package'], onrequire)

    const hook = iitm.args[0][2]
    assert.strictEqual(hook(namespace, 'test-package', '/test-package'), namespace)
    sinon.assert.notCalled(ownKeys)
  })
})

describe('Hook idle cleanup', () => {
  it('releases the request store after a lazy package load becomes idle', async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      '--expose-gc', require.resolve('../fixtures/hook-version-cache'),
    ], { timeout: 4000 })
    assert.strictEqual(stdout, 'collected\n')
  })
})
