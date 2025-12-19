'use strict'

const assert = require('node:assert/strict')
const { assertObjectContains } = require('../../../integration-tests/helpers')
const { describe, it, beforeEach, afterEach } = require('tap').mocha

require('./setup/core')

describe('process-tags', () => {
  const getProcessTags = require('../src/process-tags')
  const { serialize, sanitize } = require('../src/process-tags')

  describe('getProcessTags', () => {
    it('should return an object with tags and serialized properties', () => {
      const result = getProcessTags()

      assert.ok(Object.hasOwn(result, 'tags'))
      assert.ok(Object.hasOwn(result, 'serialized'))
      assert.ok(Array.isArray(result.tags))
      assert.strictEqual(typeof result.serialized, 'string')
    })

    it('should include all expected tag names', () => {
      const result = getProcessTags()
      const tagNames = result.tags.map(([name]) => name).sort()

      assertObjectContains(
        tagNames,
        [
          'entrypoint.basedir',
          'entrypoint.name',
          'entrypoint.type',
          'entrypoint.workdir',
          'package.json.name'
        ]
      )
    })

    it('should have entrypoint.type set to "script"', () => {
      const result = getProcessTags()
      const typeTag = result.tags.find(([name]) => name === 'entrypoint.type')

      assert.ok(Array.isArray(typeTag))
      assert.strictEqual(typeTag[1], 'script')
    })

    it('should set entrypoint.workdir to the basename of cwd', () => {
      const result = getProcessTags()
      const workdirTag = result.tags.find(([name]) => name === 'entrypoint.workdir')

      assert.ok(Array.isArray(workdirTag))
      assert.strictEqual(typeof workdirTag[1], 'string')
      assert.doesNotMatch(workdirTag[1], /\//)
    })

    // note that these tests may fail if the tracer folder structure changes
    it('should set sensible values based on tracer project structure and be sorted alphabetically', () => {
      const result = getProcessTags()

      assert.deepStrictEqual(result.tags, [
        ['entrypoint.basedir', 'test'],
        ['entrypoint.name', 'process-tags.spec'],
        ['entrypoint.type', 'script'],
        ['entrypoint.workdir', 'dd-trace-js'],
        ['package.json.name', 'dd-trace'],
      ])
    })

    it('should serialize tags correctly', () => {
      const result = getProcessTags()

      // serialized should be comma-separated and not include undefined values
      if (result.serialized) {
        const parts = result.serialized.split(',')
        assert.ok(parts.length > 0)
        parts.forEach(part => {
          assert.match(part, /:/)
          assert.doesNotMatch(part, /undefined/)
        })
      }
    })
  })

  describe('serialize', () => {
    it('should serialize tags as name:value pairs joined by commas', () => {
      const tags = [
        ['tag1', 'value1'],
        ['tag2', 'value2'],
        ['tag3', 'value3']
      ]

      const result = serialize(tags)

      assert.strictEqual(result, 'tag1:value1,tag2:value2,tag3:value3')
    })

    it('should filter out tags with undefined values', () => {
      const tags = [
        ['tag1', 'value1'],
        ['tag2', undefined],
        ['tag3', 'value3'],
        ['tag4', undefined]
      ]

      const result = serialize(tags)

      assert.strictEqual(result, 'tag1:value1,tag3:value3')
      assert.doesNotMatch(result, /undefined/)
    })

    it('should sanitize tag values', () => {
      const tags = [
        ['tag1', 'Value With Spaces'],
        ['tag2', 'UPPERCASE'],
        ['tag3', 'special@chars!']
      ]

      const result = serialize(tags)

      assert.strictEqual(result, 'tag1:value_with_spaces,tag2:uppercase,tag3:special_chars_')
    })

    it('should return empty string when all values are undefined', () => {
      const tags = [
        ['tag1', undefined],
        ['tag2', undefined]
      ]

      const result = serialize(tags)

      assert.strictEqual(result, '')
    })

    it('should handle empty tags array', () => {
      const result = serialize([])

      assert.strictEqual(result, '')
    })

    it('should handle numeric values', () => {
      const tags = [
        ['tag1', 123],
        ['tag2', 456]
      ]

      const result = serialize(tags)

      assert.strictEqual(result, 'tag1:123,tag2:456')
    })

    it('should handle mixed defined and undefined values', () => {
      const tags = [
        ['tag1', 'value1'],
        ['tag2', undefined],
        ['tag3', 'value3'],
        ['tag4', undefined],
        ['tag5', 'value5']
      ]

      const result = serialize(tags)

      assert.strictEqual(result, 'tag1:value1,tag3:value3,tag5:value5')
    })
  })

  describe('sanitize', () => {
    it('should convert to lowercase', () => {
      assert.strictEqual(sanitize('UPPERCASE'), 'uppercase')
      assert.strictEqual(sanitize('MixedCase'), 'mixedcase')
      assert.strictEqual(sanitize('CamelCase'), 'camelcase')
    })

    it('should replace spaces with underscores', () => {
      assert.strictEqual(sanitize('hello world'), 'hello_world')
      assert.strictEqual(sanitize('multiple   spaces'), 'multiple_spaces')
    })

    it('should replace special characters with underscores', () => {
      assert.strictEqual(sanitize('hello@world'), 'hello_world')
      assert.strictEqual(sanitize('hello!world'), 'hello_world')
      assert.strictEqual(sanitize('hello#world'), 'hello_world')
      assert.strictEqual(sanitize('hello$world'), 'hello_world')
      assert.strictEqual(sanitize('hello%world'), 'hello_world')
      assert.strictEqual(sanitize('hello&world'), 'hello_world')
      assert.strictEqual(sanitize('hello*world'), 'hello_world')
    })

    it('should preserve forward slashes', () => {
      assert.strictEqual(sanitize('path/to/file'), 'path/to/file')
      assert.strictEqual(sanitize('foo/bar/baz'), 'foo/bar/baz')
    })

    it('should preserve underscores', () => {
      assert.strictEqual(sanitize('hello_world'), 'hello_world')
      assert.strictEqual(sanitize('foo_bar_baz'), 'foo_bar_baz')
    })

    it('should preserve dots', () => {
      assert.strictEqual(sanitize('file.txt'), 'file.txt')
      assert.strictEqual(sanitize('my.package.name'), 'my.package.name')
    })

    it('should preserve hyphens', () => {
      assert.strictEqual(sanitize('my-package'), 'my-package')
      assert.strictEqual(sanitize('foo-bar-baz'), 'foo-bar-baz')
    })

    it('should preserve alphanumeric characters', () => {
      assert.strictEqual(sanitize('abc123'), 'abc123')
      assert.strictEqual(sanitize('ABC123'), 'abc123')
      assert.strictEqual(sanitize('test123abc'), 'test123abc')
    })

    it('should handle multiple consecutive special characters', () => {
      assert.strictEqual(sanitize('hello!!!world'), 'hello_world')
      assert.strictEqual(sanitize('foo@@@bar'), 'foo_bar')
      assert.strictEqual(sanitize('test   spaces'), 'test_spaces')
    })

    it('should handle complex combinations', () => {
      assert.strictEqual(sanitize('My-Package_Name/v1.2.3'), 'my-package_name/v1.2.3')
      assert.strictEqual(sanitize('foo@bar#baz.txt'), 'foo_bar_baz.txt')
      assert.strictEqual(sanitize('Test File (Copy).js'), 'test_file_copy_.js')
    })

    it('should convert non-string values to strings first', () => {
      // @ts-expect-error: intentionally passing invalid types to test robustness
      assert.strictEqual(sanitize(123), '123')
      // @ts-expect-error: intentionally passing invalid types to test robustness
      assert.strictEqual(sanitize(true), 'true')
      // @ts-expect-error: intentionally passing invalid types to test robustness
      assert.strictEqual(sanitize(false), 'false')
    })

    it('should handle empty string', () => {
      assert.strictEqual(sanitize(''), '')
    })

    it('should handle strings with only special characters', () => {
      assert.strictEqual(sanitize('!!!'), '_')
      assert.strictEqual(sanitize('@@@'), '_')
      assert.strictEqual(sanitize('   '), '_')
    })

    it('should handle unicode characters', () => {
      assert.strictEqual(sanitize('hello™world'), 'hello_world')
      assert.strictEqual(sanitize('café'), 'caf_')
      assert.strictEqual(sanitize('日本語'), '_')
    })

    it('should handle brackets and parentheses', () => {
      assert.strictEqual(sanitize('func()'), 'func_')
      assert.strictEqual(sanitize('array[0]'), 'array_0_')
      assert.strictEqual(sanitize('{object}'), '_object_')
    })

    it('should handle quotes and backticks', () => {
      assert.strictEqual(sanitize('"quoted"'), '_quoted_')
      assert.strictEqual(sanitize("'quoted'"), '_quoted_')
      assert.strictEqual(sanitize('`backtick`'), '_backtick_')
    })

    it('should preserve allowed characters in combination', () => {
      assert.strictEqual(sanitize('my_file-v1.0/test.js'), 'my_file-v1.0/test.js')
      assert.strictEqual(sanitize('package_name-2.4.6/lib/index.js'), 'package_name-2.4.6/lib/index.js')
    })
  })

  describe('DD_EXPERIMENTAL_PROPAGATE_PROCESS_TAGS_ENABLED', () => {
    let env
    let getConfig
    let SpanProcessor

    beforeEach(() => {
      env = process.env
      process.env = {}
    })

    afterEach(() => {
      process.env = env
      delete require.cache[require.resolve('../src/config')]
      delete require.cache[require.resolve('../src/span_processor')]
    })

    it('should enable process tags propagation when set to true', () => {
      process.env.DD_EXPERIMENTAL_PROPAGATE_PROCESS_TAGS_ENABLED = 'true'

      getConfig = require('../src/config')
      const config = getConfig()

      assert.ok(config.propagateProcessTags)
      assert.strictEqual(config.propagateProcessTags.enabled, true)

      SpanProcessor = require('../src/span_processor')
      const processor = new SpanProcessor(undefined, undefined, config)

      assert.ok(typeof processor._processTags === 'string')
      assert.match(processor._processTags, /entrypoint/)
    })

    it('should disable process tags propagation when set to false', () => {
      process.env.DD_EXPERIMENTAL_PROPAGATE_PROCESS_TAGS_ENABLED = 'false'

      getConfig = require('../src/config')
      const config = getConfig()

      assert.ok(config.propagateProcessTags)
      assert.strictEqual(config.propagateProcessTags.enabled, false)

      SpanProcessor = require('../src/span_processor')
      const processor = new SpanProcessor(undefined, undefined, config)

      assert.strictEqual(processor._processTags, false)
    })

    it('should disable process tags propagation when not set', () => {
      // Don't set the environment variable

      getConfig = require('../src/config')
      const config = getConfig()

      assert.notStrictEqual(config.propagateProcessTags?.enabled, true)

      SpanProcessor = require('../src/span_processor')
      const processor = new SpanProcessor(undefined, undefined, config)

      assert.strictEqual(processor._processTags, false)
    })
  })
})
