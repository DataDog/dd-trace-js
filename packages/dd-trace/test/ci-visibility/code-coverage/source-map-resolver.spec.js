'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  normalizeSource,
  resolveCoverageToSourceFiles,
  resetCache,
} = require('../../../src/ci-visibility/code-coverage/source-map-resolver')

function inlineMap (map) {
  return `data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString('base64')}`
}

describe('ci-visibility/code-coverage/source-map-resolver', () => {
  afterEach(() => {
    resetCache()
  })

  describe('normalizeSource', () => {
    it('normalizes source-map paths to repository-relative filenames', () => {
      const repositoryRoot = path.join('/Users', 'me', 'repo')

      assert.deepStrictEqual([
        normalizeSource('webpack:///./src/app.js', { repositoryRoot }),
        normalizeSource(`file://${repositoryRoot}/src/app.js`, { repositoryRoot }),
        normalizeSource(`${repositoryRoot}/src/app.js`, { repositoryRoot }),
        normalizeSource('/@fs/Users/me/repo/src/app.js', { repositoryRoot }),
        normalizeSource('app.js', { sourceRoot: '/src', repositoryRoot }),
        normalizeSource('app.js', {
          bundleUrl: 'http://localhost:3000/assets/bundle.js',
          mapUrl: 'http://localhost:3000/assets/bundle.js.map',
          sourceRoot: '../src',
          repositoryRoot,
        }),
        normalizeSource('../src/app.js', {
          bundleUrl: 'http://localhost:3000/assets/bundle.js',
          mapUrl: 'http://localhost:3000/assets/bundle.js.map',
          repositoryRoot,
        }),
      ], [
        'src/app.js',
        'src/app.js',
        'src/app.js',
        'src/app.js',
        'src/app.js',
        'src/app.js',
        'src/app.js',
      ])
    })
  })

  describe('resolveCoverageToSourceFiles', () => {
    it('uses script source from CDP to resolve inline source maps without refetching the bundle', async () => {
      const repositoryRoot = path.join('/Users', 'me', 'repo')
      const source = [
        'function greet(){return "hi"}',
        `//# sourceMappingURL=${inlineMap({
          version: 3,
          file: 'bundle.js',
          sources: [`file://${repositoryRoot}/src/greeting.js`],
          names: [],
          mappings: 'AAAA',
        })}`,
      ].join('\n')

      const files = await resolveCoverageToSourceFiles([{
        url: 'http://localhost:3000/assets/bundle.js',
        source,
        ranges: [0, 8],
      }], { repositoryRoot })

      assert.deepStrictEqual(files, ['src/greeting.js'])
    })

    it('falls back to URL paths only when there is no source map to resolve', async () => {
      const files = await resolveCoverageToSourceFiles([{
        url: 'http://localhost:3000/src/app.js',
        source: 'window.app = true',
        ranges: [0, 6],
      }])

      assert.deepStrictEqual(files, ['src/app.js'])
    })

    it('does not report bundle paths when a declared source map cannot be loaded', async () => {
      const source = [
        'function greet(){return "hi"}',
        '//# sourceMappingURL=data:application/json;base64,bm90LWpzb24=',
      ].join('\n')

      const files = await resolveCoverageToSourceFiles([{
        url: 'http://localhost:3000/assets/bundle.js',
        source,
        ranges: [0, 8],
      }])

      assert.deepStrictEqual(files, [])
    })
  })
})
