'use strict'

const t = require('tap')
require('../../setup/core')

const makeUtilities = require('../../../src/plugins/util/llm')
const SpanContext = require('../../../src/opentracing/span_context')
const id = require('../../../src/id')

t.test('llm utils', t => {
  let utils

  t.test('with default configuration', t => {
    t.beforeEach(() => {
      utils = makeUtilities('langchain', {})
    })

    t.test('should normalize text to 128 characters', t => {
      const text = 'a'.repeat(256)
      expect(utils.normalize(text)).to.equal('a'.repeat(128) + '...')
      t.end()
    })

    t.test('should return undefined for empty text', t => {
      expect(utils.normalize('')).to.be.undefined
      t.end()
    })

    t.test('should return undefined for a non-string', t => {
      expect(utils.normalize(42)).to.be.undefined
      t.end()
    })

    t.test('should replace special characters', t => {
      expect(utils.normalize('a\nb\tc')).to.equal('a\\nb\\tc')
      t.end()
    })

    t.test('should always sample prompt completion', t => {
      expect(utils.isPromptCompletionSampled(new SpanContext({ traceId: id() }))).to.be.true
      t.end()
    })
    t.end()
  })

  t.test('with custom configuration available', t => {
    t.beforeEach(() => {
      utils = makeUtilities('langchain', {
        langchain: {
          spanCharLimit: 100,
          spanPromptCompletionSampleRate: 0.6
        }
      })
    })

    t.test('should normalize text to 100 characters', t => {
      const text = 'a'.repeat(256)
      expect(utils.normalize(text)).to.equal('a'.repeat(100) + '...')
      t.end()
    })

    t.test('with sampling rate 0.6', t => {
      t.test('should not sample prompt completion', t => {
        expect(utils.isPromptCompletionSampled(new SpanContext({ traceId: id('8081965455359722133', 10) }))).to.be.false
        t.end()
      })

      t.test('should sample prompt completion', t => {
        expect(utils.isPromptCompletionSampled(new SpanContext({ traceId: id('5533085789307409170', 10) }))).to.be.true
        t.end()
      })
      t.end()
    })
    t.end()
  })
  t.end()
})
