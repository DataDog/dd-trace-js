'use strict'
const { expect } = require('chai')
const { extractSigned } = require('../src/extraction')

describe('TUF', () => {
  describe('extractions', () => {
    it('should work on complex payloads', () => {
      const res = extractSigned(`{"signed":{"hello":{"world":"{\\""}}}`)
      expect(res).to.equal(`{"hello":{"world":"{\\""}}`)
    })
    it('should work on simple payloads', () => {
      const res = extractSigned(`{"signed":{}}`)
      expect(res).to.equal(`{}`)
    })
  })
})
