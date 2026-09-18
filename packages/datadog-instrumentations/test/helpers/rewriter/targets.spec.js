'use strict'

const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')

const { generateRewriterTargets, OUTPUT_PATH } = require('../../../../../scripts/generate-rewriter-targets')
const hooks = require('../../../src/helpers/hooks')
const { getRewriteTarget } = require('../../../src/helpers/rewriter/targets')
const targets = require('../../../src/helpers/rewriter/targets.json')

describe('rewriter targets', () => {
  it('stays in sync with the instrumentation descriptors', () => {
    assert.strictEqual(
      readFileSync(OUTPUT_PATH, 'utf8').replaceAll('\r\n', '\n'),
      generateRewriterTargets()
    )
  })

  it('has an activation hook for every rewrite target package', () => {
    for (const name of new Set(Object.values(targets))) {
      assert.equal(typeof (hooks[name]?.fn ?? hooks[name]), 'function', name)
    }
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
