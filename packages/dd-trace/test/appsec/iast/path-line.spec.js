'use strict'

require('../../../../dd-trace/test/setup/tap')

const pathLine = require('../../../src/appsec/iast/path-line')
const path = require('path')
class CallSiteMock {
  constructor (fileName, lineNumber) {
    this.fileName = fileName
    this.lineNumber = lineNumber
  }
  getLineNumber () {
    return this.lineNumber
  }
  getFileName () {
    return this.fileName
  }

  isNative () {
    return false
  }
}

describe('path-line', function () {
  const PATH_LINE_PATH = ['packages', 'dd-trace', 'src', 'appsec', 'iast', 'path-line.js'].join(path.sep)

  const DIAGNOSTICS_CHANNEL_PATHS = [
    '/path/node_modules/diagnostics_channel/index.js',
    'node:diagnostics_channel',
    'diagnostics_channel'
  ]

  describe('getFirstNonDDPathAndLine', () => {
    // TODO: make this work regardless of the test runner
    it.skip('call does not fail', () => {
      const obj = pathLine.getFirstNonDDPathAndLine()
      expect(obj).to.not.be.null
    })
  })

  describe('calculateDDBasePath', () => {
    it('/node_modules/dd-trace', () => {
      const basePath = ['', 'node_modules', 'dd-trace', ''].join(path.sep)
      const result = pathLine.calculateDDBasePath(`${basePath}${PATH_LINE_PATH}`)
      expect(result).to.be.equals(basePath)
    })

    it('/project/path/node_modules/dd-trace', () => {
      const basePath = ['', 'project', 'path', 'node_modules', 'dd-trace', ''].join(path.sep)
      const result = pathLine.calculateDDBasePath(`${basePath}${PATH_LINE_PATH}`)
      expect(result).to.be.equals(basePath)
    })

    it('still working after path-line file refactor', () => {
      const pathLinePath = ['packages', 'maintain', 'packages', 'but', 'not', 'other', 'path.js'].join(path.sep)
      const basePath = ['', 'project', 'path', 'node_modules', 'dd-trace', ''].join(path.sep)
      const result = pathLine.calculateDDBasePath(`${basePath}${pathLinePath}`)
      expect(result).to.be.equals(basePath)
    })
    // TODO Add windows path style test
  })

  describe('getFirstNonDDPathAndLineFromCallsites', () => {
    describe('does not fail', () => {
      it('with null parameter', () => {
        pathLine.getFirstNonDDPathAndLineFromCallsites(null)
      })

      it('with empty list parameter', () => {
        pathLine.getFirstNonDDPathAndLineFromCallsites([])
      })

      it('without parameter', () => {
        pathLine.getFirstNonDDPathAndLineFromCallsites()
      })
    })

    describe('when dd-trace is in node_modules', () => {
      const PROJECT_PATH = '/project-path'
      const DD_BASE_PATH = `${PROJECT_PATH}/node_modules/dd-trace`
      const PATH_AND_LINE_PATH = `${DD_BASE_PATH}/${PATH_LINE_PATH}`
      const PATH_AND_LINE_LINE = 15
      let prevDDBasePath

      before(() => {
        prevDDBasePath = pathLine.ddBasePath
        pathLine.ddBasePath = DD_BASE_PATH
      })

      after(() => {
        pathLine.ddBasePath = prevDDBasePath
      })

      it('should return first non DD library when two stack are in dd-trace files and the next is the client line',
        () => {
          const callsites = []
          const firstFileOutOfDD = `${PROJECT_PATH}/first/file/out/of/dd.js`
          const firstFileOutOfDDLineNumber = 13
          callsites.push(new CallSiteMock(PATH_AND_LINE_PATH, PATH_AND_LINE_LINE))
          callsites.push(new CallSiteMock(`${DD_BASE_PATH}/other/file/in/dd.js`, 89))
          callsites.push(new CallSiteMock(`${DD_BASE_PATH}/other/file/in/dd.js`, 5))
          callsites.push(new CallSiteMock(firstFileOutOfDD, firstFileOutOfDDLineNumber))
          const { path, line } = pathLine.getFirstNonDDPathAndLineFromCallsites(callsites)
          expect(path).to.be.equals(firstFileOutOfDD)
          expect(line).to.be.equals(firstFileOutOfDDLineNumber)
        })

      it('should return null when all stack is in dd trace', () => {
        const callsites = []
        callsites.push(new CallSiteMock(PATH_AND_LINE_PATH, PATH_AND_LINE_LINE))
        callsites.push(new CallSiteMock(`${DD_BASE_PATH}/other/file/in/dd.js`, 89))
        callsites.push(new CallSiteMock(`${DD_BASE_PATH}/other/file/in/dd.js`, 5))
        const pathAndLine = pathLine.getFirstNonDDPathAndLineFromCallsites(callsites)
        expect(pathAndLine).to.be.null
      })

      DIAGNOSTICS_CHANNEL_PATHS.forEach((dcPath) => {
        it(`should not return ${dcPath} path`, () => {
          const callsites = []
          const firstFileOutOfDD = `${PROJECT_PATH}/first/file/out/of/dd.js`
          const firstFileOutOfDDLineNumber = 13
          callsites.push(new CallSiteMock(PATH_AND_LINE_PATH, PATH_AND_LINE_LINE))
          callsites.push(new CallSiteMock(`${DD_BASE_PATH}/other/file/in/dd.js`, 89))
          callsites.push(new CallSiteMock(dcPath, 25))
          callsites.push(new CallSiteMock(`${DD_BASE_PATH}/other/file/in/dd.js`, 5))
          callsites.push(new CallSiteMock(firstFileOutOfDD, firstFileOutOfDDLineNumber))
          const { path, line } = pathLine.getFirstNonDDPathAndLineFromCallsites(callsites)
          expect(path).to.be.equals(firstFileOutOfDD)
          expect(line).to.be.equals(firstFileOutOfDDLineNumber)
        })
      })
    })

    describe('dd-trace is in other directory', () => {
      const PROJECT_PATH = '/project-path'
      const DD_BASE_PATH = '/dd-tracer-path'
      const PATH_AND_LINE_PATH = `${DD_BASE_PATH}/packages/dd-trace/src/appsec/iast/path-line.js`
      const PATH_AND_LINE_LINE = 15
      let previousDDBasePath

      before(() => {
        previousDDBasePath = pathLine.ddBasePath
        pathLine.ddBasePath = DD_BASE_PATH
      })

      after(() => {
        pathLine.ddBasePath = previousDDBasePath
      })

      it('two in dd-trace files and the next is the client line', () => {
        const callsites = []
        const firstFileOutOfDD = `${PROJECT_PATH}/first/file/out/of/dd.js`
        const firstFileOutOfDDLineNumber = 13
        callsites.push(new CallSiteMock(PATH_AND_LINE_PATH, PATH_AND_LINE_LINE))
        callsites.push(new CallSiteMock(`${DD_BASE_PATH}/other/file/in/dd.js`, 89))
        callsites.push(new CallSiteMock(`${DD_BASE_PATH}/other/file/in/dd.js`, 5))
        callsites.push(new CallSiteMock(firstFileOutOfDD, firstFileOutOfDDLineNumber))
        const { path, line } = pathLine.getFirstNonDDPathAndLineFromCallsites(callsites)
        expect(path).to.be.equals(firstFileOutOfDD)
        expect(line).to.be.equals(firstFileOutOfDDLineNumber)
      })

      DIAGNOSTICS_CHANNEL_PATHS.forEach((dcPath) => {
        it(`should not return ${dcPath} path`, () => {
          const callsites = []
          const firstFileOutOfDD = `${PROJECT_PATH}/first/file/out/of/dd.js`
          const firstFileOutOfDDLineNumber = 13
          callsites.push(new CallSiteMock(PATH_AND_LINE_PATH, PATH_AND_LINE_LINE))
          callsites.push(new CallSiteMock(`${DD_BASE_PATH}/other/file/in/dd.js`, 89))
          callsites.push(new CallSiteMock(dcPath, 25))
          callsites.push(new CallSiteMock(`${DD_BASE_PATH}/other/file/in/dd.js`, 5))
          callsites.push(new CallSiteMock(firstFileOutOfDD, firstFileOutOfDDLineNumber))
          const { path, line } = pathLine.getFirstNonDDPathAndLineFromCallsites(callsites)
          expect(path).to.be.equals(firstFileOutOfDD)
          expect(line).to.be.equals(firstFileOutOfDDLineNumber)
        })
      })
    })
  })
})
