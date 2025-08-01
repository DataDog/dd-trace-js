'use strict'

require('../../dd-trace/test/setup/tap')

const { resolve } = require('node:path')
const assert = require('node:assert')
const { entryTags, exitTags } = require('../index')
const { getNextLineNumber } = require('../../dd-trace/test/plugins/helpers')

const testedFile = resolve(__dirname, '..', 'index.js')
const originalLimit = Error.stackTraceLimit

describe('code origin', () => {
  afterEach(() => {
    Error.stackTraceLimit = originalLimit
  })

  describe('entryTags', () => {
    it('should collect expected entry tags if not given a function', () => {
      const tags = entryTags()
      assert.strictEqual(tags['_dd.code_origin.type'], 'entry')
      assert.strictEqual(tags['_dd.code_origin.frames.0.file'], testedFile)
      assert.strictEqual(typeof tags['_dd.code_origin.frames.0.line'], 'string')
      assert(Number(tags['_dd.code_origin.frames.0.line']) > 0)
      assert.strictEqual(typeof tags['_dd.code_origin.frames.0.column'], 'string')
      assert(Number(tags['_dd.code_origin.frames.0.column']) > 0)
      assert.strictEqual(tags['_dd.code_origin.frames.0.method'], 'tag')
      assert.strictEqual('_dd.code_origin.frames.0.type' in tags, false)
    })

    it('should collect expected entry tags if given a function', () => {
      function fn () {
        return entryTags(fn)
      }
      const line = getNextLineNumber()
      const tags = fn()
      assert.deepStrictEqual(tags, {
        '_dd.code_origin.type': 'entry',
        '_dd.code_origin.frames.0.file': __filename,
        '_dd.code_origin.frames.0.line': String(line),
        '_dd.code_origin.frames.0.column': '20',
        '_dd.code_origin.frames.0.method': '<anonymous>',
        '_dd.code_origin.frames.0.type': 'Test'
      })
    })

    it('should find a user frame if the stack trace limit is set to 0', () => {
      Error.stackTraceLimit = 0
      const tags = entryTags()
      assert.strictEqual(tags['_dd.code_origin.frames.0.file'], testedFile)
    })
  })

  describe('exitTags', () => {
    it('should collect expected exit tags if not given a function', () => {
      const line = getNextLineNumber()
      const tags = exitTags()
      const frames = [
        { file: testedFile, method: 'tag' },
        { file: testedFile, method: 'exitTags' },
        { file: __filename, line, column: 20, method: '<anonymous>', type: 'Test' }
      ]
      assert.strictEqual(tags['_dd.code_origin.type'], 'exit')

      for (let i = 0; i < frames.length; i++) {
        const { file, line, column, method, type } = frames[i]
        assert.strictEqual(tags[`_dd.code_origin.frames.${i}.file`], file)
        if (line === undefined) {
          assert.strictEqual(typeof tags[`_dd.code_origin.frames.${i}.line`], 'string')
          assert(Number(tags[`_dd.code_origin.frames.${i}.line`]) > 0)
        } else {
          assert.strictEqual(tags[`_dd.code_origin.frames.${i}.line`], String(line))
        }
        if (column === undefined) {
          assert.strictEqual(typeof tags[`_dd.code_origin.frames.${i}.column`], 'string')
          assert(Number(tags[`_dd.code_origin.frames.${i}.column`]) > 0)
        } else {
          assert.strictEqual(tags[`_dd.code_origin.frames.${i}.column`], String(column))
        }
        assert.strictEqual(tags[`_dd.code_origin.frames.${i}.method`], method)
        if (type === undefined) {
          assert.strictEqual(`_dd.code_origin.frames.${i}.type` in tags, false)
        } else {
          assert.strictEqual(tags[`_dd.code_origin.frames.${i}.type`], type)
        }
      }
    })

    it('should collect expected exit tags if given a function', () => {
      let line
      const exitSpanStackFramesLimit = 8
      function fn (limit = exitSpanStackFramesLimit + 2) {
        if (limit === 0) {
          return exitTags(fn)
        }
        line = getNextLineNumber()
        return fn(limit - 1)
      }
      const tags = fn()
      for (let i = 0; i < exitSpanStackFramesLimit; i++) {
        assert.strictEqual(tags[`_dd.code_origin.frames.${i}.file`], __filename)
        assert.strictEqual(tags[`_dd.code_origin.frames.${i}.line`], String(line))
        assert.strictEqual(tags[`_dd.code_origin.frames.${i}.column`], '16')
        assert.strictEqual(tags[`_dd.code_origin.frames.${i}.method`], 'fn')
        assert.strictEqual(`_dd.code_origin.frames.${i}.type` in tags, false)
      }
    })

    it('should find a user frame if the stack trace limit is set to 0', () => {
      Error.stackTraceLimit = 0
      const tags = exitTags()
      assert.strictEqual(tags['_dd.code_origin.frames.0.file'], testedFile)
    })
  })
})
