'use strict'

const assert = require('node:assert/strict')

const proxyquire = require('proxyquire').noCallThru()
const sinon = require('sinon')

describe('Hook', () => {
  let Hook
  let iitm
  let ritm

  beforeEach(() => {
    iitm = sinon.stub()
    ritm = sinon.stub()
    Hook = proxyquire('../../src/helpers/hook', {
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
})
