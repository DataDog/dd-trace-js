'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach, afterEach } = require('tap').mocha

require('./setup/core')

describe('process-tags', () => {
  const getProcessTags = require('../src/process-tags')
  const { serialize, sanitize } = require('../src/process-tags')

  describe('getProcessTags', () => {
    it('should return an object with tags and serialized properties', () => {
      const result = getProcessTags()

      expect(result).to.have.property('tags')
      expect(result).to.have.property('serialized')
      expect(result.tags).to.be.an('array')
      expect(result.serialized).to.be.a('string')
    })

    it('should include all expected tag names', () => {
      const result = getProcessTags()
      const tagNames = result.tags.map(([name]) => name)

      expect(tagNames).to.include('entrypoint.basedir')
      expect(tagNames).to.include('entrypoint.name')
      expect(tagNames).to.include('entrypoint.type')
      expect(tagNames).to.include('entrypoint.workdir')
      expect(tagNames).to.include('package.json.name')
    })

    it('should have entrypoint.type set to "script"', () => {
      const result = getProcessTags()
      const typeTag = result.tags.find(([name]) => name === 'entrypoint.type')

      expect(typeTag).to.exist
      expect(typeTag[1]).to.equal('script')
    })

    it('should set entrypoint.workdir to the basename of cwd', () => {
      const result = getProcessTags()
      const workdirTag = result.tags.find(([name]) => name === 'entrypoint.workdir')

      expect(workdirTag).to.exist
      expect(workdirTag[1]).to.be.a('string')
      expect(workdirTag[1]).to.not.include('/')
    })

    // note that these tests may fail if the tracer folder structure changes
    it('should set sensible values based on tracer project structure', () => {
      const result = getProcessTags()

      expect(result.tags.find(([name]) => name === 'entrypoint.basedir')[1]).to.equal('test')
      expect(result.tags.find(([name]) => name === 'entrypoint.name')[1]).to.equal('process-tags.spec')
      expect(result.tags.find(([name]) => name === 'entrypoint.type')[1]).to.equal('script')
      expect(result.tags.find(([name]) => name === 'entrypoint.workdir')[1]).to.equal('dd-trace-js')
      expect(result.tags.find(([name]) => name === 'package.json.name')[1]).to.equal('dd-trace')
    })

    it('should sort tags alphabetically', () => {
      const result = getProcessTags()

      expect(result.tags[0][0]).to.equal('entrypoint.basedir')
      expect(result.tags[1][0]).to.equal('entrypoint.name')
      expect(result.tags[2][0]).to.equal('entrypoint.type')
      expect(result.tags[3][0]).to.equal('entrypoint.workdir')
      expect(result.tags[4][0]).to.equal('package.json.name')
    })

    it('should serialize tags correctly', () => {
      const result = getProcessTags()

      // serialized should be comma-separated and not include undefined values
      if (result.serialized) {
        const parts = result.serialized.split(',')
        expect(parts.length).to.be.greaterThan(0)
        parts.forEach(part => {
          expect(part).to.include(':')
          expect(part).to.not.include('undefined')
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

      expect(result).to.equal('tag1:value1,tag2:value2,tag3:value3')
    })

    it('should filter out tags with undefined values', () => {
      const tags = [
        ['tag1', 'value1'],
        ['tag2', undefined],
        ['tag3', 'value3'],
        ['tag4', undefined]
      ]

      const result = serialize(tags)

      expect(result).to.equal('tag1:value1,tag3:value3')
      expect(result).to.not.include('undefined')
    })

    it('should sanitize tag values', () => {
      const tags = [
        ['tag1', 'Value With Spaces'],
        ['tag2', 'UPPERCASE'],
        ['tag3', 'special@chars!']
      ]

      const result = serialize(tags)

      expect(result).to.equal('tag1:value_with_spaces,tag2:uppercase,tag3:special_chars_')
    })

    it('should return empty string when all values are undefined', () => {
      const tags = [
        ['tag1', undefined],
        ['tag2', undefined]
      ]

      const result = serialize(tags)

      expect(result).to.equal('')
    })

    it('should handle empty tags array', () => {
      const result = serialize([])

      expect(result).to.equal('')
    })

    it('should handle numeric values', () => {
      const tags = [
        ['tag1', 123],
        ['tag2', 456]
      ]

      const result = serialize(tags)

      expect(result).to.equal('tag1:123,tag2:456')
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

      expect(result).to.equal('tag1:value1,tag3:value3,tag5:value5')
    })
  })

  describe('sanitize', () => {
    it('should convert to lowercase', () => {
      expect(sanitize('UPPERCASE')).to.equal('uppercase')
      expect(sanitize('MixedCase')).to.equal('mixedcase')
      expect(sanitize('CamelCase')).to.equal('camelcase')
    })

    it('should replace spaces with underscores', () => {
      expect(sanitize('hello world')).to.equal('hello_world')
      expect(sanitize('multiple   spaces')).to.equal('multiple_spaces')
    })

    it('should replace special characters with underscores', () => {
      expect(sanitize('hello@world')).to.equal('hello_world')
      expect(sanitize('hello!world')).to.equal('hello_world')
      expect(sanitize('hello#world')).to.equal('hello_world')
      expect(sanitize('hello$world')).to.equal('hello_world')
      expect(sanitize('hello%world')).to.equal('hello_world')
      expect(sanitize('hello&world')).to.equal('hello_world')
      expect(sanitize('hello*world')).to.equal('hello_world')
    })

    it('should preserve forward slashes', () => {
      expect(sanitize('path/to/file')).to.equal('path/to/file')
      expect(sanitize('foo/bar/baz')).to.equal('foo/bar/baz')
    })

    it('should preserve underscores', () => {
      expect(sanitize('hello_world')).to.equal('hello_world')
      expect(sanitize('foo_bar_baz')).to.equal('foo_bar_baz')
    })

    it('should preserve dots', () => {
      expect(sanitize('file.txt')).to.equal('file.txt')
      expect(sanitize('my.package.name')).to.equal('my.package.name')
    })

    it('should preserve hyphens', () => {
      expect(sanitize('my-package')).to.equal('my-package')
      expect(sanitize('foo-bar-baz')).to.equal('foo-bar-baz')
    })

    it('should preserve alphanumeric characters', () => {
      expect(sanitize('abc123')).to.equal('abc123')
      expect(sanitize('ABC123')).to.equal('abc123')
      expect(sanitize('test123abc')).to.equal('test123abc')
    })

    it('should handle multiple consecutive special characters', () => {
      expect(sanitize('hello!!!world')).to.equal('hello_world')
      expect(sanitize('foo@@@bar')).to.equal('foo_bar')
      expect(sanitize('test   spaces')).to.equal('test_spaces')
    })

    it('should handle complex combinations', () => {
      expect(sanitize('My-Package_Name/v1.2.3')).to.equal('my-package_name/v1.2.3')
      expect(sanitize('foo@bar#baz.txt')).to.equal('foo_bar_baz.txt')
      expect(sanitize('Test File (Copy).js')).to.equal('test_file_copy_.js')
    })

    it('should convert non-string values to strings first', () => {
      expect(sanitize(123)).to.equal('123')
      expect(sanitize(true)).to.equal('true')
      expect(sanitize(false)).to.equal('false')
    })

    it('should handle empty string', () => {
      expect(sanitize('')).to.equal('')
    })

    it('should handle strings with only special characters', () => {
      expect(sanitize('!!!')).to.equal('_')
      expect(sanitize('@@@')).to.equal('_')
      expect(sanitize('   ')).to.equal('_')
    })

    it('should handle unicode characters', () => {
      expect(sanitize('hello™world')).to.equal('hello_world')
      expect(sanitize('café')).to.equal('caf_')
      expect(sanitize('日本語')).to.equal('_')
    })

    it('should handle brackets and parentheses', () => {
      expect(sanitize('func()')).to.equal('func_')
      expect(sanitize('array[0]')).to.equal('array_0_')
      expect(sanitize('{object}')).to.equal('_object_')
    })

    it('should handle quotes and backticks', () => {
      expect(sanitize('"quoted"')).to.equal('_quoted_')
      expect(sanitize("'quoted'")).to.equal('_quoted_')
      expect(sanitize('`backtick`')).to.equal('_backtick_')
    })

    it('should preserve allowed characters in combination', () => {
      expect(sanitize('my_file-v1.0/test.js')).to.equal('my_file-v1.0/test.js')
      expect(sanitize('package_name-2.4.6/lib/index.js')).to.equal('package_name-2.4.6/lib/index.js')
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

      expect(config.propagateProcessTags).to.exist
      expect(config.propagateProcessTags.enabled).to.equal(true)

      SpanProcessor = require('../src/span_processor')
      const processor = new SpanProcessor(undefined, undefined, config)

      expect(processor._processTags).to.be.a('string')
      expect(processor._processTags).to.not.be.false
      expect(processor._processTags).to.include('entrypoint')
    })

    it('should disable process tags propagation when set to false', () => {
      process.env.DD_EXPERIMENTAL_PROPAGATE_PROCESS_TAGS_ENABLED = 'false'

      getConfig = require('../src/config')
      const config = getConfig()

      expect(config.propagateProcessTags).to.exist
      expect(config.propagateProcessTags.enabled).to.equal(false)

      SpanProcessor = require('../src/span_processor')
      const processor = new SpanProcessor(undefined, undefined, config)

      expect(processor._processTags).to.equal(false)
    })

    it('should disable process tags propagation when not set', () => {
      // Don't set the environment variable

      getConfig = require('../src/config')
      const config = getConfig()

      expect(config.propagateProcessTags?.enabled).to.not.equal(true)

      SpanProcessor = require('../src/span_processor')
      const processor = new SpanProcessor(undefined, undefined, config)

      expect(processor._processTags).to.equal(false)
    })
  })
})
