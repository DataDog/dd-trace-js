'use strict'

const { expect } = require('chai')
const { describe, it } = require('mocha')

const {
  joinPath,
  normalizeRoutePath,
  normalizeRoutePaths
} = require('../../src/helpers/router-helper')

describe('helpers/router-helper', () => {
  describe('normalizeRoutePath', () => {
    it('should return null for nullish values', () => {
      expect(normalizeRoutePath(null)).to.equal(null)
      expect(normalizeRoutePath(undefined)).to.equal(null)
    })

    it('should convert regular expressions to strings', () => {
      const regex = /^\/item\/(\d+)$/
      expect(normalizeRoutePath(regex)).to.equal(regex.toString())
    })

    it('should stringify non-string primitives', () => {
      expect(normalizeRoutePath(42)).to.equal('42')
      expect(normalizeRoutePath(true)).to.equal('true')
    })
  })

  describe('normalizeRoutePaths', () => {
    it('should wrap a single string path in an array', () => {
      expect(normalizeRoutePaths('/foo')).to.deep.equal(['/foo'])
    })

    it('should flatten nested arrays', () => {
      const input = ['/one', ['/two', ['/three']]]
      expect(normalizeRoutePaths(input)).to.deep.equal(['/one', '/two', '/three'])
    })

    it('should normalize mixed values', () => {
      const regex = /^\/item\/(\d+)$/
      const input = ['/base', [regex, null, undefined]]
      expect(normalizeRoutePaths(input)).to.deep.equal(['/base', regex.toString()])
    })
  })

  describe('joinPath', () => {
    it('should join base and child paths', () => {
      expect(joinPath('/base', '/child')).to.equal('/base/child')
    })

    it('should handle root base', () => {
      expect(joinPath('/', '/child')).to.equal('/child')
    })

    it('should handle root path', () => {
      expect(joinPath('/base', '/')).to.equal('/base')
    })

    it('should return root when both parts empty', () => {
      expect(joinPath('', '')).to.equal('/')
    })
  })
})
