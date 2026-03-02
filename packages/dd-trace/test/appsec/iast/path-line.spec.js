'use strict'

const assert = require('node:assert/strict')
const os = require('os')
const path = require('path')

const proxyquire = require('proxyquire')

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

  const EXCLUDED_TEST_PATHS = [
    path.join(rootPath, 'path', 'node_modules', 'dc-polyfill'),
    'node:diagnostics_channel',
    'node:fs',
    'node:events',
    'node:internal/async_local_storage',
  ]
  let mockPath, pathLine, mockProcess

  beforeEach(() => {
    mockPath = {}
    mockProcess = {}
    pathLine = proxyquire('../../../src/appsec/iast/path-line', {
      path: mockPath,
      process: mockProcess,
    })
  })

  describe('getCallSiteFramesForLocation', () => {
    describe('does not fail', () => {
      it('with null parameter', () => {
        const result = pathLine.getCallSiteFramesForLocation(null)
        assert.deepStrictEqual(result, [])
      })

      it('with empty list parameter', () => {
        const result = pathLine.getCallSiteFramesForLocation([])
        assert.deepStrictEqual(result, [])
      })

      it('without parameter', () => {
        const result = pathLine.getCallSiteFramesForLocation()
        assert.deepStrictEqual(result, [])
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
          path.join('second', 'file', 'out', 'of', 'dd.js'),
        ]
        const firstFileOutOfDD = path.join(PROJECT_PATH, expectedFilePaths[0])
        const secondFileOutOfDD = path.join(PROJECT_PATH, expectedFilePaths[1])

        callsites.push(new CallSiteMock(PATH_AND_LINE_PATH, PATH_AND_LINE_LINE))
        callsites.push(new CallSiteMock(path.join(DD_BASE_PATH, 'other', 'file', 'in', 'dd.js'), 89))
        callsites.push(new CallSiteMock(firstFileOutOfDD, 13, 42))
        callsites.push(new CallSiteMock(secondFileOutOfDD, 20, 15))

        const results = pathLine.getCallSiteFramesForLocation(callsites)

        assert.strictEqual(results.length, 2)

        assert.strictEqual(results[0].path, expectedFilePaths[0])
        assert.strictEqual(results[0].line, 13)
        assert.strictEqual(results[0].column, 42)

        assert.strictEqual(results[1].path, expectedFilePaths[1])
        assert.strictEqual(results[1].line, 20)
        assert.strictEqual(results[1].column, 15)
      })

      it('should fallback to all processed frames when all stack frames are in dd trace', () => {
        const callsites = []
        callsites.push(new CallSiteMock(PATH_AND_LINE_PATH, PATH_AND_LINE_LINE))
        callsites.push(new CallSiteMock(path.join(DD_BASE_PATH, 'other', 'file', 'in', 'dd.js'), 89))
        callsites.push(new CallSiteMock(path.join(DD_BASE_PATH, 'another', 'file', 'in', 'dd.js'), 5))

        const results = pathLine.getCallSiteFramesForLocation(callsites)

        assert.strictEqual(results.length, 3)
        assert.ok(results.every(r => r.path && typeof r.isInternal === 'boolean'))
      })

      EXCLUDED_TEST_PATHS.forEach((dcPath) => {
        it(`should exclude ${dcPath} from the results`, () => {
          const callsites = []
          const expectedFilePath = path.join('first', 'file', 'out', 'of', 'dd.js')
          const firstFileOutOfDD = path.join(PROJECT_PATH, expectedFilePath)

          callsites.push(new CallSiteMock(PATH_AND_LINE_PATH, PATH_AND_LINE_LINE))
          callsites.push(new CallSiteMock(path.join(DD_BASE_PATH, 'other', 'file', 'in', 'dd.js'), 89))
          callsites.push(new CallSiteMock(dcPath, 25))
          callsites.push(new CallSiteMock(firstFileOutOfDD, 13, 42))

          const results = pathLine.getCallSiteFramesForLocation(callsites)
          assert.strictEqual(results.length, 1)

          assert.strictEqual(results[0].path, expectedFilePath)
          assert.strictEqual(results[0].line, 13)
          assert.strictEqual(results[0].column, 42)
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
          path.join('second', 'file', 'out', 'of', 'dd.js'),
        ]
        const firstFileOutOfDD = path.join(PROJECT_PATH, expectedFilePaths[0])
        const secondFileOutOfDD = path.join(PROJECT_PATH, expectedFilePaths[1])

        callsites.push(new CallSiteMock(PATH_AND_LINE_PATH, PATH_AND_LINE_LINE))
        callsites.push(new CallSiteMock(path.join(DD_BASE_PATH, 'other', 'file', 'in', 'dd.js'), 89))
        callsites.push(new CallSiteMock(firstFileOutOfDD, 13, 42))
        callsites.push(new CallSiteMock(secondFileOutOfDD, 20, 15))

        const results = pathLine.getCallSiteFramesForLocation(callsites)
        assert.strictEqual(results.length, 2)

        assert.strictEqual(results[0].path, expectedFilePaths[0])
        assert.strictEqual(results[0].line, 13)
        assert.strictEqual(results[0].column, 42)

        assert.strictEqual(results[1].path, expectedFilePaths[1])
        assert.strictEqual(results[1].line, 20)
        assert.strictEqual(results[1].column, 15)
      })
    })

    describe('when dd-trace is bundled', () => {
      let previousDDBasePath
      const PROJECT_PATH = path.join(tmpdir, 'project-path')
      const OUT_BUILD_PATH = path.join(tmpdir, 'build-path')

      describe('with esbuild sourcemap', () => {
        const DD_BASE_PATH = path.join(tmpdir, 'dd-tracer-path')

        beforeEach(() => {
          pathLine = proxyquire('../../../src/appsec/iast/path-line', {
            process: mockProcess,
            './taint-tracking/rewriter': {
              getOriginalPathAndLineFromSourceMap: ({ path: filePath, line, column }) => {
                return {
                  path: path.join(line % 2 ? DD_BASE_PATH : PROJECT_PATH, 'file.js'),
                  line,
                  column,
                }
              },
            },
          })

          previousDDBasePath = pathLine.ddBasePath
          pathLine.ddBasePath = DD_BASE_PATH
          mockProcess.cwd = () => PROJECT_PATH
        })

        afterEach(() => {
          pathLine.ddBasePath = previousDDBasePath
        })

        before(() => {
          globalThis.__DD_ESBUILD_IAST_WITH_SM = true
          globalThis.__DD_ESBUILD_IAST_WITH_NO_SM = false
        })

        after(() => {
          delete globalThis.__DD_ESBUILD_IAST_WITH_SM
          delete globalThis.__DD_ESBUILD_IAST_WITH_NO_SM
        })

        it('should return all non-DD entries', () => {
          const callsites = []
          const bundleOutFile = 'out.js'

          callsites.push(new CallSiteMock(path.join(PROJECT_PATH, bundleOutFile), 1))
          callsites.push(new CallSiteMock(path.join(PROJECT_PATH, bundleOutFile), 2, 14))
          callsites.push(new CallSiteMock(path.join(PROJECT_PATH, bundleOutFile), 3))
          callsites.push(new CallSiteMock(path.join(PROJECT_PATH, bundleOutFile), 4, 71))

          const results = pathLine.getCallSiteFramesForLocation(callsites)
          assert.strictEqual(results.length, 2)

          assert.strictEqual(results[0].path, 'file.js')
          assert.strictEqual(results[0].line, 2)
          assert.strictEqual(results[0].column, 14)

          assert.strictEqual(results[1].path, 'file.js')
          assert.strictEqual(results[1].line, 4)
          assert.strictEqual(results[1].column, 71)
        })
      })

      describe('no esbuild sourcemap', () => {
        const DD_BASE_PATH = OUT_BUILD_PATH

        beforeEach(() => {
          previousDDBasePath = pathLine.ddBasePath
          pathLine.ddBasePath = DD_BASE_PATH
          mockProcess.cwd = () => OUT_BUILD_PATH
        })

        afterEach(() => {
          pathLine.ddBasePath = previousDDBasePath
        })

        before(() => {
          globalThis.__DD_ESBUILD_IAST_WITH_SM = false
          globalThis.__DD_ESBUILD_IAST_WITH_NO_SM = true
        })

        after(() => {
          delete globalThis.__DD_ESBUILD_IAST_WITH_SM
          delete globalThis.__DD_ESBUILD_IAST_WITH_NO_SM
        })

        it('should return all entries', () => {
          const callsites = []
          const bundleOutFile = 'out.js'

          callsites.push(new CallSiteMock(path.join(OUT_BUILD_PATH, bundleOutFile), 11))
          callsites.push(new CallSiteMock(path.join(OUT_BUILD_PATH, bundleOutFile), 42))
          callsites.push(new CallSiteMock(path.join(OUT_BUILD_PATH, bundleOutFile), 3, 14))
          callsites.push(new CallSiteMock(path.join(OUT_BUILD_PATH, bundleOutFile), 2, 71))

          const results = pathLine.getCallSiteFramesForLocation(callsites)
          assert.strictEqual(results.length, 4)

          assert.strictEqual(results[0].path, bundleOutFile)
          assert.strictEqual(results[0].line, 11)

          assert.strictEqual(results[1].path, bundleOutFile)
          assert.strictEqual(results[1].line, 42)

          assert.strictEqual(results[2].path, bundleOutFile)
          assert.strictEqual(results[2].line, 3)
          assert.strictEqual(results[2].column, 14)

          assert.strictEqual(results[3].path, bundleOutFile)
          assert.strictEqual(results[3].line, 2)
          assert.strictEqual(results[3].column, 71)
        })
      })
    })
  })

  describe('getNodeModulesPaths', () => {
    it('should handle windows paths correctly', () => {
      const testPath = 'some/nested/path/file.js'
      const expectedPath = path.join('node_modules', 'some', 'nested', 'path', 'file.js')
      const nodeModulesPaths = pathLine.getNodeModulesPaths(testPath)

      assert.strictEqual(nodeModulesPaths[0], expectedPath)
    })

    it('should convert / to \\ in windows platforms', () => {
      const dirname = __dirname
      const dirParts = dirname.split(path.sep)
      const paths = pathLine.getNodeModulesPaths(dirParts.join('/'))

      assert.strictEqual(paths[0], path.join('node_modules', dirname))
    })

    it('should return multiple paths', () => {
      const paths = pathLine.getNodeModulesPaths('/this/is/a/path', '/another/path')

      assert.strictEqual(paths.length, 2)
      assert.strictEqual(paths[0].startsWith('node_modules'), true)
    })
  })
})
