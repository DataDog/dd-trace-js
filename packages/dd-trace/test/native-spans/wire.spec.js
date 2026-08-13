'use strict'

require('../setup/core')

const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const wire = require('../../src/native-spans/wire')

const RUST_SOURCE = readFileSync(
  join(__dirname, '..', '..', 'src', 'native-spans', 'native', 'src', 'wire.rs'),
  'utf8'
)

/**
 * @param {RegExp} pattern
 * @returns {string[]} The match and its capture groups, or a failed assertion naming
 * the pattern — better than the `TypeError` a null match would throw downstream.
 */
function matchRust (pattern) {
  const match = RUST_SOURCE.match(pattern)
  assert.ok(match, `wire.rs has no declaration matching ${pattern}`)
  return match
}

// The wire format is declared twice — once for the writer, once for the decoder — and
// a silent disagreement between them decodes a span's tags onto the wrong span, or
// loses the framing entirely. These tests are the drift guard: they parse the Rust
// declarations and compare them against the JS ones.
describe('native-spans wire format', () => {
  describe('kind tags', () => {
    it('assigns the same tag to every kind on both sides', () => {
      const rustKinds = new Map()
      const pattern = /pub const (KIND_\w+): u32 = (\d+);/g
      for (const [, name, value] of RUST_SOURCE.matchAll(pattern)) {
        rustKinds.set(name, Number(value))
      }

      const jsKinds = new Map(
        Object.entries(wire).filter(([name]) => name.startsWith('KIND_') && name !== 'KIND_COUNT')
      )

      assert.deepStrictEqual([...rustKinds.keys()].sort(), [...jsKinds.keys()].sort())
      for (const [name, value] of jsKinds) {
        assert.strictEqual(rustKinds.get(name), value, `${name} disagrees`)
      }
    })

    it('agrees on the kind count', () => {
      assert.strictEqual(Number(matchRust(/pub const KIND_COUNT: usize = (\d+);/)[1]), wire.KIND_COUNT)
    })

    it('gives every kind a non-zero width', () => {
      for (let kind = 1; kind < wire.KIND_COUNT; kind++) {
        assert.ok(wire.WIDTHS[kind] > 0, `kind ${kind} has no width`)
      }
    })
  })

  describe('record widths', () => {
    it('matches the Rust width table', () => {
      const pattern = /widths\[(KIND_\w+) as usize\] = (\d+);/g
      let asserted = 0

      for (const [, name, value] of RUST_SOURCE.matchAll(pattern)) {
        assert.strictEqual(wire.WIDTHS[wire[name]], Number(value), `${name} width disagrees`)
        asserted++
      }

      // Every kind but the unassigned zero slot must appear, so a kind added on one
      // side only cannot slip through as "nothing to compare".
      assert.strictEqual(asserted, wire.KIND_COUNT - 1)
    })

    it('makes each elided form exactly two words shorter than its explicit form', () => {
      const pairs = [
        ['KIND_SET_TAG_STRING', 'KIND_SET_TAG_STRING_ID'],
        ['KIND_SET_TAG_NUMBER', 'KIND_SET_TAG_NUMBER_ID'],
        ['KIND_ADD_LINK', 'KIND_ADD_LINK_ID'],
        ['KIND_ADD_EVENT', 'KIND_ADD_EVENT_ID'],
        ['KIND_FINISH', 'KIND_FINISH_ID'],
      ]

      for (const [elided, explicit] of pairs) {
        assert.strictEqual(
          wire.WIDTHS[wire[explicit]] - wire.WIDTHS[wire[elided]],
          2,
          `${elided} saves the wrong number of words`
        )
      }
    })

    it('reports the widest record as the flush headroom', () => {
      assert.strictEqual(wire.MAX_RECORD_WORDS, Math.max(...wire.WIDTHS))
    })
  })

  describe('doubles buffer', () => {
    it('matches the Rust double-count table', () => {
      const pattern = /counts\[(KIND_\w+) as usize\] = (\d+);/g
      const rustCounts = new Map()
      for (const [, name, value] of RUST_SOURCE.matchAll(pattern)) {
        rustCounts.set(name, Number(value))
      }

      for (let kind = 0; kind < wire.KIND_COUNT; kind++) {
        const name = Object.keys(wire).find(key => key.startsWith('KIND_') && wire[key] === kind)
        const expected = name === undefined ? 0 : (rustCounts.get(name) ?? 0)
        assert.strictEqual(wire.DOUBLE_COUNTS[kind], expected, `kind ${kind} double count disagrees`)
      }
    })

    it('gives both forms of a float-carrying kind the same count', () => {
      assert.strictEqual(
        wire.DOUBLE_COUNTS[wire.KIND_SET_TAG_NUMBER],
        wire.DOUBLE_COUNTS[wire.KIND_SET_TAG_NUMBER_ID]
      )
    })
  })

  describe('reserved strings', () => {
    it('holds the same table in the same order', () => {
      const match = matchRust(/pub const RESERVED_STRINGS: \[&str; (\d+)\] = \[([\S\s]*?)\n\];/)
      const rustStrings = [...match[2].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(([, value]) => value)

      assert.strictEqual(Number(match[1]), rustStrings.length, 'the declared length is wrong')
      assert.deepStrictEqual(rustStrings, wire.RESERVED_STRINGS)
    })

    it('reserves id 0 for the absent string', () => {
      assert.strictEqual(wire.RESERVED_STRINGS[0], '')
    })

    it('agrees on where the resettable id range starts', () => {
      const match = matchRust(/pub const FIRST_DYNAMIC_STRING_ID: u32 = (\d+);/)
      assert.strictEqual(Number(match[1]), wire.FIRST_DYNAMIC_STRING_ID)
    })

    it('leaves the last reserved id below the resettable range', () => {
      // The boundary itself: a table exactly filling the reserved space is still
      // valid, one entry past it is not.
      assert.ok(wire.RESERVED_STRINGS.length <= wire.FIRST_DYNAMIC_STRING_ID)
    })

    it('has no duplicate entries', () => {
      assert.strictEqual(new Set(wire.RESERVED_STRINGS).size, wire.RESERVED_STRINGS.length)
    })
  })
})
