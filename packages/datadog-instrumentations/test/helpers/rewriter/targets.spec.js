'use strict'

const assert = require('node:assert/strict')

const instrumentations = require('../../../src/helpers/rewriter/instrumentations')
const { getRewriteTarget } = require('../../../src/helpers/rewriter/targets')
const targets = require('../../../src/helpers/rewriter/targets.json')

describe('rewriter targets', () => {
  it('matches the instrumentation descriptors', () => {
    const expectedTargets = {}

    for (const { module: { name, filePath } } of instrumentations) {
      expectedTargets[`${name}/${filePath}`] = name
    }

    assert.deepStrictEqual(targets, expectedTargets)
  })

  it('finds nested rewrite targets', () => {
    assert.deepStrictEqual(
      getRewriteTarget('file:///app/node_modules/outer/node_modules/@langchain/core/dist/embeddings.js'),
      {
        moduleName: '@langchain/core',
        filePath: 'dist/embeddings.js',
      }
    )
  })

  it('ignores application files and dependencies without targets', () => {
    assert.strictEqual(getRewriteTarget('file:///app/index.mjs'), undefined)
    assert.strictEqual(getRewriteTarget('file:///app/node_modules/example/index.mjs'), undefined)
    assert.strictEqual(getRewriteTarget('file:///app/not-node_modules/ai/dist/index.mjs'), undefined)
    assert.strictEqual(getRewriteTarget('file:///app/node_modules/toString'), undefined)
  })
})
