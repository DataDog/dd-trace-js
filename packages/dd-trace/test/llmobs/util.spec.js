'use strict'

const { SPAN_TYPE } = require('../../../../ext/tags')
const {
  encodeUnicode,
  isLLMSpan
} = require('../../src/llmobs/util')

describe('util', () => {
  describe('encodeUnicode', () => {
    it('should encode unicode characters', () => {
      expect(encodeUnicode('😀')).to.equal('\\ud83d\\ude00')
    })

    it('should encode only unicode characters in a string', () => {
      expect(encodeUnicode('test 😀')).to.equal('test \\ud83d\\ude00')
    })
  })

  describe('isLLMSpan', () => {
    it('should return false for an undefined span', () => {
      expect(isLLMSpan(undefined)).to.equal(false)
    })

    it('should return false for a span without a SPAN_KIND tag', () => {
      const span = { context: () => ({ _tags: {} }) }
      expect(isLLMSpan(span)).to.equal(false)
    })

    it('should return false for a span with an invalid span type', () => {
      const span = { context: () => ({ _tags: { [SPAN_TYPE]: 'invalid' } }) }
      expect(isLLMSpan(span)).to.equal(false)
    })

    for (const spanType of ['llm', 'openai']) {
      it(`should return true for a span with a valid span type: ${spanType}`, () => {
        const span = { context: () => ({ _tags: { [SPAN_TYPE]: spanType } }) }
        expect(isLLMSpan(span)).to.equal(true)
      })
    }
  })
})
