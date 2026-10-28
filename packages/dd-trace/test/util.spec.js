'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const path = require('node:path')

const { afterEach, describe, it } = require('mocha')

require('./setup/core')
const {
  ddBasePath,
  isEmpty,
  isTrue,
  isFalse,
  globMatch,
  getSegment,
  stripQueryAndFragment,
  truncateString,
  typedArrayLength,
} = require('../src/util')
const { loadAsBundled } = require('./helpers/load-as-bundled')

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
    assert.strictEqual(isEmpty([]), true)
    assert.strictEqual(isEmpty([1]), false)
    assert.strictEqual(isEmpty(Buffer.alloc(0)), true)
    assert.strictEqual(isEmpty(Buffer.from('a')), false)
    assert.strictEqual(isEmpty(new Uint8Array(0)), true)
    assert.strictEqual(isEmpty(new Uint8Array(1)), false)
    assert.strictEqual(isEmpty(Buffer.alloc(64 * 1024 * 1024)), false)
    assert.strictEqual(isEmpty(new DataView(new ArrayBuffer(0))), true)
    assert.strictEqual(isEmpty(new DataView(new ArrayBuffer(1))), true)
    assert.strictEqual(isEmpty(Object.assign([], { key: 'value' })), false)
    assert.strictEqual(isEmpty(Object.assign(new Uint8Array(0), { key: 'value' })), false)
    assert.strictEqual(isEmpty(new Array(1)), false)
    assert.strictEqual(isEmpty(''), true)
    assert.strictEqual(isEmpty('a'), false)
    assert.strictEqual(isEmpty('a'.repeat(32 * 1024 * 1024)), false)
  })

  it('isEmpty and typedArrayLength do not call shadowed typed array length getters', () => {
    const throwing = () => { throw new TypeError('length') }
    const empty = Object.defineProperty(new Uint8Array(0), 'length', { get: throwing })
    const nonEmpty = Object.defineProperty(new Uint8Array(2), 'length', { get: throwing })

    class ShadowedLength extends Uint8Array {
      get length () { throw new TypeError('length') }
    }

    assert.strictEqual(isEmpty(empty), true)
    assert.strictEqual(isEmpty(nonEmpty), false)
    assert.strictEqual(isEmpty(new ShadowedLength(2)), false)
    assert.strictEqual(typedArrayLength(nonEmpty), 2)
    assert.strictEqual(typedArrayLength(new ShadowedLength(3)), 3)
    assert.strictEqual(typedArrayLength(Buffer.alloc(4)), 4)
    assert.strictEqual(typedArrayLength(new DataView(new ArrayBuffer(5))), 0)
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

  describe('ddBasePath', () => {
    const utilPath = require.resolve('../src/util')
    const repoRoot = path.resolve(__dirname, '..', '..', '..') + path.sep

    afterEach(() => {
      delete globalThis.__DD_ESBUILD_BASEPATH
    })

    it('is the directory containing the dd-trace packages', () => {
      assert.strictEqual(ddBasePath, repoRoot)
      assert.strictEqual(loadAsBundled(utilPath, { dirname: path.dirname(utilPath) }).ddBasePath, repoRoot)
    })

    it('is undefined when bundled into CJS output, where __dirname is the bundle directory', () => {
      const bundleDir = path.join(path.parse(repoRoot).root, 'app', 'dist')

      assert.strictEqual(loadAsBundled(utilPath, { dirname: bundleDir }).ddBasePath, undefined)
    })

    it('is undefined when bundled into ESM output, where __dirname is not defined', () => {
      assert.strictEqual(loadAsBundled(utilPath).ddBasePath, undefined)
    })

    it('prefers the base path provided by the esbuild plugin', () => {
      globalThis.__DD_ESBUILD_BASEPATH = repoRoot

      assert.strictEqual(loadAsBundled(utilPath).ddBasePath, repoRoot)
    })
  })
})
