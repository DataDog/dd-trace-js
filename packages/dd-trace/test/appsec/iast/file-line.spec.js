const fileLine = require('../../../src/appsec/iast/file-line')
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
}

describe('file-line', function () {
  const FILE_LINE_PATH = ['packages', 'dd-trace', 'src', 'appsec', 'iast', 'file-line.js'].join(path.sep)
  describe('getFirstNonDDFileAndLine', () => {
    it('call does not fail', () => {
      const obj = fileLine.getFirstNonDDFileAndLine()
      expect(obj).to.not.be.null
    })
  })

  describe('calculateDDBasePath', () => {
    it('/node_modules/dd-trace', () => {
      const basePath = ['', 'node_modules', 'dd-trace', ''].join(path.sep)
      const result = fileLine.calculateDDBasePath(`${basePath}${FILE_LINE_PATH}`)
      expect(result).to.be.equals(basePath)
    })

    it('/project/path/node_modules/dd-trace', () => {
      const basePath = ['', 'project', 'path', 'node_modules', 'dd-trace', ''].join(path.sep)
      const result = fileLine.calculateDDBasePath(`${basePath}${FILE_LINE_PATH}`)
      expect(result).to.be.equals(basePath)
    })

    it('still working after file-line file refactor', () => {
      const fileLinePath = ['packages', 'maintain', 'packages', 'but', 'not', 'other', 'path.js'].join(path.sep)
      const basePath = ['', 'project', 'path', 'node_modules', 'dd-trace', ''].join(path.sep)
      const result = fileLine.calculateDDBasePath(`${basePath}${fileLinePath}`)
      expect(result).to.be.equals(basePath)
    })
    // TODO Add windows path style test
  })

  describe('getFirstNonDDFileAndLineFromCallsites', () => {
    describe('does not fail', () => {
      it('with null parameter', () => {
        fileLine.getFirstNonDDFileAndLineFromCallsites(null)
      })

      it('with empty list parameter', () => {
        fileLine.getFirstNonDDFileAndLineFromCallsites([])
      })

      it('without parameter', () => {
        fileLine.getFirstNonDDFileAndLineFromCallsites()
      })
    })

    describe('dd-trace is in node_modules', () => {
      const PROJECT_PATH = '/project-path'
      const DD_BASE_PATH = `${PROJECT_PATH}/node_modules/dd-trace`
      const FILE_AND_LINE_PATH = `${DD_BASE_PATH}/${FILE_LINE_PATH}`
      const FILE_AND_LINE_LINE = 15
      let prevDDBasePath

      before(() => {
        prevDDBasePath = fileLine.ddBasePath
        fileLine.ddBasePath = DD_BASE_PATH
      })

      after(() => {
        fileLine.ddBasePath = prevDDBasePath
      })

      it('two in dd-trace files and the next is the client line', () => {
        const callsites = []
        const firstFileOutOfDD = `${PROJECT_PATH}/first/file/out/of/dd.js`
        const firstFileOutOfDDLineNumber = 13
        callsites.push(new CallSiteMock(FILE_AND_LINE_PATH, FILE_AND_LINE_LINE))
        callsites.push(new CallSiteMock(`${DD_BASE_PATH}/other/file/in/dd.js`, 89))
        callsites.push(new CallSiteMock(`${DD_BASE_PATH}/other/file/in/dd.js`, 5))
        callsites.push(new CallSiteMock(firstFileOutOfDD, firstFileOutOfDDLineNumber))
        const { file, line } = fileLine.getFirstNonDDFileAndLineFromCallsites(callsites)
        expect(file).to.be.equals(firstFileOutOfDD)
        expect(line).to.be.equals(firstFileOutOfDDLineNumber)
      })

      it('all is in dd trace returns null', () => {
        const callsites = []
        callsites.push(new CallSiteMock(FILE_AND_LINE_PATH, FILE_AND_LINE_LINE))
        callsites.push(new CallSiteMock(`${DD_BASE_PATH}/other/file/in/dd.js`, 89))
        callsites.push(new CallSiteMock(`${DD_BASE_PATH}/other/file/in/dd.js`, 5))
        const fileAndLine = fileLine.getFirstNonDDFileAndLineFromCallsites(callsites)
        expect(fileAndLine).to.be.null
      })
    })

    describe('dd-trace is in other directory', () => {
      const PROJECT_PATH = '/project-path'
      const DD_BASE_PATH = '/dd-tracer-path'
      const FILE_AND_LINE_PATH = `${DD_BASE_PATH}/packages/dd-trace/src/appsec/iast/file-line.js`
      const FILE_AND_LINE_LINE = 15
      let previousDDBasePath

      before(() => {
        previousDDBasePath = fileLine.ddBasePath
        fileLine.ddBasePath = DD_BASE_PATH
      })

      after(() => {
        fileLine.ddBasePath = previousDDBasePath
      })

      it('two in dd-trace files and the next is the client line', () => {
        const callsites = []
        const firstFileOutOfDD = `${PROJECT_PATH}/first/file/out/of/dd.js`
        const firstFileOutOfDDLineNumber = 13
        callsites.push(new CallSiteMock(FILE_AND_LINE_PATH, FILE_AND_LINE_LINE))
        callsites.push(new CallSiteMock(`${DD_BASE_PATH}/other/file/in/dd.js`, 89))
        callsites.push(new CallSiteMock(`${DD_BASE_PATH}/other/file/in/dd.js`, 5))
        callsites.push(new CallSiteMock(firstFileOutOfDD, firstFileOutOfDDLineNumber))
        const { file, line } = fileLine.getFirstNonDDFileAndLineFromCallsites(callsites)
        expect(file).to.be.equals(firstFileOutOfDD)
        expect(line).to.be.equals(firstFileOutOfDDLineNumber)
      })
    })
  })
})
