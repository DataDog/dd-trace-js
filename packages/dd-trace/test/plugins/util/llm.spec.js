'use strict'

const assert = require('node:assert/strict')

const { expect } = require('chai')
const { describe, it, beforeEach } = require('tap').mocha

require('../../setup/core')

const makeUtilities = require('../../../src/plugins/util/llm')
const SpanContext = require('../../../src/opentracing/span_context')
const id = require('../../../src/id')

describe('llm utils', () => {
  let utils

  describe('with default configuration', () => {
    beforeEach(() => {
      utils = makeUtilities('langchain', {})
    })

    it('should normalize text to 128 characters', () => {
      const text = 'a'.repeat(256)
      assert.strictEqual(utils.normalize(text), 'a'.repeat(128) + '...')
    })

    it('should return undefined for empty text', () => {
      assert.strictEqual(utils.normalize(''), undefined)
    })

    it('should return undefined for a non-string', () => {
      assert.strictEqual(utils.normalize(42), undefined)
    })

    it('should replace special characters', () => {
      assert.strictEqual(utils.normalize('a\nb\tc'), 'a\\nb\\tc')
    })

    it('should always sample prompt completion', () => {
      expect(utils.isPromptCompletionSampled(new SpanContext({ traceId: id() }))).to.be.true
    })
  })

  describe('with custom configuration available', () => {
    beforeEach(() => {
      utils = makeUtilities('langchain', {
        langchain: {
          spanCharLimit: 100,
          spanPromptCompletionSampleRate: 0.6
        }
      })
    })

    it('should normalize text to 100 characters', () => {
      const text = 'a'.repeat(256)
      assert.strictEqual(utils.normalize(text), 'a'.repeat(100) + '...')
    })

    describe('with sampling rate 0.6', () => {
      it('should not sample prompt completion', () => {
        expect(utils.isPromptCompletionSampled(new SpanContext({ traceId: id('8081965455359722133', 10) }))).to.be.false
      })

      it('should sample prompt completion', () => {
        expect(utils.isPromptCompletionSampled(new SpanContext({ traceId: id('5533085789307409170', 10) }))).to.be.true
      })
    })
  })
})
