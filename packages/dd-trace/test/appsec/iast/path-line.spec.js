const proxyquire = require('proxyquire')
const path = require('path')
const os = require('os')
const { expect } = require('chai')

class CallSiteMock {
  constructor (fileName, lineNumber, columnNumber = 0) {
    this.fileName = fileName
    this.lineNumber = lineNumber
    this.columnNumber = columnNumber
  }
  getLineNumber () {
    return this.lineNumber
  }
  getColumnNumber () {
    return this.columnNumber
  }
  getFileName () {
    return this.fileName
  }

  isNative () {
    return false
  }
}

describe('path-line', function () {
  const PATH_LINE_PATH = path.join('packages', 'dd-trace', 'src', 'appsec', 'iast', 'path-line.js')

  const tmpdir = os.tmpdir()
  const firstSep = tmpdir.indexOf(path.sep)
  const rootPath = tmpdir.slice(0, firstSep + 1)

  const DIAGNOSTICS_CHANNEL_PATHS = [
    path.join(rootPath, 'path', 'node_modules', 'diagnostics_channel', 'index.js'),
    'node:diagnostics_channel',
    'diagnostics_channel'
  ]
  let mockPath, pathLine, mockProcess
  beforeEach(() => {
    mockPath = {}
    mockProcess = {}
    pathLine = proxyquire('../../../src/appsec/iast/path-line', {
      'path': mockPath,
      'process': mockProcess
    })
  })
  describe('getFirstNonDDPathAndLine', () => {
    it('call does not fail', () => {
      const obj = pathLine.getFirstNonDDPathAndLine()
      expect(obj).to.not.be.null
    })
  })

  describe('calculateDDBasePath', () => {
    it('/node_modules/dd-trace', () => {
      const basePath = path.join(rootPath, 'node_modules', 'dd-trace', path.sep)
      const result = pathLine.calculateDDBasePath(path.join(basePath, PATH_LINE_PATH))
      expect(result).to.be.equals(basePath)
    })

    it('/packages/project/path/node_modules/dd-trace', () => {
      const basePath = path.join(rootPath, 'packages', 'project', 'path', 'node_modules', 'dd-trace', path.sep)
      const result = pathLine.calculateDDBasePath(path.join(basePath, PATH_LINE_PATH))
      expect(result).to.be.equals(basePath)
    })

    it('/project/path/node_modules/dd-trace', () => {
      const basePath = path.join(rootPath, 'project', 'path', 'node_modules', 'dd-trace', path.sep)
      const result = pathLine.calculateDDBasePath(path.join(basePath, PATH_LINE_PATH))
      expect(result).to.be.equals(basePath)
    })
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

      it('should return first non DD library when two stack are in dd-trace files and the next is the client line',
        () => {
          const callsites = []
          const expectedFirstFileOutOfDD = path.join('first', 'file', 'out', 'of', 'dd.js')
          const firstFileOutOfDD = path.join(PROJECT_PATH, expectedFirstFileOutOfDD)
          const firstFileOutOfDDLineNumber = 13

          callsites.push(new CallSiteMock(PATH_AND_LINE_PATH, PATH_AND_LINE_LINE))
          callsites.push(new CallSiteMock(path.join(DD_BASE_PATH, 'other', 'file', 'in', 'dd.js'), 89))
          callsites.push(new CallSiteMock(path.join(DD_BASE_PATH, 'other', 'file', 'in', 'dd.js'), 5))
          callsites.push(new CallSiteMock(firstFileOutOfDD, firstFileOutOfDDLineNumber, 42))
          const pathAndLine = pathLine.getFirstNonDDPathAndLineFromCallsites(callsites)
          expect(pathAndLine.path).to.be.equals(expectedFirstFileOutOfDD)
          expect(pathAndLine.line).to.be.equals(firstFileOutOfDDLineNumber)
          expect(pathAndLine.column).to.be.equals(42)
        })

      it('should return null when all stack is in dd trace', () => {
        const callsites = []
        callsites.push(new CallSiteMock(PATH_AND_LINE_PATH, PATH_AND_LINE_LINE))
        callsites.push(new CallSiteMock(path.join(DD_BASE_PATH, 'other', 'file', 'in', 'dd.js'), 89))
        callsites.push(new CallSiteMock(path.join(DD_BASE_PATH, 'other', 'file', 'in', 'dd.js'), 5))
        const pathAndLine = pathLine.getFirstNonDDPathAndLineFromCallsites(callsites)
        expect(pathAndLine).to.be.null
      })

      DIAGNOSTICS_CHANNEL_PATHS.forEach((dcPath) => {
        it(`should not return ${dcPath} path`, () => {
          const callsites = []
          const expectedFirstFileOutOfDD = path.join('first', 'file', 'out', 'of', 'dd.js')
          const firstFileOutOfDD = path.join(PROJECT_PATH, expectedFirstFileOutOfDD)
          const firstFileOutOfDDLineNumber = 13
          callsites.push(new CallSiteMock(PATH_AND_LINE_PATH, PATH_AND_LINE_LINE))
          callsites.push(new CallSiteMock(path.join(DD_BASE_PATH, 'other', 'file', 'in', 'dd.js'), 89))
          callsites.push(new CallSiteMock(dcPath, 25))
          callsites.push(new CallSiteMock(path.join(DD_BASE_PATH, 'other', 'file', 'in', 'dd.js'), 5))
          callsites.push(new CallSiteMock(firstFileOutOfDD, firstFileOutOfDDLineNumber, 42))
          const pathAndLine = pathLine.getFirstNonDDPathAndLineFromCallsites(callsites)
          expect(pathAndLine.path).to.be.equals(expectedFirstFileOutOfDD)
          expect(pathAndLine.line).to.be.equals(firstFileOutOfDDLineNumber)
          expect(pathAndLine.column).to.be.equals(42)
        })
      })
    })

    describe('dd-trace is in other directory', () => {
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

      it('two in dd-trace files and the next is the client line', () => {
        const callsites = []
        const expectedFilePath = path.join('first', 'file', 'out', 'of', 'dd.js')
        const firstFileOutOfDD = path.join(PROJECT_PATH, expectedFilePath)
        const firstFileOutOfDDLineNumber = 13
        callsites.push(new CallSiteMock(PATH_AND_LINE_PATH, PATH_AND_LINE_LINE))
        callsites.push(new CallSiteMock(path.join(DD_BASE_PATH, 'other', 'file', 'in', 'dd.js'), 89))
        callsites.push(new CallSiteMock(path.join(DD_BASE_PATH, 'other', 'file', 'in', 'dd.js'), 5))
        callsites.push(new CallSiteMock(firstFileOutOfDD, firstFileOutOfDDLineNumber, 42))
        const pathAndLine = pathLine.getFirstNonDDPathAndLineFromCallsites(callsites)
        expect(pathAndLine.path).to.be.equals(expectedFilePath)
        expect(pathAndLine.line).to.be.equals(firstFileOutOfDDLineNumber)
        expect(pathAndLine.column).to.be.equals(42)
      })

      DIAGNOSTICS_CHANNEL_PATHS.forEach((dcPath) => {
        it(`should not return ${dcPath} path`, () => {
          const callsites = []
          const expectedFilePath = path.join('first', 'file', 'out', 'of', 'dd.js')
          const firstFileOutOfDD = path.join(PROJECT_PATH, expectedFilePath)
          const firstFileOutOfDDLineNumber = 13
          callsites.push(new CallSiteMock(PATH_AND_LINE_PATH, PATH_AND_LINE_LINE))
          callsites.push(new CallSiteMock(path.join(DD_BASE_PATH, 'other', 'file', 'in', 'dd.js'), 89))
          callsites.push(new CallSiteMock(dcPath, 25))
          callsites.push(new CallSiteMock(path.join(DD_BASE_PATH, 'other', 'file', 'in', 'dd.js'), 5))
          callsites.push(new CallSiteMock(firstFileOutOfDD, firstFileOutOfDDLineNumber, 42))
          const pathAndLine = pathLine.getFirstNonDDPathAndLineFromCallsites(callsites)
          expect(pathAndLine.path).to.be.equals(expectedFilePath)
          expect(pathAndLine.line).to.be.equals(firstFileOutOfDDLineNumber)
          expect(pathAndLine.column).to.be.equals(42)
        })
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

      const list = getCallSiteInfo()
      const firstNonDDPath = pathLine.getFirstNonDDPathAndLineFromCallsites(list)

      const nodeModulesPaths = pathLine.getNodeModulesPaths(__filename)
      expect(nodeModulesPaths[0]).to.eq(path.join('node_modules', process.cwd(), firstNonDDPath.path))

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
