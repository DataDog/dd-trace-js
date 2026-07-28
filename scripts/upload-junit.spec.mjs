import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, it } from 'mocha'

import { mergeJunit } from './upload-junit.mjs'

describe('upload-junit', () => {
  describe('mergeJunit', () => {
    let dir

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'upload-junit-'))
    })

    afterEach(() => {
      rmSync(dir, { force: true, recursive: true })
    })

    it('concatenates every report\'s testsuite children under one root', () => {
      const a = join(dir, 'a.xml')
      const b = join(dir, 'b.xml')
      writeFileSync(a, '<testsuites name="Mocha Tests" time="1.000" tests="1" failures="0">' +
        '<testsuite name="a"></testsuite></testsuites>\n')
      writeFileSync(b, '<testsuites name="Mocha Tests" time="2.000" tests="2" failures="1">' +
        '<testsuite name="b"></testsuite></testsuites>\n')
      const merged = mergeJunit([a, b])
      assert.equal(
        merged,
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<testsuites name="Mocha Tests" time="3.000" tests="3" failures="1">' +
        '<testsuite name="a"></testsuite><testsuite name="b"></testsuite></testsuites>\n'
      )
    })

    it('sums skipped counts and omits the attribute when no report reports any', () => {
      const a = join(dir, 'a.xml')
      const b = join(dir, 'b.xml')
      writeFileSync(a, '<testsuites name="Mocha Tests" time="1.000" tests="1" failures="0" skipped="1">' +
        '<testsuite name="a"></testsuite></testsuites>\n')
      writeFileSync(b, '<testsuites name="Mocha Tests" time="1.000" tests="1" failures="0" skipped="2">' +
        '<testsuite name="b"></testsuite></testsuites>\n')
      assert.match(mergeJunit([a, b]), /skipped="3"/)

      const c = join(dir, 'c.xml')
      writeFileSync(c, '<testsuites name="Mocha Tests" time="1.000" tests="1" failures="0">' +
        '<testsuite name="c"></testsuite></testsuites>\n')
      assert.doesNotMatch(mergeJunit([c]), /skipped=/)
    })

    it('keeps the first report\'s name when reports disagree', () => {
      const a = join(dir, 'a.xml')
      const b = join(dir, 'b.xml')
      writeFileSync(a, '<testsuites name="first" time="0.000" tests="0" failures="0"></testsuites>\n')
      writeFileSync(b, '<testsuites name="second" time="0.000" tests="0" failures="0"></testsuites>\n')
      assert.match(mergeJunit([a, b]), /name="first"/)
    })

    it('skips a file that does not match the expected testsuites shape', () => {
      const a = join(dir, 'a.xml')
      const b = join(dir, 'b.xml')
      writeFileSync(a, 'not xml')
      writeFileSync(b, '<testsuites name="Mocha Tests" time="1.000" tests="1" failures="0">' +
        '<testsuite name="b"></testsuite></testsuites>\n')
      const merged = mergeJunit([a, b])
      assert.match(merged, /<testsuite name="b">/)
      assert.equal(merged.match(/<testsuite /g).length, 1)
    })
  })
})
