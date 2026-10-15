'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')

const { afterEach, describe, it } = require('mocha')

require('./setup/core')
const {
  isEmpty,
  isTrue,
  isFalse,
  isPackageManager,
  globMatch,
  getSegment,
  stripQueryAndFragment,
  truncateString,
} = require('../src/util')

const TRUES = [
  1,
  true,
  'true',
  'TRUE',
  'tRuE',
]
const FALSES = [
  0,
  false,
  'false',
  'FALSE',
  'fAlSe',
]

const MATCH_CASES = [
  { pattern: 'foo', subject: 'foo' },
  { pattern: 'foo.*', subject: 'foo.you' },
  { pattern: 'hi*there', subject: 'hithere' },
  { pattern: '*stuff', subject: 'lots of stuff' },
  { pattern: 'test.?', subject: 'test.1' },
  { pattern: '*a*a*a*a*a*a', subject: 'aaaaaaaarrrrrrraaaraaarararaarararaarararaaa' },
]

const NONMATCH_CASES = [
  { pattern: 'foo.*', subject: 'snafoo.' },
  { pattern: 'test.?', subject: 'test.abc' },
  { pattern: '*stuff', subject: 'stuff to think about' },
  { pattern: 'test?test', subject: 'test123test' },
]

describe('util', () => {
  describe('truncateString', () => {
    it('includes the suffix in the limit', () => {
      assert.strictEqual(truncateString('abcdef', 5, '...'), 'ab...')
    })

    it('preserves UTF-16 code units', () => {
      const value = `ab\uD83D${'x'.repeat(100)}`
      assert.strictEqual(truncateString(value, 3), value.slice(0, 3))
    })

    it('does not retain the full input through the truncated value', () => {
      const utilPath = JSON.stringify(require.resolve('../src/util'))
      const script = `
        const { truncateString } = require(${utilPath})
        const count = 200
        const values = new Array(count)
        for (let i = 0; i < count; i++) {
          // Parsing creates independent flat strings instead of ropes that can share storage.
          const value = JSON.parse(JSON.stringify(String(i).padStart(6, '0') + 'x'.repeat(128 * 1024)))
          values[i] = truncateString(value, 100, '...')
        }
        let retainedLength = 0
        for (const value of values) retainedLength += value.length
        process.stdout.write(String(retainedLength))
      `
      const result = spawnSync(process.execPath, ['--max-old-space-size=16', '-e', script], { encoding: 'utf8' })

      assert.strictEqual(result.status, 0, result.stderr)
      assert.strictEqual(result.stdout, '20000')
    })
  })

  it('isTrue works', () => {
    TRUES.forEach((v) => {
      assert.strictEqual(isTrue(v), true)
      assert.strictEqual(isTrue(String(v)), true)
    })
    FALSES.forEach((v) => {
      assert.strictEqual(isTrue(v), false)
      assert.strictEqual(isTrue(String(v)), false)
    })
  })

  it('isFalse works', () => {
    FALSES.forEach((v) => {
      assert.strictEqual(isFalse(v), true)
      assert.strictEqual(isFalse(String(v)), true)
    })
    TRUES.forEach((v) => {
      assert.strictEqual(isFalse(v), false)
      assert.strictEqual(isFalse(String(v)), false)
    })
  })

  it('globMatch works', () => {
    MATCH_CASES.forEach(({ subject, pattern }) => {
      assert.strictEqual(globMatch(pattern, subject), true)
    })

    NONMATCH_CASES.forEach(({ subject, pattern }) => {
      assert.strictEqual(globMatch(pattern, subject), false)
    })
  })

  it('isEmpty works', () => {
    assert.strictEqual(isEmpty({}), true)
    assert.strictEqual(isEmpty(Object.create(null)), true)
    assert.strictEqual(isEmpty({ a: 1 }), false)
    assert.strictEqual(isEmpty(Object.assign(Object.create({ inherited: 1 }), { own: 2 })), false)
    // `for-in` walks inherited enumerable keys, so a prototype-only object counts as non-empty.
    assert.strictEqual(isEmpty(Object.create({ inherited: 1 })), false)
  })

  describe('isPackageManager', () => {
    const { argv } = process

    afterEach(() => {
      process.argv = argv
    })

    /**
     * @param {string} [entryPoint]
     */
    function isPackageManagerEntryPoint (entryPoint) {
      process.argv = entryPoint === undefined ? [argv[0]] : [argv[0], entryPoint]
      return isPackageManager()
    }

    it('matches package manager entry points', () => {
      const entryPoints = [
        '/usr/local/bin/npm',
        '/usr/local/lib/node_modules/npm/bin/npm-cli.js',
        'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
        '/usr/local/bin/yarn',
        '/usr/local/bin/yarnpkg',
        '/usr/local/lib/node_modules/yarn/bin/yarn.js',
        '/project/node_modules/.bin/pnpm',
        '/project/node_modules/pnpm/bin/pnpm.mjs',
        '/home/user/.cache/node/corepack/v1/pnpm/11.20.0/bin/pnpm.cjs',
        '/project/node_modules/.bin/pnpx',
        '/project/node_modules/pnpm/bin/pnpx.mjs',
        'C:\\Users\\user\\AppData\\Roaming\\npm\\node_modules\\pnpm\\bin\\pnpm.cjs',
        // `corepack pnpm` runs pnpm inside the corepack process.
        '/usr/local/bin/corepack',
        '/usr/local/lib/node_modules/corepack/dist/pnpm.js',
        // Targets of the Windows shims that Node.js installs and that `corepack enable` generates.
        'C:\\Program Files\\nodejs\\node_modules\\corepack\\dist\\corepack.js',
        'C:\\Program Files\\nodejs\\node_modules\\corepack\\dist\\pnpm.js',
        'C:\\Program Files\\nodejs\\node_modules\\corepack\\dist\\pnpx.js',
        'C:\\Program Files\\nodejs\\node_modules\\corepack\\dist\\yarn.js',
      ]

      for (const entryPoint of entryPoints) {
        assert.strictEqual(isPackageManagerEntryPoint(entryPoint), true, entryPoint)
      }
    })

    it('does not match test runners and scripts that package managers launch', () => {
      const entryPoints = [
        '/project/node_modules/.bin/vitest',
        '/project/node_modules/.pnpm/vitest@3.2.7/node_modules/vitest/vitest.mjs',
        '/project/node_modules/tinypool/dist/entry/process.js',
        '/project/node_modules/.bin/jest',
        '/project/node_modules/jest/bin/jest.js',
        '/project/node_modules/jest-worker/build/workers/processChild.js',
        '/project/node_modules/mocha/bin/mocha.js',
        '/project/node_modules/@cucumber/cucumber/bin/cucumber.js',
        '/project/node_modules/@playwright/test/cli.js',
        '/project/index.mjs',
      ]

      for (const entryPoint of entryPoints) {
        assert.strictEqual(isPackageManagerEntryPoint(entryPoint), false, entryPoint)
      }
    })

    it('does not match applications whose path only resembles a package manager', () => {
      const entryPoints = [
        '/srv/bin/pnpm-app/server.mjs',
        '/app/bin/npm-report.js',
        '/app/bin/yarn-worker.mjs',
        '/app/bin/corepack-tools/index.js',
        '/app/sbin/npm',
        '/project/node_modules/.bin/npm-run-all',
        '/project/node_modules/pnpm-sync/bin/index.js',
        '/app/dist/pnpm.js',
        '/app/corepack/dist/server.js',
        'C:\\app\\corepack\\dist\\pnpm-helper.js',
      ]

      for (const entryPoint of entryPoints) {
        assert.strictEqual(isPackageManagerEntryPoint(entryPoint), false, entryPoint)
      }
    })

    it('does not match a process without an entry point', () => {
      assert.strictEqual(isPackageManagerEntryPoint(), false)
    })
  })

  describe('getSegment', () => {
    const cases = [
      ['GET /path HTTP/1.1', ' ', 0],
      ['GET /path HTTP/1.1', ' ', 1],
      ['GET /path HTTP/1.1', ' ', 2],
      ['integration:openai', ':', 1],
      ['foo:bar:baz', ':', 1],
      ['1.2.3', '.', 0],
      ['1.2.3', '.', 2],
      ['CohereEmbeddings', 'Embeddings', 0],
      ['a::b::c', '::', 1],
      ['origin\nupstream', '\n', 0],
      ['only', '.', 0],
      ['leading, trailing', ',', 1],
      [',leading', ',', 0],
      ['trailing,', ',', 1],
    ]

    it('matches String.prototype.split for the indexed segment', () => {
      for (const [string, separator, index] of cases) {
        assert.strictEqual(
          getSegment(string, separator, index),
          string.split(separator, index + 1)[index],
          `getSegment(${JSON.stringify(string)}, ${JSON.stringify(separator)}, ${index})`
        )
      }
    })

    it('returns the fallback when fewer than index + 1 segments exist', () => {
      assert.strictEqual(getSegment('a.b', '.', 5), undefined)
      assert.strictEqual(getSegment('a.b', '.', 5, 'fallback'), 'fallback')
      assert.strictEqual(getSegment('no-separator', '.', 1), undefined)
      assert.strictEqual(getSegment('no-separator', '.', 1, 'fallback'), 'fallback')
    })

    it('handles the empty string and an absent separator at index 0', () => {
      assert.strictEqual(getSegment('', '.', 0), '')
      assert.strictEqual(getSegment('whole', '.', 0), 'whole')
    })
  })

  describe('stripQueryAndFragment', () => {
    const cases = [
      '/api/v1/users',
      '/api/v1/users?page=2&limit=50',
      '/search?q=hello+world#results',
      '/docs#section-3',
      '/docs#section?not-a-query',
      '/redirect?to=/other%3Fnested#frag',
      '/?only-query',
      '/#only-fragment',
      '?leading-query',
      '#leading-fragment',
      '/',
      '',
    ]

    it('matches splitting on the query and fragment delimiters', () => {
      for (const target of cases) {
        assert.strictEqual(
          stripQueryAndFragment(target),
          target.split(/[?#]/)[0],
          `stripQueryAndFragment(${JSON.stringify(target)})`
        )
      }
    })
  })
})
