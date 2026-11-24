'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const {
  generateRewriterTargetPatterns,
  generateRewriterTargets,
  OUTPUT_PATH,
  PATTERN_OUTPUT_PATH,
} = require('../../../../../scripts/generate-rewriter-targets')
const { instrumentations } = require('../../../src/helpers/rewriter/instrumentation-registry')
const { isRewriteActivationEnabled, getRewriteTarget } = require('../../../src/helpers/rewriter/targets')
const targets = require('../../../src/helpers/rewriter/targets.json')
const { getUnusedPackageName } = require('../get-unused-package-name')

const unusedPackageName = getUnusedPackageName(Object.values(targets))

describe('rewriter targets', () => {
  it('stays in sync with the instrumentation descriptors', () => {
    assert.strictEqual(
      readFileSync(OUTPUT_PATH, 'utf8').replaceAll('\r\n', '\n'),
      generateRewriterTargets()
    )
    assert.strictEqual(
      readFileSync(PATTERN_OUTPUT_PATH, 'utf8').replaceAll('\r\n', '\n'),
      generateRewriterTargetPatterns()
    )
  })

  it('rejects unanchored and stateful rewrite patterns', () => {
    const targetModule = { name: 'test-pattern', filePath: /path/ }
    instrumentations.push({ module: targetModule })
    try {
      for (const filePath of [/path/, /^path/, /path$/, /^path$/g]) {
        targetModule.filePath = filePath
        assert.throws(generateRewriterTargetPatterns, /unanchored or stateful file pattern/)
      }
    } finally {
      instrumentations.pop()
    }
  })

  it('reports stale generated patterns from its command entry point', () => {
    const script = join(__dirname, '../../../../../scripts/generate-rewriter-targets.js')
    const preload = join(__dirname, 'fixtures/stale-target-patterns.js')
    const result = spawnSync(process.execPath, ['--require', preload, script, '--check'], { encoding: 'utf8' })

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /The generated rewriter metadata is out of date/)
    assert.match(result.stderr, /target-patterns\.json/)
  })

  it('finds hashed source targets without accepting unrelated chunks', () => {
    assert.deepStrictEqual(
      getRewriteTarget('file:///app/node_modules/react-router/dist/development/chunk-JG3XND5A.mjs'),
      {
        moduleName: 'react-router',
        filePath: 'dist/development/chunk-JG3XND5A.mjs',
        activate: true,
        sourceMatch: 'function derive(',
      }
    )
    assert.strictEqual(
      getRewriteTarget('file:///app/node_modules/react-router/dist/development/chunk-invalid.mjs'),
      undefined
    )
    assert.strictEqual(
      getRewriteTarget('file:///app/node_modules/react-router-extra/dist/development/chunk-JG3XND5A.mjs'),
      undefined
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

  it('finds package-scoped hashed rewrite targets', () => {
    assert.deepStrictEqual(
      getRewriteTarget('file:///app/node_modules/outer/node_modules/@trpc/server/dist/initTRPC-B7UdX-c3.cjs'),
      {
        moduleName: '@trpc/server',
        filePath: 'dist/initTRPC-B7UdX-c3.cjs',
        activate: true,
      }
    )
    assert.deepStrictEqual(
      getRewriteTarget('file:///app/node_modules/@trpc/server/dist/initTRPC-B259os3T.mjs'),
      {
        moduleName: '@trpc/server',
        filePath: 'dist/initTRPC-B259os3T.mjs',
        activate: true,
      }
    )
    for (const filePath of [
      'dist/index.js',
      'dist/index.mjs',
      'dist/unstable-core-do-not-import/procedureBuilder.js',
      'dist/unstable-core-do-not-import/procedureBuilder.mjs',
      'dist/initTRPC-DjEpHmY2.cjs',
      'dist/initTRPC-BEdPeHRQ.cjs',
      'dist/initTRPC-_cqIfGlH.cjs',
      'dist/initTRPC-COaJMShh.mjs',
      'dist/initTRPC-BRf4imah.mjs',
      'dist/initTRPC-AbC012_x.cjs',
      'dist/initTRPC-XyZ987_a.mjs',
    ]) {
      assert.deepStrictEqual(getRewriteTarget(`file:///app/node_modules/@trpc/server/${filePath}`), {
        moduleName: '@trpc/server',
        filePath,
        activate: true,
      })
    }
    assert.strictEqual(
      getRewriteTarget('file:///app/node_modules/other/dist/initTRPC-B7UdX-c3.cjs'),
      undefined
    )
    assert.strictEqual(
      getRewriteTarget('file:///app/node_modules/@trpc/server/dist/initTRPC-B7UdX-c3.cjs.map'),
      undefined
    )
    assert.strictEqual(
      getRewriteTarget('file:///app/node_modules/@trpc/server/dist/initTRPC-.cjs'),
      undefined
    )
  })

  it('finds tRPC HTTP handler and metadata rewrite targets', () => {
    for (const filePath of [
      'dist/nodeHTTPRequestHandler-ad3e4860.js',
      'dist/nodeHTTPRequestHandler-97af83bc.mjs',
      'dist/resolveHTTPResponse-b7a8a1c9.js',
      'dist/resolveHTTPResponse-2fc435bb.mjs',
      'dist/adapters/node-http/nodeHTTPRequestHandler.js',
      'dist/adapters/node-http/nodeHTTPRequestHandler.mjs',
      'dist/unstable-core-do-not-import/http/contentType.js',
      'dist/unstable-core-do-not-import/http/contentType.mjs',
      'dist/node-http-CikCqjt6.cjs',
      'dist/node-http-BUlb5EdB.mjs',
      'dist/resolveResponse-DLpzHrPG.cjs',
      'dist/resolveResponse-JtMyT9TQ.mjs',
      'dist/node-http-AbC012_x.cjs',
      'dist/node-http-XyZ987_a.mjs',
      'dist/resolveResponse-AbC012_x.cjs',
      'dist/resolveResponse-XyZ987_a.mjs',
    ]) {
      assert.deepStrictEqual(getRewriteTarget(`file:///app/node_modules/@trpc/server/${filePath}`), {
        moduleName: '@trpc/server',
        filePath,
        activate: true,
      })
    }
    assert.strictEqual(getRewriteTarget('file:///app/node_modules/other/dist/node-http-AbC012_x.cjs'), undefined)
    assert.strictEqual(getRewriteTarget('file:///app/node_modules/@trpc/server/dist/node-http-.cjs'), undefined)
    assert.strictEqual(getRewriteTarget('file:///app/node_modules/@trpc/server/dist/resolveResponse-a.cjs.map'), undefined)
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
    assert.strictEqual(getRewriteTarget('file:///app/node_modules/@trpc/server'), undefined)
  })
})
