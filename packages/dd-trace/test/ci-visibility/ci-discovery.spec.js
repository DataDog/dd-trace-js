'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const { buildCiDiscovery } = require('../../../../ci/test-optimization-validation/ci-discovery')

describe('test optimization validation CI discovery', () => {
  it('derives inspected workflow files from selected CI command metadata', () => {
    const root = path.resolve('repo')
    const discovery = buildCiDiscovery({
      manifest: {
        repository: { root },
        frameworks: [{
          id: 'mocha:sinon',
          ciWiring: { configFile: path.join(root, '.github', 'workflows', 'test.yml') },
        }],
      },
      diagnosis: { results: [] },
    })

    assert.deepStrictEqual(discovery.found, ['.github/workflows/test.yml'])
    assert.strictEqual(discovery.method, 'framework-ci-command')
    assert.deepStrictEqual(discovery.contradictions, [])
  })
})
