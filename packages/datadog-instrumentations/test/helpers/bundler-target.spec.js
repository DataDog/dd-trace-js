'use strict'

const assert = require('node:assert/strict')

const { afterEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire').noCallThru().noPreserveCache()
const sinon = require('sinon')

describe('bundler target', () => {
  afterEach(() => {
    sinon.restore()
  })

  it('recognizes package aliases registered by shared hook owners', () => {
    const hooks = require('../../src/helpers/hooks')
    const instrumentations = {
      '@nats-io/transport-node': [{}],
      'jest-each': [{}],
    }
    const getPackageDetails = sinon.stub()
    getPackageDetails.onFirstCall().returns(createPackageDetails('jest-each'))
    getPackageDetails.onSecondCall().returns(createPackageDetails('@nats-io/transport-node'))
    const jestLoad = sinon.spy(hooks, 'jest-each')
    const natsLoad = sinon.spy(hooks, '@nats-io/transport-node')
    const target = loadTarget(hooks, instrumentations, getPackageDetails)

    assert.strictEqual(target.isPackageOfInterest('jest-each'), true)
    assert.strictEqual(target.isPackageOfInterest('@nats-io/transport-node'), true)
    assert.strictEqual(target.getBundlerTarget('jest-each', 'file:///jest-each/index.js').package, 'jest-each')
    assert.strictEqual(
      target.getBundlerTarget('@nats-io/transport-node', 'file:///transport-node/index.js').package,
      '@nats-io/transport-node'
    )
    sinon.assert.calledOnce(jestLoad)
    sinon.assert.calledOnce(natsLoad)
  })

  it('loads only the hook for a resolved package', () => {
    const instrumentations = {}
    const load = sinon.stub().callsFake(() => {
      instrumentations.ai = [{}]
    })
    const getPackageDetails = sinon.stub().returns({
      name: 'ai',
      packageJsonUrl: 'file:///app/node_modules/ai/package.json',
      packageUrl: 'file:///app/node_modules/ai/',
      path: 'index.js',
      type: 'module',
      version: '1.0.0',
    })
    const target = loadTarget({ ai: load }, instrumentations, getPackageDetails)

    assert.strictEqual(target.isPackageOfInterest('ai/subpath'), true)
    assert.strictEqual(target.isPackageOfInterest('unmatched'), false)
    sinon.assert.notCalled(load)

    assert.deepStrictEqual(target.getBundlerTarget('ai', 'file:///app/node_modules/ai/index.js'), {
      format: 'module',
      moduleName: 'ai',
      package: 'ai',
      path: 'index.js',
      url: 'file:///app/node_modules/ai/index.js',
      version: '1.0.0',
    })
    target.getBundlerTargetByPath('file:///app/node_modules/ai/internal.js')

    sinon.assert.calledOnce(load)
  })

  it('normalizes builtin names before loading their hook', () => {
    const instrumentations = {}
    const load = sinon.stub().callsFake(() => {
      instrumentations.fs = [{}]
    })
    const getPackageDetails = sinon.stub()
    const target = loadTarget({ fs: load }, instrumentations, getPackageDetails)

    assert.deepStrictEqual(target.getBundlerTarget('node:fs', 'node:fs'), {
      format: 'builtin',
      moduleName: 'node:fs',
      package: 'fs',
      path: '',
      url: 'node:fs',
      version: undefined,
    })

    sinon.assert.calledOnce(load)
    sinon.assert.notCalled(getPackageDetails)
  })
})

/**
 * @param {object} hooks
 * @param {object} instrumentations
 * @param {Function} getPackageDetails
 * @returns {object}
 */
function loadTarget (hooks, instrumentations, getPackageDetails) {
  return proxyquire('../../src/helpers/bundler-target', {
    'import-in-the-middle/bundler': {
      getNodeModuleFormat: () => 'module',
      getPackageDetails,
    },
    './hooks': hooks,
    './instrumentation-utils': {
      matchesInstrumentation: () => true,
    },
    './instrumentations': instrumentations,
  })
}

/**
 * @param {string} name
 * @returns {object}
 */
function createPackageDetails (name) {
  return {
    name,
    packageJsonUrl: `file:///${name}/package.json`,
    packageUrl: `file:///${name}/`,
    path: 'index.js',
    type: 'commonjs',
    version: '1.0.0',
  }
}
