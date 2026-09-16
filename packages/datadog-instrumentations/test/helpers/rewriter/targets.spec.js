'use strict'

const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')

const { generateRewriterTargets, OUTPUT_PATH } = require('../../../../../scripts/generate-rewriter-targets')
const { getRewriteActivationName, getRewriteTarget } = require('../../../src/helpers/rewriter/targets')

describe('rewriter targets', () => {
  it('stays in sync with the instrumentation descriptors', () => {
    assert.strictEqual(
      readFileSync(OUTPUT_PATH, 'utf8').replaceAll('\r\n', '\n'),
      generateRewriterTargets()
    )
  })

  it('finds nested rewrite targets', () => {
    assert.deepStrictEqual(
      getRewriteTarget('file:///app/node_modules/outer/node_modules/@langchain/core/dist/embeddings.js'),
      {
        moduleName: '@langchain/core',
        filePath: 'dist/embeddings.js',
        activationName: '@langchain/core',
      }
    )
  })

  it('distinguishes rewrite-activated integrations from hybrid rewrite targets', () => {
    assert.equal(getRewriteActivationName('@langchain/core'), '@langchain/core')
    assert.equal(getRewriteActivationName('@wdio/runner'), undefined)
    assert.deepStrictEqual(
      getRewriteTarget('file:///app/node_modules/@wdio/runner/build/index.js'),
      { moduleName: '@wdio/runner', filePath: 'build/index.js' }
    )
  })

  it('ignores application files and dependencies without targets', () => {
    assert.strictEqual(getRewriteTarget('file:///app/index.mjs'), undefined)
    assert.strictEqual(getRewriteTarget('file:///app/node_modules/example/index.mjs'), undefined)
    assert.strictEqual(getRewriteTarget('file:///app/not-node_modules/ai/dist/index.mjs'), undefined)
    assert.strictEqual(getRewriteTarget('file:///app/node_modules/toString'), undefined)
  })
})
