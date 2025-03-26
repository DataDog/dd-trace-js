'use strict'

const { isAbsolute } = require('path')
const { getNextLineNumber } = require('../helpers')

require('../../setup/tap')

const {
  getCallSites,
  getUserLandFrames
} = require('../../../src/plugins/util/stacktrace')

describe('stacktrace utils', () => {
  it('should get callsites array from getCallsites', () => {
    const callsites = getCallSites()
    expect(callsites).to.be.an('array')
    expect(callsites.length).to.be.gt(0)
    callsites.forEach((callsite) => {
      expect(callsite).to.be.an.instanceof(Object)
      expect(callsite.constructor.name).to.equal('CallSite')
      expect(callsite.getFileName).to.be.an.instanceof(Function)
    })
  })

  describe('getUserLandFrames', () => {
    it('should return array of frame objects', function helloWorld () {
      function someFunction () {
        const frames = getUserLandFrames(someFunction)

        expect(frames).to.be.an('array')
        expect(frames.length).to.be.gt(1)
        frames.forEach((frame) => {
          expect(frame).to.be.an.instanceof(Object)
          expect(frame).to.have.all.keys('file', 'line', 'column', 'method', 'type')
          expect(frame.file).to.be.a('string')
          expect(frame.line).to.be.gt(0)
          expect(frame.column).to.be.gt(0)
          expect(typeof frame.method).to.be.oneOf(['string', 'undefined'])
          expect(typeof frame.type).to.be.oneOf(['string', 'undefined'])
          expect(isAbsolute(frame.file)).to.be.true
        })

        const frame = frames[0]
        expect(frame.file).to.equal(__filename)
        expect(frame.line).to.equal(lineNumber)
        expect(frame.method).to.equal('helloWorld')
        expect(frame.type).to.equal('Test')
      }

      const lineNumber = getNextLineNumber()
      someFunction()
    })

    it('should respect limit', function helloWorld () {
      (function someFunction () {
        const frames = getUserLandFrames(someFunction, 1)
        expect(frames.length).to.equal(1)
        const frame = frames[0]
        expect(frame.file).to.equal(__filename)
        expect(frame.method).to.equal('helloWorld')
        expect(frame.type).to.equal('Test')
      })()
    })
  })
})
