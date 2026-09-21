'use strict'

const assert = require('node:assert/strict')
const { join, resolve } = require('node:path')
const { pathToFileURL } = require('node:url')

const { beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

const DC_MODULE = '/absolute/dc-polyfill.js'
const REWRITTEN = 'module.exports = rewritten\n'
const SOURCE = 'module.exports = original\n'
const TARGET = { moduleName: 'bullmq', filePath: 'dist/cjs/classes/queue.js' }
const BASE_DIR = resolve('/base/node_modules/bullmq')
const TARGETED_PATH = resolve('/base/node_modules/bullmq/dist/cjs/classes/queue.js')
// The target segment is percent encoded and carries a query and a fragment so
// that only a real file URL conversion can discover the rewrite target.
const TARGETED_URL = pathToFileURL(TARGETED_PATH).href.replace(/queue\.js$/, '%71ueue.js?query=1#hash')
const VERSION = '5.66.0'
const ENTRYPOINTS = ['rewrite', 'bundler']

describe('rewriter path handling', () => {
  let rewriter
  let readFileSync
  let logError
  let getTransformer
  let transform
  let packageJson

  beforeEach(() => {
    packageJson = JSON.stringify({ version: VERSION })
    transform = sinon.stub().returns({ code: REWRITTEN })
    getTransformer = sinon.stub().returns({ transform })
    logError = sinon.stub()
    readFileSync = sinon.stub().callsFake(filename => {
      if (packageJson !== undefined && filename.replaceAll('\\', '/').endsWith('/node_modules/bullmq/package.json')) {
        return packageJson
      }

      const error = new Error(`ENOENT: no such file or directory, open '${filename}'`)
      error.code = 'ENOENT'
      throw error
    })

    rewriter = proxyquire('../../../src/helpers/rewriter', {
      'node:fs': { readFileSync, '@noCallThru': true },
      '../../../../dd-trace/src/log': { error: logError, '@noCallThru': true },
      '../../../../../vendor/dist/@apm-js-collab/code-transformer': {
        create: sinon.stub().returns({ addTransform: sinon.stub(), getTransformer }),
        '@noCallThru': true,
      },
    })
  })

  /**
   * @param {'rewrite'|'bundler'} entry
   * @param {string|Buffer} content
   * @param {string} filename
   * @param {{ moduleName: string, filePath: string }|undefined} [target]
   * @param {object|undefined} [sourceMap]
   */
  function callRewrite (entry, content, filename, target, sourceMap) {
    if (entry === 'rewrite') {
      return rewriter.rewrite(content, filename, 'commonjs', target)
    }

    const rewriteBundled = rewriter.createBundlerRewriter(DC_MODULE)

    return rewriteBundled(content, filename, 'commonjs', target, sourceMap)
  }

  /**
   * @param {'rewrite'|'bundler'} entry
   * @param {unknown} result
   * @param {string|Buffer} content
   * @param {object|undefined} sourceMap
   */
  function assertUnchanged (entry, result, content, sourceMap) {
    if (entry === 'rewrite') {
      assert.strictEqual(result, content)
    } else {
      assert.strictEqual(result.code, content)
      assert.strictEqual(result.map, sourceMap)
    }
  }

  /**
   * @param {'rewrite'|'bundler'} entry
   * @param {unknown} result
   */
  function assertRewritten (entry, result) {
    if (entry === 'rewrite') {
      assert.strictEqual(result, REWRITTEN)
    } else {
      assert.strictEqual(result.code, REWRITTEN)
      assert.strictEqual(result.map, undefined)
    }
  }

  /** @param {string} baseDir */
  function assertVersionResolved (baseDir) {
    assert.strictEqual(readFileSync.callCount, 1)
    assert.strictEqual(
      readFileSync.firstCall.args[0].replaceAll('\\', '/'),
      join(baseDir, 'package.json').replaceAll('\\', '/')
    )
    assert.ok(getTransformer.alwaysCalledWithExactly('bullmq', VERSION, 'dist/cjs/classes/queue.js'))
  }

  /** @param {object} sourceMap */
  function assertTransformReceivedSourceAndMap (sourceMap) {
    assert.deepStrictEqual(transform.firstCall.args, [SOURCE, 'cjs'])
    assert.deepStrictEqual(transform.secondCall.args, [SOURCE, 'cjs', sourceMap])
  }

  function assertFailSafeOverEntryPoints () {
    for (const entry of ENTRYPOINTS) {
      const content = Buffer.from(SOURCE)
      const sourceMap = { version: 3, mappings: '' }

      logError.resetHistory()
      const result = callRewrite(entry, content, TARGETED_PATH, TARGET, sourceMap)

      assertUnchanged(entry, result, content, sourceMap)
      sinon.assert.calledOnce(logError)
      assert.ok(logError.firstCall.args[0] instanceof Error)
    }
  }

  describe('file URL conversion', () => {
    it('converts a file URL before automatic target discovery', () => {
      const sourceMap = { version: 3, mappings: '' }

      for (const entry of ENTRYPOINTS) {
        assertRewritten(entry, callRewrite(entry, SOURCE, TARGETED_URL, undefined, sourceMap))
      }

      assertVersionResolved(BASE_DIR)
      assertTransformReceivedSourceAndMap(sourceMap)
    })
  })

  describe('windows path normalization', () => {
    const cases = [
      {
        name: 'drive letter paths',
        filename: 'C:\\project\\node_modules\\bullmq\\dist\\cjs\\classes\\queue.js',
        baseDir: 'C:/project/node_modules/bullmq',
      },
      {
        name: 'UNC paths',
        filename: '\\\\server\\share\\node_modules\\bullmq\\dist\\cjs\\classes\\queue.js',
        baseDir: '//server/share/node_modules/bullmq',
      },
      {
        name: 'mixed separators',
        filename: 'C:\\project/node_modules\\bullmq/dist\\cjs\\classes\\queue.js',
        baseDir: 'C:/project/node_modules/bullmq',
      },
    ]

    for (const { name, filename, baseDir } of cases) {
      it(`discovers targets and resolves versions in ${name}`, () => {
        const sourceMap = { version: 3, mappings: '' }

        for (const entry of ENTRYPOINTS) {
          assertRewritten(entry, callRewrite(entry, SOURCE, filename, undefined, sourceMap))
        }

        assertVersionResolved(baseDir)
      })
    }
  })

  describe('unavailable version', () => {
    const failures = [
      { name: 'a missing package.json', pkg: undefined },
      { name: 'malformed package.json content', pkg: '{ not json' },
      { name: 'a package.json without a version', pkg: '{"name":"bullmq"}' },
    ]

    for (const withExplicitTarget of [false, true]) {
      const target = withExplicitTarget ? TARGET : undefined

      describe(withExplicitTarget ? 'with an explicit target' : 'with automatic target discovery', () => {
        for (const { name, pkg } of failures) {
          it(`returns the original code and map without consulting the matcher on ${name}`, () => {
            packageJson = pkg
            const content = Buffer.from(SOURCE)
            const sourceMap = { version: 3, mappings: '' }

            for (const entry of ENTRYPOINTS) {
              assertUnchanged(entry, callRewrite(entry, content, TARGETED_PATH, target, sourceMap), content, sourceMap)
            }

            assert.ok(readFileSync.called)
            assert.strictEqual(getTransformer.callCount, 0)
            assert.ok(logError.notCalled)
          })
        }
      })
    }
  })

  describe('malformed file URLs', () => {
    const invalidUrls = [
      {
        name: 'a malformed percent escape',
        url: TARGETED_URL.replace('file:///', 'file:///%ZZ/'),
      },
      {
        name: 'an encoded path separator',
        url: TARGETED_URL.replace('file:///', 'file:///%2F/'),
      },
    ]

    if (process.platform !== 'win32') {
      invalidUrls.push({
        name: 'a non-local hostname',
        url: TARGETED_URL.replace('file:///', 'file://remotehost/'),
      })
    }

    for (const { name, url } of invalidUrls) {
      it(`never escapes ${name}`, () => {
        for (const entry of ENTRYPOINTS) {
          for (const withExplicitTarget of [false, true]) {
            const content = Buffer.from(SOURCE)
            const sourceMap = { version: 3, mappings: '' }

            logError.resetHistory()
            const result = callRewrite(entry, content, url, withExplicitTarget ? TARGET : undefined, sourceMap)

            assertUnchanged(entry, result, content, sourceMap)
            sinon.assert.calledOnce(logError)
            assert.ok(logError.firstCall.args[0] instanceof Error)
          }
        }

        assert.ok(readFileSync.notCalled)
        assert.strictEqual(getTransformer.callCount, 0)
      })
    }
  })

  describe('available version', () => {
    it('rewrites an automatically discovered target from a plain path', () => {
      const sourceMap = { version: 3, mappings: '' }

      for (const entry of ENTRYPOINTS) {
        assertRewritten(entry, callRewrite(entry, SOURCE, TARGETED_PATH, undefined, sourceMap))
      }

      assertVersionResolved(BASE_DIR)
      assertTransformReceivedSourceAndMap(sourceMap)
    })

    it('rewrites a file URL with an explicit target', () => {
      const sourceMap = { version: 3, mappings: '' }

      for (const entry of ENTRYPOINTS) {
        assertRewritten(entry, callRewrite(entry, SOURCE, TARGETED_URL, TARGET, sourceMap))
      }

      assertVersionResolved(BASE_DIR)
      assertTransformReceivedSourceAndMap(sourceMap)
    })

    it('passes the caller source map through the bundler transformer', () => {
      const transformedMap = { version: 3, mappings: 'IAAg' }
      transform.returns({ code: REWRITTEN, map: transformedMap })
      const sourceMap = { version: 3, mappings: 'AAAA' }

      const result = callRewrite('bundler', SOURCE, TARGETED_PATH, TARGET, sourceMap)

      assert.deepStrictEqual(result, { code: REWRITTEN, map: transformedMap })
      assert.deepStrictEqual(transform.firstCall.args, [SOURCE, 'cjs', sourceMap])
    })
  })

  describe('matcher and transformer failures', () => {
    it('returns the original code and map when the matcher throws', () => {
      getTransformer.throws(new Error('matcher failed'))

      assertFailSafeOverEntryPoints()
    })

    it('returns the original code and map when the transformer throws', () => {
      transform.throws(new Error('transform failed'))

      assertFailSafeOverEntryPoints()
    })
  })
})
