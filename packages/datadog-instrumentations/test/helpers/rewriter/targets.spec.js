'use strict'

const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')

const { generateRewriterTargets, OUTPUT_PATH } = require('../../../../../scripts/generate-rewriter-targets')
const { getRewriteTarget, isRewriteActivationEnabled } = require('../../../src/helpers/rewriter/targets')
const targets = require('../../../src/helpers/rewriter/targets.json')
const { getUnusedPackageName } = require('../get-unused-package-name')

const unusedPackageName = getUnusedPackageName(Object.values(targets))

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
        activate: true,
      }
    )
  })

  it('distinguishes rewrite-activated integrations from hybrid rewrite targets', () => {
    assert.equal(isRewriteActivationEnabled('@langchain/core'), true)
    assert.equal(isRewriteActivationEnabled('mercurius'), true)
    assert.equal(isRewriteActivationEnabled('@wdio/utils'), true)
    assert.equal(isRewriteActivationEnabled('graphql'), false)
    assert.deepStrictEqual(
      getRewriteTarget('file:///app/node_modules/@wdio/utils/build/index.js'),
      { moduleName: '@wdio/utils', filePath: 'build/index.js', activate: true }
    )
  })

  it('keeps shared WebdriverIO dependencies as rewrite-only targets', () => {
    for (const [moduleName, filePath] of [
      ['@wdio/config', 'build/node/index.js'],
      ['@wdio/runner', 'build/index.js'],
      ['webdriver', 'build/index.js'],
      ['webdriver', 'build/node.js'],
      ['jasmine-core', 'lib/jasmine-core/jasmine.js'],
    ]) {
      assert.equal(isRewriteActivationEnabled(moduleName), false)
      assert.deepStrictEqual(
        getRewriteTarget(`file:///app/node_modules/${moduleName}/${filePath}`),
        { moduleName, filePath }
      )
    }
  })

  it('ignores application files and dependencies without targets', () => {
    assert.strictEqual(getRewriteTarget('file:///app/index.mjs'), undefined)
    assert.strictEqual(getRewriteTarget(`file:///app/node_modules/${unusedPackageName}/index.mjs`), undefined)
    assert.strictEqual(getRewriteTarget('file:///app/not-node_modules/ai/dist/index.mjs'), undefined)
    assert.strictEqual(getRewriteTarget('file:///app/node_modules/toString'), undefined)
  })
})
