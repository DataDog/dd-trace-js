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
    const { TestCiPlugin, getCodeOwnersFileEntries, getRepositoryRoot, getTestEnvironmentMetadata } = getCiPlugin()

    plugin = new TestCiPlugin({ _exporter: {} }, {})
    plugin.configure({
      enabled: true,
      experimental: {
        exporter: 'vitest_worker',
      },
    })

    assert.strictEqual(plugin.repositoryRoot, process.cwd())
    sinon.assert.notCalled(getRepositoryRoot)
    sinon.assert.notCalled(getCodeOwnersFileEntries)
    sinon.assert.calledWith(getTestEnvironmentMetadata, 'vitest', sinon.match.object, true)
  })

  it('uses git repository root discovery for non-worker exporters', () => {
    const {
      TestCiPlugin,
      getCodeOwnersFileEntries,
      getRepositoryRoot,
      getTestEnvironmentMetadata,
    } = getCiPlugin()

    plugin = new TestCiPlugin({ _exporter: {} }, {})
    plugin.configure({
      enabled: true,
      experimental: {
        exporter: 'datadog',
      },
    })

    assert.strictEqual(plugin.repositoryRoot, '/repository-root')
    sinon.assert.calledOnce(getRepositoryRoot)
    sinon.assert.calledWith(getCodeOwnersFileEntries, '/repository-root')
    sinon.assert.calledWith(getTestEnvironmentMetadata, 'vitest', sinon.match.object, undefined)
  })

  it('uses provided CODEOWNERS entries when a worker receives the repository root', () => {
    const { TestCiPlugin, getCodeOwnersFileEntries } = getCiPlugin()
    const codeOwnersEntries = [{ pattern: 'test/*', owners: ['@datadog/test-optimization'] }]

    plugin = new TestCiPlugin({ _exporter: {} }, {})
    plugin.configure({
      enabled: true,
      experimental: {
        exporter: 'vitest_worker',
      },
    })

    plugin._setRepositoryRoot('/repository-root', codeOwnersEntries)

    assert.strictEqual(plugin.repositoryRoot, '/repository-root')
    assert.strictEqual(plugin.codeOwnersEntries, codeOwnersEntries)
    sinon.assert.notCalled(getCodeOwnersFileEntries)
  })

  it('loads CODEOWNERS entries when a worker receives the repository root without entries', () => {
    const { TestCiPlugin, getCodeOwnersFileEntries } = getCiPlugin()

    plugin = new TestCiPlugin({ _exporter: {} }, {})
    plugin.configure({
      enabled: true,
      experimental: {
        exporter: 'vitest_worker',
      },
    })

    plugin._setRepositoryRoot('/repository-root')

    assert.strictEqual(plugin.repositoryRoot, '/repository-root')
    sinon.assert.calledOnceWithExactly(getCodeOwnersFileEntries, '/repository-root')
  })
})

function getCiPlugin () {
  const getRepositoryRoot = sinon.stub().returns('/repository-root')
  const getTestEnvironmentMetadata = sinon.stub().returns({})
  const getCodeOwnersFileEntries = sinon.stub().returns([
    { pattern: '*', owners: ['@datadog/test-optimization'] },
  ])

  const CiPlugin = proxyquire('../../src/plugins/ci_plugin', {
    './util/git': {
      getRepositoryRoot,
    },
    './util/test': {
      getCodeOwnersFileEntries,
      getTestEnvironmentMetadata,
    },
  })

  class TestCiPlugin extends CiPlugin {
    static id = 'vitest'
  }

  return { TestCiPlugin, getCodeOwnersFileEntries, getRepositoryRoot, getTestEnvironmentMetadata }
}
