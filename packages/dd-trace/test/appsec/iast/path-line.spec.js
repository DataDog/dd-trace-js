'use strict'

const proxyquire = require('proxyquire')
const path = require('path')
const os = require('os')
const { expect } = require('chai')
const { getCallsiteFrames } = require('../../../src/appsec/stack-trace')

class CallSiteMock {
  constructor (fileName, lineNumber, columnNumber = 0) {
    this.file = fileName
    this.line = lineNumber
    this.column = columnNumber
  }

  get isNative () {
    return false
  }
}

describe('path-line', function () {
  const PATH_LINE_PATH = path.join('dd-trace', 'src', 'appsec', 'iast', 'path-line.js')

  const tmpdir = os.tmpdir()
  const firstSep = tmpdir.indexOf(path.sep)
  const rootPath = tmpdir.slice(0, firstSep + 1)

  const DIAGNOSTICS_CHANNEL_PATHS = [
    path.join(rootPath, 'path', 'node_modules', 'dc-polyfill'),
    'node:diagnostics_channel',
    'diagnostics_channel'
  ]
  let mockPath, pathLine, mockProcess

  beforeEach(() => {
    mockPath = {}
    mockProcess = {}
    pathLine = proxyquire('../../../src/appsec/iast/path-line', {
      path: mockPath,
      process: mockProcess
    })
  })

  describe('getNonDDCallSiteFrames', () => {
    describe('does not fail', () => {
      it('with null parameter', () => {
        const result = pathLine.getNonDDCallSiteFrames(null)
        expect(result).to.be.an('array').that.is.empty
      })

      it('with empty list parameter', () => {
        const result = pathLine.getNonDDCallSiteFrames([])
        expect(result).to.be.an('array').that.is.empty
      })

      it('without parameter', () => {
        const result = pathLine.getNonDDCallSiteFrames()
        expect(result).to.be.an('array').that.is.empty
      })
    })

    describe('when dd-trace is in node_modules', () => {
      const PROJECT_PATH = path.join(rootPath, 'project-path')
      const DD_BASE_PATH = path.join(PROJECT_PATH, 'node_modules', 'dd-trace')
      const PATH_AND_LINE_PATH = path.join(DD_BASE_PATH, PATH_LINE_PATH)
      const PATH_AND_LINE_LINE = 15
      let prevDDBasePath

      beforeEach(() => {
        prevDDBasePath = pathLine.ddBasePath
        pathLine.ddBasePath = DD_BASE_PATH
        mockProcess.cwd = () => PROJECT_PATH
      })

      afterEach(() => {
        pathLine.ddBasePath = prevDDBasePath
      })

      it('should return all no DD entries when multiple stack frames are present', () => {
        const callsites = []
        const expectedFilePaths = [
          path.join('first', 'file', 'out', 'of', 'dd.js'),
          path.join('second', 'file', 'out', 'of', 'dd.js')
        ]
        const firstFileOutOfDD = path.join(PROJECT_PATH, expectedFilePaths[0])
        const secondFileOutOfDD = path.join(PROJECT_PATH, expectedFilePaths[1])

        callsites.push(new CallSiteMock(PATH_AND_LINE_PATH, PATH_AND_LINE_LINE))
        callsites.push(new CallSiteMock(path.join(DD_BASE_PATH, 'other', 'file', 'in', 'dd.js'), 89))
        callsites.push(new CallSiteMock(firstFileOutOfDD, 13, 42))
        callsites.push(new CallSiteMock(secondFileOutOfDD, 20, 15))

        const results = pathLine.getNonDDCallSiteFrames(callsites)

        expect(results).to.have.lengthOf(2)

        expect(results[0].path).to.be.equals(expectedFilePaths[0])
        expect(results[0].line).to.be.equals(13)
        expect(results[0].column).to.be.equals(42)

        expect(results[1].path).to.be.equals(expectedFilePaths[1])
        expect(results[1].line).to.be.equals(20)
        expect(results[1].column).to.be.equals(15)
      })

      it('should return an empty array when all stack frames are in dd trace', () => {
        const callsites = []
        callsites.push(new CallSiteMock(PATH_AND_LINE_PATH, PATH_AND_LINE_LINE))
        callsites.push(new CallSiteMock(path.join(DD_BASE_PATH, 'other', 'file', 'in', 'dd.js'), 89))
        callsites.push(new CallSiteMock(path.join(DD_BASE_PATH, 'another', 'file', 'in', 'dd.js'), 5))

        const results = pathLine.getNonDDCallSiteFrames(callsites)
        expect(results).to.be.an('array').that.is.empty
      })

      DIAGNOSTICS_CHANNEL_PATHS.forEach((dcPath) => {
        it(`should exclude ${dcPath} from the results`, () => {
          const callsites = []
          const expectedFilePath = path.join('first', 'file', 'out', 'of', 'dd.js')
          const firstFileOutOfDD = path.join(PROJECT_PATH, expectedFilePath)

          callsites.push(new CallSiteMock(PATH_AND_LINE_PATH, PATH_AND_LINE_LINE))
          callsites.push(new CallSiteMock(path.join(DD_BASE_PATH, 'other', 'file', 'in', 'dd.js'), 89))
          callsites.push(new CallSiteMock(dcPath, 25))
          callsites.push(new CallSiteMock(firstFileOutOfDD, 13, 42))

          const results = pathLine.getNonDDCallSiteFrames(callsites)
          expect(results).to.have.lengthOf(1)

          expect(results[0].path).to.be.equals(expectedFilePath)
          expect(results[0].line).to.be.equals(13)
          expect(results[0].column).to.be.equals(42)
        })
      })
    })

    describe('dd-trace is in another directory', () => {
      const PROJECT_PATH = path.join(tmpdir, 'project-path')
      const DD_BASE_PATH = path.join(tmpdir, 'dd-tracer-path')
      const PATH_AND_LINE_PATH = path.join(DD_BASE_PATH, 'packages',
        'dd-trace', 'src', 'appsec', 'iast', 'path-line.js')
      const PATH_AND_LINE_LINE = 15
      let previousDDBasePath

      beforeEach(() => {
        previousDDBasePath = pathLine.ddBasePath
        pathLine.ddBasePath = DD_BASE_PATH
        mockProcess.cwd = () => PROJECT_PATH
      })

      afterEach(() => {
        pathLine.ddBasePath = previousDDBasePath
      })

      it('should return all non-DD entries', () => {
        const callsites = []
        const expectedFilePaths = [
          path.join('first', 'file', 'out', 'of', 'dd.js'),
          path.join('second', 'file', 'out', 'of', 'dd.js')
        ]
        const firstFileOutOfDD = path.join(PROJECT_PATH, expectedFilePaths[0])
        const secondFileOutOfDD = path.join(PROJECT_PATH, expectedFilePaths[1])

        callsites.push(new CallSiteMock(PATH_AND_LINE_PATH, PATH_AND_LINE_LINE))
        callsites.push(new CallSiteMock(path.join(DD_BASE_PATH, 'other', 'file', 'in', 'dd.js'), 89))
        callsites.push(new CallSiteMock(firstFileOutOfDD, 13, 42))
        callsites.push(new CallSiteMock(secondFileOutOfDD, 20, 15))

        const results = pathLine.getNonDDCallSiteFrames(callsites)
        expect(results).to.have.lengthOf(2)

        expect(results[0].path).to.be.equals(expectedFilePaths[0])
        expect(results[0].line).to.be.equals(13)
        expect(results[0].column).to.be.equals(42)

        expect(results[1].path).to.be.equals(expectedFilePaths[1])
        expect(results[1].line).to.be.equals(20)
        expect(results[1].column).to.be.equals(15)
      })
    })
  })

  describe('getNodeModulesPaths', () => {
    function getCallSiteInfo () {
      const previousPrepareStackTrace = Error.prepareStackTrace
      const previousStackTraceLimit = Error.stackTraceLimit
      let callsiteList
      Error.stackTraceLimit = 100
      Error.prepareStackTrace = function (_, callsites) {
        callsiteList = callsites
      }
      const e = new Error()
      e.stack
      Error.prepareStackTrace = previousPrepareStackTrace
      Error.stackTraceLimit = previousStackTraceLimit

      return callsiteList
    }

    it('should handle windows paths correctly', () => {
      const basePath = pathLine.ddBasePath
      pathLine.ddBasePath = path.join('test', 'base', 'path')

      const list = getCallsiteFrames(32, getCallSiteInfo, getCallSiteInfo)
      const firstNonDDPath = pathLine.getNonDDCallSiteFrames(list)[0]

      const expectedPath = path.join('node_modules', firstNonDDPath.path)
      const nodeModulesPaths = pathLine.getNodeModulesPaths(firstNonDDPath.path)

      expect(nodeModulesPaths[0]).to.equal(expectedPath)

      pathLine.ddBasePath = basePath
    })

    it('should convert / to \\ in windows platforms', () => {
      const dirname = __dirname
      const dirParts = dirname.split(path.sep)
      const paths = pathLine.getNodeModulesPaths(dirParts.join('/'))

      expect(paths[0]).to.equals(path.join('node_modules', dirname))
    })

    it('should return multiple paths', () => {
      const paths = pathLine.getNodeModulesPaths('/this/is/a/path', '/another/path')

      expect(paths.length).to.equals(2)
      expect(paths[0].startsWith('node_modules')).to.true
    })
  })
})
