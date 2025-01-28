'use strict'

require('../../setup/tap')

const makeUtilities = require('../../../src/plugins/util/llm')

describe('llm utils', () => {
  let utils

  describe('with default configuration', () => {
    beforeEach(() => {
      utils = makeUtilities('langchain', {})
    })

    it('should normalize text to 128 characters', () => {
      const text = 'a'.repeat(256)
      expect(utils.normalize(text)).to.equal('a'.repeat(128) + '...')
    })

    it('should return undefined for empty text', () => {
      expect(utils.normalize('')).to.be.undefined
    })

    it('should return undefined for a non-string', () => {
      expect(utils.normalize(42)).to.be.undefined
    })

    it('should replace special characters', () => {
      expect(utils.normalize('a\nb\tc')).to.equal('a\\nb\\tc')
    })

    it('should always sample prompt completion', () => {
      expect(utils.isPromptCompletionSampled()).to.be.true
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
      expect(utils.normalize(text)).to.equal('a'.repeat(100) + '...')
    })

    describe('with a random value greater than 0.6', () => {
      beforeEach(() => {
        sinon.stub(Math, 'random').returns(0.7)
      })

      afterEach(() => {
        Math.random.restore()
      })

      it('should not sample prompt completion', () => {
        expect(utils.isPromptCompletionSampled()).to.be.false
      })
    })

    describe('with a random value less than 0.6', () => {
      beforeEach(() => {
        sinon.stub(Math, 'random').returns(0.5)
      })

      afterEach(() => {
        Math.random.restore()
      })

      it('should sample prompt completion', () => {
        expect(utils.isPromptCompletionSampled()).to.be.true
      })
    })
  })
})
