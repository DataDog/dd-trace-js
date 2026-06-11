'use strict'

const assert = require('node:assert/strict')

const { afterEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../setup/core')

describe('CiPlugin', () => {
  let plugin

  afterEach(() => {
    plugin?.configure(false)
    sinon.restore()
  })

  it('uses cwd as repository root for worker exporters that skip git metadata extraction', () => {
    const { TestCiPlugin, getRepositoryRoot, getTestEnvironmentMetadata } = getCiPlugin()

    plugin = new TestCiPlugin({ _exporter: {} }, {})
    plugin.configure({
      enabled: true,
      experimental: {
        exporter: 'vitest_worker',
      },
    })

    assert.strictEqual(plugin.repositoryRoot, process.cwd())
    sinon.assert.notCalled(getRepositoryRoot)
    sinon.assert.calledWith(getTestEnvironmentMetadata, 'vitest', sinon.match.object, true)
  })

  it('uses git repository root discovery for non-worker exporters', () => {
    const { TestCiPlugin, getRepositoryRoot, getTestEnvironmentMetadata } = getCiPlugin()

    plugin = new TestCiPlugin({ _exporter: {} }, {})
    plugin.configure({
      enabled: true,
      experimental: {
        exporter: 'datadog',
      },
    })

    assert.strictEqual(plugin.repositoryRoot, '/repository-root')
    sinon.assert.calledOnce(getRepositoryRoot)
    sinon.assert.calledWith(getTestEnvironmentMetadata, 'vitest', sinon.match.object, undefined)
  })
})

function getCiPlugin () {
  const getRepositoryRoot = sinon.stub().returns('/repository-root')
  const getTestEnvironmentMetadata = sinon.stub().returns({})

  const CiPlugin = proxyquire('../../src/plugins/ci_plugin', {
    './util/git': {
      getRepositoryRoot,
    },
    './util/test': {
      getCodeOwnersFileEntries: sinon.stub().returns(null),
      getTestEnvironmentMetadata,
    },
  })

  class TestCiPlugin extends CiPlugin {
    static id = 'vitest'
  }

  return { TestCiPlugin, getRepositoryRoot, getTestEnvironmentMetadata }
}
