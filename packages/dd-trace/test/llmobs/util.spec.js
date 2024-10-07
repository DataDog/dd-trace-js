'use strict'

const {
  encodeUnicode
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
})
