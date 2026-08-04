'use strict'

const assert = require('node:assert/strict')

const proxyquire = require('proxyquire').noCallThru()
const sinon = require('sinon')

describe('Hook', () => {
  let Hook
  let iitm
  let loaderState
  let ritm

  beforeEach(() => {
    iitm = sinon.stub()
    loaderState = { syncCommonJsHooks: false }
    ritm = sinon.stub()
    Hook = proxyquire('../../src/helpers/hook', {
      '../../../dd-trace/src/loader-state': loaderState,
      '../../../dd-trace/src/iitm': iitm,
      '../../../dd-trace/src/require-package-json': sinon.stub().returns({ version: '1.0.0' }),
      '../../../dd-trace/src/ritm': ritm,
    })
  })

  afterEach(() => {
    sinon.restore()
  })

  it('does not read ESM exports from a CommonJS hook result', () => {
    const onrequire = sinon.stub()

    Hook(['test-package'], onrequire)

    const hook = ritm.args[0][2]
    assert.strictEqual(hook(undefined, 'test-package', '/test-package', '1.0.0'), undefined)
    sinon.assert.calledOnceWithExactly(onrequire, undefined, 'test-package', '/test-package', '1.0.0', undefined)
  })

  it('leaves CommonJS interception to IITM when synchronous hooks own it', () => {
    loaderState.syncCommonJsHooks = true

    Hook(['test-package'], sinon.stub())

    sinon.assert.notCalled(ritm)
  })

  it('uses bundler metadata and CommonJS export semantics', () => {
    const moduleExports = { default: sinon.stub() }
    const replacement = { instrumented: true }
    const onrequire = sinon.stub().returns(replacement)

    Hook(['test-package'], onrequire)

    const hook = iitm.args[0][2]
    assert.strictEqual(
      hook(
        moduleExports,
        'test-package',
        '/test-package',
        { version: '2.0.0' },
        'commonjs'
      ),
      replacement
    )
    sinon.assert.calledOnceWithExactly(
      onrequire,
      moduleExports,
      'test-package',
      '/test-package',
      '2.0.0',
      false
    )
  })

  it('uses CommonJS export semantics for type-stripped modules', () => {
    const moduleExports = { default: sinon.stub() }
    const replacement = { instrumented: true }
    const onrequire = sinon.stub().returns(replacement)

    Hook(['test-package'], onrequire)

    const hook = iitm.args[0][2]
    assert.strictEqual(
      hook(moduleExports, 'test-package', '/test-package', undefined, 'commonjs-typescript'),
      replacement
    )
    sinon.assert.calledOnceWithExactly(
      onrequire,
      moduleExports,
      'test-package',
      '/test-package',
      '1.0.0',
      false
    )
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
