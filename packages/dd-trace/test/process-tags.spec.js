'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach, afterEach } = require('mocha')

const { assertObjectContains } = require('../../../integration-tests/helpers')
const { getConfigFresh } = require('./helpers/config')
require('./setup/core')

describe('process-tags', () => {
  const processTags = require('../src/process-tags')
  const { serialize, sanitize } = require('../src/process-tags')

  describe('field name constants', () => {
    it('should define field names for different subsystems', () => {
      assertObjectContains(processTags, {
        TRACING_FIELD_NAME: '_dd.tags.process',
        DSM_FIELD_NAME: 'ProcessTags',
        PROFILING_FIELD_NAME: 'process_tags',
        DYNAMIC_INSTRUMENTATION_FIELD_NAME: 'process_tags',
        TELEMETRY_FIELD_NAME: 'process_tags',
        REMOTE_CONFIG_FIELD_NAME: 'process_tags',
        CRASH_TRACKING_FIELD_NAME: 'process_tags'
      })
    })
  })

  describe('processTags', () => {
    it('should return an object with tags, serialized, and tagsObject properties', () => {
      assert.ok(Object.hasOwn(processTags, 'tags'))
      assert.ok(Object.hasOwn(processTags, 'serialized'))
      assert.ok(Object.hasOwn(processTags, 'tagsObject'))
      assert.ok(Array.isArray(processTags.tags))
      assert.strictEqual(typeof processTags.serialized, 'string')
      assert.strictEqual(typeof processTags.tagsObject, 'object')
    })

    it('should have tagsObject with only defined values', () => {
      const { tagsObject } = processTags

      // All values in tagsObject should be defined
      Object.values(tagsObject).forEach(value => {
        assert.notStrictEqual(value, undefined)
      })

      // tagsObject should have the same keys as defined tags
      const definedTags = processTags.tags.filter(([, value]) => value !== undefined)
      assert.strictEqual(Object.keys(tagsObject).length, definedTags.length)
    })

    it('should include all expected tag names', () => {
      const tagNames = processTags.tags.map(([name]) => name)

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
      const typeTag = processTags.tags.find(([name]) => name === 'entrypoint.type')

      assert.ok(Array.isArray(typeTag))
      assert.strictEqual(typeTag[1], 'script')
    })

    it('should set entrypoint.workdir to the basename of cwd', () => {
      const workdirTag = processTags.tags.find(([name]) => name === 'entrypoint.workdir')

      assert.ok(Array.isArray(workdirTag))
      assert.strictEqual(typeof workdirTag[1], 'string')
      assert.doesNotMatch(workdirTag[1], /\//)
    })

    it('should set sensible values', () => {
      const basedirTag = processTags.tags[0]
      const nameTag = processTags.tags[1]
      const typeTag = processTags.tags[2]
      const workdirTag = processTags.tags[3]
      const packageNameTag = processTags.tags[4]

      // Entrypoint values should be set (may vary depending on test runner)
      assert.ok(basedirTag)
      assert.strictEqual(typeof basedirTag[1], 'string')
      assert.ok(nameTag)
      assert.strictEqual(typeof nameTag[1], 'string')

      assert.ok(typeTag)
      assert.strictEqual(typeTag[1], 'script')

      assert.ok(workdirTag)
      assert.strictEqual(workdirTag[1], 'dd-trace-js')

      // Package name should exist but may vary depending on test runner
      assert.ok(packageNameTag)
      assert.strictEqual(typeof packageNameTag[1], 'string')
    })

    it('should sort tags alphabetically', () => {
      assertObjectContains(processTags.tags, [
        ['entrypoint.basedir'],
        ['entrypoint.name'],
        ['entrypoint.type'],
        ['entrypoint.workdir'],
        ['package.json.name']
      ])
    })

    it('should serialize tags correctly', () => {
      // serialized should be comma-separated and not include undefined values
      if (processTags.serialized) {
        const parts = processTags.serialized.split(',')
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
    let SpanProcessor

    beforeEach(() => {
      env = process.env
      process.env = {}
    })

    afterEach(() => {
      process.env = env
      delete require.cache[require.resolve('../src/span_processor')]
      delete require.cache[require.resolve('../src/process-tags')]
    })

    it('should enable process tags propagation when set to true', () => {
      process.env.DD_EXPERIMENTAL_PROPAGATE_PROCESS_TAGS_ENABLED = 'true'

      // Need to reload config first, then process-tags (which reads from config)
      delete require.cache[require.resolve('../src/process-tags')]

      const config = getConfigFresh()

      assert.ok(config.propagateProcessTags)
      assert.strictEqual(config.propagateProcessTags.enabled, true)

      SpanProcessor = require('../src/span_processor')
      const processor = new SpanProcessor(undefined, undefined, config)

      assert.ok(typeof processor._processTags === 'string')
      assert.match(processor._processTags, /entrypoint/)
    })

    it('should disable process tags propagation when set to false', () => {
      process.env.DD_EXPERIMENTAL_PROPAGATE_PROCESS_TAGS_ENABLED = 'false'

      const config = getConfigFresh()

      assert.ok(config.propagateProcessTags)
      assert.strictEqual(config.propagateProcessTags.enabled, false)

      SpanProcessor = require('../src/span_processor')
      const processor = new SpanProcessor(undefined, undefined, config)

      assert.strictEqual(processor._processTags, false)
    })

    it('should disable process tags propagation when not set', () => {
      // Don't set the environment variable

      const config = getConfigFresh()

      assert.notStrictEqual(config.propagateProcessTags?.enabled, true)

      SpanProcessor = require('../src/span_processor')
      const processor = new SpanProcessor(undefined, undefined, config)

      assert.strictEqual(processor._processTags, false)
    })
  })
})
