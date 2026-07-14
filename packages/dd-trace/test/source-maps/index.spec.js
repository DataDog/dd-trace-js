'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const Module = require('node:module')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const { after, before, afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

const { SourceMapGenerator } = require('../../../../vendor/dist/source-map')
require('../setup/mocha')

const sourceMapRemapping = require('../../src/source-maps/remap')
const sourceMapsPath = require.resolve('../../src/source-maps')
/** @typedef {(error: Error, callSites: NodeJS.CallSite[]) => unknown} PrepareStackTrace */
/**
 * @typedef {{
 *   getSourceMapsSupport?: () => { enabled: boolean, generatedCode: boolean, nodeModules: boolean },
 *   setSourceMapsSupport?: (
 *     enabled: boolean,
 *     options: { generatedCode: boolean, nodeModules: boolean }
 *   ) => void
 * }} SourceMapsModule
 */
const sourceMapsModule = /** @type {SourceMapsModule} */ (/** @type {unknown} */ (Module))
// eslint-disable-next-line n/no-unsupported-features/node-builtins
const canResolveSourceMaps = typeof sourceMapsModule.setSourceMapsSupport === 'function' ||
  process.execArgv.includes('--enable-source-maps') ||
  process.env.NODE_OPTIONS?.includes('--enable-source-maps') === true
const testPrepareStackTrace = Error.prepareStackTrace ?? formatCallSites
/** @type {('inline' | 'external')[]} */
const mapKinds = ['inline', 'external']

/** @type {string} */
let temporaryDirectory

/**
 * @param {string} name
 * @param {'inline' | 'external'} mapKind
 * @param {string} [sourceName]
 * @param {boolean} [mapNames]
 * @param {string} [sourceURL]
 * @param {string} [sourceRoot]
 * @returns {string}
 */
function writeTranspiledCommonJS (
  name,
  mapKind,
  sourceName = `${name}.ts`,
  mapNames = false,
  sourceURL,
  sourceRoot
) {
  const generator = new SourceMapGenerator({ file: `${name}.js`, sourceRoot })
  const lines = [
    '"use strict";',
    'Object.defineProperty(exports, "__esModule", { value: true });',
    `function ${name}Inner () { throw new Error("boom"); }`,
    `function ${name}Outer () { return ${name}Inner(); }`,
    `exports.run = function run () { return ${name}Outer(); };`,
  ]
  generator.addMapping({
    generated: { line: 3, column: 0 },
    name: mapNames ? `${name}OriginalInner` : undefined,
    original: { line: 1, column: 0 },
    source: sourceName,
  })
  generator.addMapping({
    generated: { line: 4, column: 0 },
    name: mapNames ? `${name}OriginalOuter` : undefined,
    original: { line: 2, column: 0 },
    source: sourceName,
  })
  generator.addMapping({
    generated: { line: 5, column: 0 },
    name: mapNames ? 'run' : undefined,
    original: { line: 3, column: 0 },
    source: sourceName,
  })

  const modulePath = path.join(temporaryDirectory, `${name}.js`)
  if (sourceURL !== undefined) lines.push(`//# sourceURL=${sourceURL}`)
  if (mapKind === 'inline') {
    const inlineSourceMap = Buffer.from(generator.toString()).toString('base64')
    lines.push(`//# sourceMappingURL=data:application/json;base64,${inlineSourceMap}`)
  } else {
    fs.writeFileSync(`${modulePath}.map`, generator.toString())
    lines.push(`//# sourceMappingURL=${name}.js.map`)
  }
  fs.writeFileSync(modulePath, lines.join('\n'))
  return modulePath
}

/**
 * @param {string} name
 * @returns {string}
 */
function writeTranspiledESM (name) {
  const generator = new SourceMapGenerator({ file: `${name}.mjs` })
  const lines = [
    `function ${name}Inner () { throw new Error("boom"); }`,
    `function ${name}Outer () { return ${name}Inner(); }`,
    `export function run () { return ${name}Outer(); }`,
  ]
  generator.addMapping({
    generated: { line: 1, column: 0 },
    original: { line: 1, column: 0 },
    source: `${name}.ts`,
  })
  generator.addMapping({
    generated: { line: 2, column: 0 },
    original: { line: 2, column: 0 },
    source: `${name}.ts`,
  })
  generator.addMapping({
    generated: { line: 3, column: 0 },
    original: { line: 3, column: 0 },
    source: `${name}.ts`,
  })

  const modulePath = path.join(temporaryDirectory, `${name}.mjs`)
  fs.writeFileSync(`${modulePath}.map`, generator.toString())
  lines.push(`//# sourceMappingURL=${name}.mjs.map`)
  fs.writeFileSync(modulePath, lines.join('\n'))
  return modulePath
}

/**
 * @param {string} name
 * @param {string} sourceName
 * @returns {string}
 */
function writeThrowingCommonJS (name, sourceName) {
  const generator = new SourceMapGenerator({ file: `${name}.js` })
  generator.addMapping({
    generated: { line: 1, column: 0 },
    original: { line: 1, column: 0 },
    source: sourceName,
  })

  const modulePath = path.join(temporaryDirectory, `${name}.js`)
  fs.writeFileSync(`${modulePath}.map`, generator.toString())
  fs.writeFileSync(modulePath, `throw new Error("boom")\n//# sourceMappingURL=${name}.js.map\n`)
  return modulePath
}

/**
 * @param {string} sourceURL
 * @param {string} sourceName
 * @returns {string}
 */
function createEvaluatedCode (sourceURL, sourceName) {
  const generator = new SourceMapGenerator({ file: sourceURL })
  for (let line = 1; line <= 3; line++) {
    generator.addMapping({
      generated: { line, column: 0 },
      original: { line: 1, column: 0 },
      source: sourceName,
    })
  }
  const inlineSourceMap = Buffer.from(generator.toString()).toString('base64')
  return [
    'throw new Error("boom")',
    `//# sourceURL=${sourceURL}`,
    `//# sourceMappingURL=data:application/json;base64,${inlineSourceMap}`,
  ].join('\n')
}

/**
 * @param {string} code
 * @returns {void}
 */
function evaluateCode (code) {
  // eslint-disable-next-line no-eval
  eval(code)
}

/**
 * @param {string} code
 * @returns {void}
 */
function runFunctionCode (code) {
  // eslint-disable-next-line no-new-func
  Function(code)()
}

/**
 * @param {() => unknown} run
 * @returns {string}
 */
function getThrownStack (run) {
  let stack = ''
  /**
   * @param {unknown} error
   * @returns {boolean}
   */
  function captureStack (error) {
    assert.ok(error instanceof Error)
    stack = error.stack ?? ''
    return true
  }
  assert.throws(run, captureStack)
  return stack
}

/**
 * @param {unknown} value
 * @returns {value is { stack: NodeJS.CallSite[] }}
 */
function hasCallSiteStack (value) {
  return value instanceof Error && Array.isArray(value.stack)
}

/**
 * @param {Error} _error
 * @param {NodeJS.CallSite[]} callSites
 * @returns {NodeJS.CallSite[]}
 */
function returnCallSites (_error, callSites) {
  return callSites
}

/**
 * @param {Error} error
 * @param {NodeJS.CallSite[]} callSites
 * @returns {string}
 */
function formatCallSites (error, callSites) {
  let stack = Error.prototype.toString.call(error)
  for (const callSite of callSites) {
    stack += `\n    at ${callSite}`
  }
  return stack
}

/**
 * @param {Error} _error
 * @param {NodeJS.CallSite[]} callSites
 * @returns {string | null}
 */
function formatFirstFileName (_error, callSites) {
  return callSites[0].getFileName()
}

/**
 * @param {Error} _error
 * @param {NodeJS.CallSite[]} callSites
 * @returns {string}
 */
function formatFirstCallSite (_error, callSites) {
  return callSites[0].toString()
}

/**
 * @param {PrepareStackTrace} formatter
 * @returns {PrepareStackTrace}
 */
function wrapPrepareStackTrace (formatter) {
  /**
   * @param {Error} error
   * @param {NodeJS.CallSite[]} callSites
   * @returns {unknown}
   */
  return function wrappedPrepareStackTrace (error, callSites) {
    return formatter(error, callSites)
  }
}

/**
 * @param {string | null} fileName
 * @param {number | null} [lineNumber]
 * @param {number | null} [columnNumber]
 * @returns {NodeJS.CallSite}
 */
function createCallSite (fileName, lineNumber = 1, columnNumber = 1) {
  return /** @type {NodeJS.CallSite} */ ({
    getColumnNumber: () => columnNumber,
    getEnclosingColumnNumber: () => columnNumber,
    getEnclosingLineNumber: () => lineNumber,
    getEvalOrigin: () => undefined,
    getFileName: () => fileName,
    getFunctionName: () => 'run',
    getLineNumber: () => lineNumber,
    getMethodName: () => null,
    getScriptNameOrSourceURL: () => fileName,
    getTypeName: () => null,
    isAsync: () => false,
    isConstructor: () => false,
    toString: () => columnNumber === null
      ? `run (${fileName}:${lineNumber})`
      : `run (${fileName}:${lineNumber}:${columnNumber})`,
  })
}

/**
 * @param {(fileName: string) => object | undefined} findSourceMap
 * @param {{ debug?: (...args: unknown[]) => unknown, warn: (...args: unknown[]) => unknown }} [log]
 * @param {() => { enabled: boolean, generatedCode: boolean, nodeModules: boolean }} [getSourceMapsSupport]
 * @returns {{
 *   configure: (mode: 'off' | 'datadog' | 'all') => void,
 *   registerPrepareStackTrace: (prepareStackTrace: PrepareStackTrace, delegate?: PrepareStackTrace) => void
 * }}
 */
function loadStubbedSourceMaps (
  findSourceMap,
  log = { debug: sinon.stub(), warn: sinon.stub() },
  getSourceMapsSupport = () => ({ enabled: true, generatedCode: false, nodeModules: false })
) {
  let firstSupportRead = true
  const sourceMaps = proxyquire.noPreserveCache()('../../src/source-maps', {
    'node:module': {
      findSourceMap,
      getSourceMapsSupport: () => {
        if (firstSupportRead) {
          firstSupportRead = false
          return { enabled: false, generatedCode: false, nodeModules: false }
        }
        return getSourceMapsSupport()
      },
      setSourceMapsSupport: () => {},
    },
    '../log': log,
  })
  if (typeof Error.prepareStackTrace === 'function') {
    sourceMaps.registerPrepareStackTrace(Error.prepareStackTrace)
  }
  return sourceMaps
}

describe('source maps', function () {
  /** @type {PropertyDescriptor | undefined} */
  let originalPrepareStackTraceDescriptor
  /** @type {string[]} */
  let originalExecArgv
  /** @type {string | undefined} */
  let originalNodeOptions
  /** @type {{ enabled: boolean, generatedCode: boolean, nodeModules: boolean } | undefined} */
  let originalSourceMapsSupport
  /**
   * @type {{
   *   configure: (mode: 'off' | 'datadog' | 'all') => void,
   *   isNativeSourceMapSupportEnabled: () => boolean,
   *   registerPrepareStackTrace: (prepareStackTrace: PrepareStackTrace, delegate?: PrepareStackTrace) => void,
   *   remapErrorStack: (stack: unknown) => unknown,
   *   syncSourceMapSupport: () => boolean
   * }}
   */
  let sourceMaps
  const cachedModulePaths = new Set()

  before(function () {
    temporaryDirectory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'dd-source-maps-'))
  })

  after(function () {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true })
  })

  beforeEach(function () {
    originalPrepareStackTraceDescriptor = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace')
    if (canResolveSourceMaps) {
      Object.defineProperty(Error, 'prepareStackTrace', {
        configurable: true,
        value: testPrepareStackTrace,
        writable: true,
      })
    }
    originalExecArgv = process.execArgv
    originalNodeOptions = process.env.NODE_OPTIONS
    // eslint-disable-next-line n/no-unsupported-features/node-builtins
    originalSourceMapsSupport = sourceMapsModule.getSourceMapsSupport?.()
    sourceMaps = proxyquire.noPreserveCache()('../../src/source-maps', {})
    if (typeof Error.prepareStackTrace === 'function') {
      sourceMaps.registerPrepareStackTrace(Error.prepareStackTrace)
    }
  })

  afterEach(function () {
    if (originalPrepareStackTraceDescriptor === undefined) {
      Reflect.deleteProperty(Error, 'prepareStackTrace')
    } else {
      Object.defineProperty(Error, 'prepareStackTrace', originalPrepareStackTraceDescriptor)
    }
    process.execArgv = originalExecArgv
    if (originalNodeOptions === undefined) {
      delete process.env.NODE_OPTIONS
    } else {
      process.env.NODE_OPTIONS = originalNodeOptions
    }
    if (originalSourceMapsSupport !== undefined) {
      const { enabled, generatedCode, nodeModules } = originalSourceMapsSupport
      // eslint-disable-next-line n/no-unsupported-features/node-builtins
      sourceMapsModule.setSourceMapsSupport?.(enabled, { generatedCode, nodeModules })
    }
    sourceMapRemapping.configure('off')
    delete require.cache[sourceMapsPath]
    for (const modulePath of cachedModulePaths) {
      delete require.cache[modulePath]
    }
    cachedModulePaths.clear()
  })

  describe('enable', function () {
    it('installs the formatter once', function () {
      const previousPrepareStackTrace = Error.prepareStackTrace
      sourceMaps.configure('all')

      if (!canResolveSourceMaps) {
        assert.strictEqual(Error.prepareStackTrace, previousPrepareStackTrace)
        return
      }

      const installedPrepareStackTrace = Error.prepareStackTrace
      assert.notStrictEqual(installedPrepareStackTrace, previousPrepareStackTrace)
      sourceMaps.configure('all')
      assert.strictEqual(Error.prepareStackTrace, installedPrepareStackTrace)
    })

    it('does not install without programmatic support or the process flag', function () {
      process.execArgv = []
      process.env.NODE_OPTIONS = ''
      const previousPrepareStackTrace = Error.prepareStackTrace
      sourceMaps = proxyquire.noPreserveCache()('../../src/source-maps', {
        'node:module': {
          findSourceMap: sinon.stub(),
          getSourceMapsSupport: undefined,
          setSourceMapsSupport: undefined,
        },
      })

      assert.strictEqual(sourceMaps.syncSourceMapSupport(), false)
      assert.strictEqual(sourceMaps.isNativeSourceMapSupportEnabled(), false)
      sourceMaps.configure('all')

      assert.strictEqual(Error.prepareStackTrace, previousPrepareStackTrace)
    })

    it('enables Node source maps without dependencies or generated code', function () {
      const setSourceMapsSupport = sinon.stub()
      sourceMaps = proxyquire.noPreserveCache()('../../src/source-maps', {
        'node:module': {
          findSourceMap: sinon.stub(),
          getSourceMapsSupport: () => ({ enabled: false }),
          setSourceMapsSupport,
        },
      })
      if (typeof Error.prepareStackTrace === 'function') {
        sourceMaps.registerPrepareStackTrace(Error.prepareStackTrace)
      }

      sourceMaps.configure('all')

      sinon.assert.calledOnceWithExactly(setSourceMapsSupport, true, {
        nodeModules: false,
        generatedCode: false,
      })
    })

    it('preserves existing Node source map support options', function () {
      const setSourceMapsSupport = sinon.stub()
      sourceMaps = proxyquire.noPreserveCache()('../../src/source-maps', {
        'node:module': {
          findSourceMap: sinon.stub(),
          getSourceMapsSupport: () => ({
            enabled: true,
            generatedCode: true,
            nodeModules: true,
          }),
          setSourceMapsSupport,
        },
      })

      sourceMaps.configure('all')

      sinon.assert.notCalled(setSourceMapsSupport)
    })

    it('defers to source maps enabled by a process flag on older runtimes', function () {
      process.execArgv = ['--enable-source-maps']
      const previousPrepareStackTrace = formatCallSites
      Error.prepareStackTrace = previousPrepareStackTrace
      sourceMaps = proxyquire.noPreserveCache()('../../src/source-maps', {
        'node:module': {
          findSourceMap: sinon.stub(),
          getSourceMapsSupport: undefined,
          setSourceMapsSupport: undefined,
        },
      })

      assert.strictEqual(sourceMaps.syncSourceMapSupport(), true)
      assert.strictEqual(sourceMaps.isNativeSourceMapSupportEnabled(), true)
      sourceMaps.configure('all')

      assert.strictEqual(Error.prepareStackTrace, previousPrepareStackTrace)
      assert.strictEqual(typeof Error.prepareStackTrace(new Error('boom'), []), 'string')
    })

    it('defers to source maps enabled through NODE_OPTIONS on older runtimes', function () {
      process.execArgv = []
      process.env.NODE_OPTIONS = '--enable-source-maps'
      const previousPrepareStackTrace = formatCallSites
      Error.prepareStackTrace = previousPrepareStackTrace
      sourceMaps = proxyquire.noPreserveCache()('../../src/source-maps', {
        'node:module': {
          findSourceMap: sinon.stub(),
          getSourceMapsSupport: undefined,
          setSourceMapsSupport: undefined,
        },
      })

      sourceMaps.configure('all')

      assert.strictEqual(Error.prepareStackTrace, previousPrepareStackTrace)
    })

    it('follows Node option token and override semantics on older runtimes', function () {
      const cases = [
        {
          execArgv: ['--enable-source-maps=true'],
          nodeOptions: '',
          expected: true,
        },
        {
          execArgv: ['--enable-source-maps', '--no-enable-source-maps'],
          nodeOptions: '',
          expected: false,
        },
        {
          execArgv: ['--no-enable-source-maps'],
          nodeOptions: '--enable-source-maps',
          expected: false,
        },
        {
          execArgv: ['--enable-source-maps'],
          nodeOptions: '--no-enable-source-maps',
          expected: true,
        },
        {
          execArgv: [],
          nodeOptions: '--require "module --enable-source-maps"',
          expected: false,
        },
        {
          execArgv: [],
          nodeOptions: '"--enable-source-maps"',
          expected: true,
        },
        {
          execArgv: [],
          nodeOptions: "'--enable-source-maps'",
          expected: false,
        },
        {
          execArgv: [],
          nodeOptions: '\\--enable-source-maps',
          expected: false,
        },
        {
          execArgv: [],
          nodeOptions: '"\\--enable-source-maps"',
          expected: true,
        },
        {
          execArgv: [],
          nodeOptions: '"--enable-source-maps',
          expected: false,
        },
        {
          execArgv: [],
          nodeOptions: '"--enable-source-maps\\',
          expected: false,
        },
        {
          execArgv: [],
          nodeOptions: '--enable-source-maps=false',
          expected: true,
        },
      ]

      for (const { execArgv, nodeOptions, expected } of cases) {
        process.execArgv = execArgv
        process.env.NODE_OPTIONS = nodeOptions
        const customPrepareStackTrace = () => 'custom stack'
        Error.prepareStackTrace = customPrepareStackTrace
        sourceMaps = proxyquire.noPreserveCache()('../../src/source-maps', {
          'node:module': {
            findSourceMap: sinon.stub(),
            getSourceMapsSupport: undefined,
            setSourceMapsSupport: undefined,
          },
        })

        assert.strictEqual(sourceMaps.syncSourceMapSupport(), expected)
        assert.strictEqual(sourceMaps.isNativeSourceMapSupportEnabled(), expected)
        sourceMaps.configure('all')

        assert.strictEqual(Error.prepareStackTrace, customPrepareStackTrace)
      }
    })

    it('does not interrupt initialization when Node rejects enabling source maps', function () {
      const log = { warn: sinon.stub() }
      const previousPrepareStackTrace = Error.prepareStackTrace
      sourceMaps = proxyquire.noPreserveCache()('../../src/source-maps', {
        'node:module': {
          findSourceMap: sinon.stub(),
          getSourceMapsSupport: () => ({ enabled: false }),
          setSourceMapsSupport: () => {
            throw new Error('source maps unavailable')
          },
        },
        '../log': log,
      })
      if (typeof Error.prepareStackTrace === 'function') {
        sourceMaps.registerPrepareStackTrace(Error.prepareStackTrace)
      }

      sourceMaps.configure('all')

      assert.strictEqual(Error.prepareStackTrace, previousPrepareStackTrace)
      sinon.assert.calledOnce(log.warn)
    })

    it('does not interrupt initialization when source map support cannot be read', function () {
      const log = { warn: sinon.stub() }
      sourceMaps = proxyquire.noPreserveCache()('../../src/source-maps', {
        'node:module': {
          findSourceMap: sinon.stub(),
          getSourceMapsSupport: () => {
            throw new Error('source maps unavailable')
          },
          setSourceMapsSupport: sinon.stub(),
        },
        '../log': log,
      })

      sourceMaps.configure('all')

      sinon.assert.calledOnce(log.warn)
    })

    it('preserves a custom formatter named like the Node default', function () {
      if (!canResolveSourceMaps) this.skip()

      function ErrorPrepareStackTrace () {
        return 'custom stack'
      }
      Error.prepareStackTrace = ErrorPrepareStackTrace
      sourceMaps = proxyquire.noPreserveCache()('../../src/source-maps', {})
      sourceMaps.configure('all')

      assert.strictEqual(Error.prepareStackTrace(new Error(), []), 'custom stack')
    })

    it('preserves the custom formatter receiver', function () {
      if (!canResolveSourceMaps) this.skip()

      /** @type {ErrorConstructor | undefined} */
      let receiver
      /**
       * @this {ErrorConstructor}
       * @param {Error} _error
       * @param {NodeJS.CallSite[]} _callSites
       * @returns {string}
       */
      Error.prepareStackTrace = function customPrepareStackTrace (_error, _callSites) {
        receiver = this
        return 'custom stack'
      }
      sourceMaps = proxyquire.noPreserveCache()('../../src/source-maps', {})
      sourceMaps.configure('all')

      assert.strictEqual(new Error().stack, 'custom stack')
      assert.strictEqual(receiver, Error)
    })

    it('defers to an accessor that wraps assigned formatters', function () {
      if (!canResolveSourceMaps) this.skip()

      let assignedPrepareStackTrace
      /** @type {PrepareStackTrace} */
      let actualPrepareStackTrace = () => 'custom stack'
      Object.defineProperty(Error, 'prepareStackTrace', {
        configurable: true,
        get () {
          return actualPrepareStackTrace
        },
        /**
         * @param {PrepareStackTrace} value
         */
        set (value) {
          assignedPrepareStackTrace = value
          actualPrepareStackTrace = wrapPrepareStackTrace(value)
        },
      })
      sourceMaps = proxyquire.noPreserveCache()('../../src/source-maps', {})

      sourceMaps.configure('all')

      assert.strictEqual(assignedPrepareStackTrace, undefined)
      assert.strictEqual(Error.prepareStackTrace(new Error(), []), 'custom stack')
    })

    it('does not throw when the formatter cannot be replaced', function () {
      if (!canResolveSourceMaps) this.skip()

      Object.defineProperty(Error, 'prepareStackTrace', {
        configurable: true,
        value: testPrepareStackTrace,
        writable: false,
      })

      sourceMaps.configure('all')
      assert.strictEqual(Error.prepareStackTrace, testPrepareStackTrace)
    })

    it('disables all mode when formatter assignment is ignored', function () {
      if (!canResolveSourceMaps) this.skip()

      const setPrepareStackTrace = sinon.stub()
      Object.defineProperty(Error, 'prepareStackTrace', {
        configurable: true,
        get: () => testPrepareStackTrace,
        set: setPrepareStackTrace,
      })

      sourceMaps.configure('all')

      sinon.assert.calledOnce(setPrepareStackTrace)
      assert.strictEqual(Error.prepareStackTrace, testPrepareStackTrace)
    })

    it('does not interrupt initialization when the formatter cannot be read', function () {
      if (!canResolveSourceMaps) this.skip()

      const log = { warn: sinon.stub() }
      const failure = {
        toString () {
          throw new Error('cannot stringify failure')
        },
      }
      Object.defineProperty(Error, 'prepareStackTrace', {
        configurable: true,
        get () {
          throw failure
        },
      })
      sourceMaps = proxyquire.noPreserveCache()('../../src/source-maps', {
        '../log': log,
      })

      sourceMaps.configure('all')

      sinon.assert.calledOnceWithExactly(
        log.warn,
        'Unable to read the source map stack trace formatter: %s',
        'Unknown error'
      )
    })
  })

  describe('datadog mode', function () {
    for (const mapKind of mapKinds) {
      it(`remaps an exported stack with a ${mapKind} source map`, function () {
        const modulePath = writeTranspiledCommonJS(`datadog-${mapKind}`, mapKind)
        const previousPrepareStackTrace = Error.prepareStackTrace
        const stack = `Error: boom\n    at run (${modulePath}:3:1)`
        sourceMaps.configure('datadog')

        const remapped = sourceMaps.remapErrorStack(stack)

        assert.match(remapped, new RegExp(`datadog-${mapKind}\\.ts:1:1`))
        assert.doesNotMatch(remapped, new RegExp(`datadog-${mapKind}\\.js:3:1`))
        assert.strictEqual(Error.prepareStackTrace, previousPrepareStackTrace)
      })
    }

    it('remaps a percent-encoded inline source map', function () {
      const modulePath = writeTranspiledCommonJS('datadog-percent-inline', 'inline')
      const source = fs.readFileSync(modulePath, 'utf8')
      const match = source.match(/sourceMappingURL=data:application\/json;base64,([^\n]+)/)
      assert.ok(match)
      const payload = Buffer.from(match[1], 'base64').toString('utf8')
      fs.writeFileSync(
        modulePath,
        source.replace(
          `data:application/json;base64,${match[1]}`,
          `data:application/json,${encodeURIComponent(payload)}`
        )
      )
      const stack = `Error: boom\n    at run (${modulePath}:3:1)`
      sourceMaps.configure('datadog')

      assert.match(sourceMaps.remapErrorStack(stack), /datadog-percent-inline\.ts:1:1/)
    })

    it('resolves a relative source root from the source map file', function () {
      const modulePath = writeTranspiledCommonJS(
        'datadog-source-root',
        'external',
        'original.ts',
        false,
        undefined,
        '../source'
      )
      const stack = `Error: boom\n    at run (${modulePath}:3:1)`
      sourceMaps.configure('datadog')
      const remapped = sourceMaps.remapErrorStack(stack)

      assert.strictEqual(typeof remapped, 'string')
      assert.ok(remapped.includes(`${path.resolve(temporaryDirectory, '../source/original.ts')}:1:1`))
    })

    it('resolves a source root URL from the source map file', function () {
      const originalDirectory = path.join(temporaryDirectory, 'original')
      const modulePath = writeTranspiledCommonJS(
        'datadog-source-root-url',
        'external',
        'original.ts',
        false,
        undefined,
        `${pathToFileURL(originalDirectory).href}/`
      )
      const stack = `Error: boom\n    at run (${modulePath}:3:1)`
      sourceMaps.configure('datadog')

      const remapped = sourceMaps.remapErrorStack(stack)
      assert.strictEqual(typeof remapped, 'string')
      assert.ok(remapped.includes(`${path.join(originalDirectory, 'original.ts')}:1:1`))
    })

    it('remaps structured source locations', function () {
      const modulePath = writeTranspiledCommonJS('datadog-location', 'external')
      sourceMaps.configure('datadog')

      assert.deepStrictEqual(sourceMapRemapping.location({
        file: modulePath,
        line: 3,
        column: 1,
      }), {
        file: path.join(temporaryDirectory, 'datadog-location.ts'),
        line: 1,
        column: 1,
      })
      const unresolved = { file: 'node:internal', line: 1, column: 1 }
      assert.strictEqual(sourceMapRemapping.location(unresolved), unresolved)
      const incomplete = { file: modulePath, line: null, column: null }
      assert.strictEqual(sourceMapRemapping.location(incomplete), incomplete)
    })

    it('ignores the query and fragment on an absolute source map path', function () {
      const modulePath = writeTranspiledCommonJS('datadog-absolute-map', 'external')
      const source = fs.readFileSync(modulePath, 'utf8')
      fs.writeFileSync(
        modulePath,
        source.replace(
          'datadog-absolute-map.js.map',
          `${modulePath}.map?cache=1#fragment`
        )
      )
      const stack = `Error: boom\n    at run (${modulePath}:3:1)`
      sourceMaps.configure('datadog')

      assert.match(sourceMaps.remapErrorStack(stack), /datadog-absolute-map\.ts:1:1/)
    })

    it('remaps a generated file URL', function () {
      const modulePath = writeTranspiledCommonJS('datadog-file-url', 'external')
      const generatedURL = pathToFileURL(modulePath).href
      const stack = `Error: boom\n    at run (${generatedURL}:3:1)`
      sourceMaps.configure('datadog')

      assert.match(sourceMaps.remapErrorStack(stack), /datadog-file-url\.ts:1:1/)
    })

    it('ignores unsupported generated and source-map URLs', function () {
      const modulePath = writeTranspiledCommonJS('datadog-remote-map', 'external')
      const source = fs.readFileSync(modulePath, 'utf8')
      fs.writeFileSync(
        modulePath,
        source.replace('datadog-remote-map.js.map', 'https://example.com/generated.js.map')
      )
      const remoteStack = 'Error: boom\n    at run (webpack://application/generated.js:3:1)'
      const localStack = `Error: boom\n    at run (${modulePath}:3:1)`
      sourceMaps.configure('datadog')

      assert.strictEqual(sourceMaps.remapErrorStack(remoteStack), remoteStack)
      assert.strictEqual(sourceMaps.remapErrorStack(localStack), localStack)
    })

    it('leaves application-visible stacks generated', function () {
      const modulePath = writeTranspiledCommonJS('datadogVisible', 'external')
      cachedModulePaths.add(modulePath)
      sourceMaps.configure('datadog')
      const { run } = require(modulePath)

      const stack = getThrownStack(run)

      assert.match(stack, /datadogVisible\.js:3:/)
      assert.doesNotMatch(stack, /datadogVisible\.ts:/)
      assert.match(sourceMaps.remapErrorStack(stack), /datadogVisible\.ts:1:1/)
    })

    it('preserves CRLF stack delimiters', function () {
      const modulePath = writeTranspiledCommonJS('datadog-crlf', 'external')
      const stack = `Error: boom\r\n    at run (${modulePath}:3:1)\r\n    at next (next.js:1:1)`
      sourceMaps.configure('datadog')

      const remapped = sourceMaps.remapErrorStack(stack)

      assert.strictEqual(typeof remapped, 'string')
      assert.match(remapped, /datadog-crlf\.ts:1:1/)
      assert.strictEqual(remapped.split('\r\n').length, 3)
    })

    it('does not process dependency source maps', function () {
      const modulePath = writeTranspiledCommonJS('datadog-dependency', 'external')
      const dependencyDirectory = path.join(temporaryDirectory, 'node_modules', 'dependency')
      fs.mkdirSync(dependencyDirectory, { recursive: true })
      const dependencyPath = path.join(dependencyDirectory, path.basename(modulePath))
      fs.renameSync(modulePath, dependencyPath)
      fs.renameSync(`${modulePath}.map`, `${dependencyPath}.map`)
      const stack = `Error: boom\n    at run (${dependencyPath}:3:1)`
      sourceMaps.configure('datadog')

      assert.strictEqual(sourceMaps.remapErrorStack(stack), stack)
    })

    it('preserves non-frame locations and non-string stacks', function () {
      const modulePath = writeTranspiledCommonJS('datadog-message', 'external')
      const stack = `Error: see ${modulePath}:3:1\n    at <anonymous>`
      const structuredStack = [createCallSite(modulePath, 3, 1)]
      const invalidLine = `Error: boom\n    at run (${modulePath}:0:0)`
      const missingFile = 'Error: boom\n    at run (:1:1)'
      sourceMaps.configure('datadog')

      assert.strictEqual(sourceMaps.remapErrorStack(stack), stack)
      assert.strictEqual(sourceMaps.remapErrorStack(structuredStack), structuredStack)
      assert.strictEqual(sourceMaps.remapErrorStack(invalidLine), invalidLine)
      assert.strictEqual(sourceMaps.remapErrorStack(missingFile), missingFile)
    })

    it('remaps a frame without a generated column number', function () {
      const modulePath = writeTranspiledCommonJS('datadog-line-only', 'external')
      const stack = `Error: boom\n    at run (${modulePath}:3)`
      sourceMaps.configure('datadog')

      assert.match(sourceMaps.remapErrorStack(stack), /datadog-line-only\.ts:1:1/)
    })

    it('defers to a custom formatter installed before initialization', function () {
      const modulePath = writeTranspiledCommonJS('datadog-custom', 'external')
      const stack = `Error: boom\n    at run (${modulePath}:3:1)`
      const customPrepareStackTrace = () => 'custom stack'
      Error.prepareStackTrace = customPrepareStackTrace

      sourceMaps.configure('datadog')

      assert.strictEqual(sourceMaps.remapErrorStack(stack), stack)
      assert.strictEqual(Error.prepareStackTrace, customPrepareStackTrace)
    })

    it('stops remapping after a custom formatter takes ownership', function () {
      const modulePath = writeTranspiledCommonJS('datadog-late-custom', 'external')
      const stack = `Error: boom\n    at run (${modulePath}:3:1)`
      const previousPrepareStackTrace = Error.prepareStackTrace
      sourceMaps.configure('datadog')
      const location = { file: modulePath, line: 3, column: 1 }
      const remapLocation = sourceMapRemapping.location
      assert.deepStrictEqual(remapLocation(location), {
        file: path.join(temporaryDirectory, 'datadog-late-custom.ts'),
        line: 1,
        column: 1,
      })

      Error.prepareStackTrace = () => 'custom stack'

      assert.strictEqual(remapLocation(location), location)
      assert.strictEqual(sourceMaps.remapErrorStack(stack), stack)
      Error.prepareStackTrace = previousPrepareStackTrace
      assert.strictEqual(sourceMapRemapping.errorStack(stack), stack)
    })

    it('stops remapping when the current formatter cannot be read', function () {
      const stack = 'Error: boom\n    at run (generated.js:1:1)'
      sourceMaps.configure('datadog')
      Object.defineProperty(Error, 'prepareStackTrace', {
        configurable: true,
        get () {
          throw new Error('formatter unavailable')
        },
      })

      assert.strictEqual(sourceMaps.remapErrorStack(stack), stack)
    })

    it('stops remapping when current source map support cannot be read', function () {
      const stack = 'Error: boom\n    at run (generated.js:1:1)'
      const getSourceMapsSupport = () => {
        throw new Error('source maps unavailable')
      }
      sourceMaps = loadStubbedSourceMaps(sinon.stub(), undefined, getSourceMapsSupport)
      sourceMaps.configure('datadog')

      assert.strictEqual(sourceMaps.remapErrorStack(stack), stack)
    })

    it('stops remapping after Node source maps are enabled', function () {
      // eslint-disable-next-line n/no-unsupported-features/node-builtins
      if (typeof sourceMapsModule.setSourceMapsSupport !== 'function') this.skip()

      const modulePath = writeTranspiledCommonJS('datadog-late-native', 'external')
      const stack = `Error: boom\n    at run (${modulePath}:3:1)`
      sourceMaps.configure('datadog')
      // eslint-disable-next-line n/no-unsupported-features/node-builtins
      sourceMapsModule.setSourceMapsSupport(true, { generatedCode: false, nodeModules: false })

      assert.strictEqual(sourceMaps.remapErrorStack(stack), stack)
    })

    it('keeps remapping through a registered Datadog formatter', function () {
      const modulePath = writeTranspiledCommonJS('datadog-registered', 'external')
      const stack = `Error: boom\n    at run (${modulePath}:3:1)`
      const datadogPrepareStackTrace = () => 'datadog stack'
      sourceMaps.configure('datadog')
      sourceMaps.registerPrepareStackTrace(datadogPrepareStackTrace)
      Error.prepareStackTrace = datadogPrepareStackTrace

      assert.match(sourceMaps.remapErrorStack(stack), /datadog-registered\.ts:1:1/)
    })

    it('defers to an external formatter wrapped by a Datadog formatter', function () {
      const modulePath = writeTranspiledCommonJS('datadog-wrapped-external', 'external')
      const stack = `Error: boom\n    at run (${modulePath}:3:1)`
      const externalPrepareStackTrace = () => 'external stack'
      const datadogPrepareStackTrace = () => externalPrepareStackTrace()
      sourceMaps.configure('datadog')
      sourceMaps.registerPrepareStackTrace(datadogPrepareStackTrace, externalPrepareStackTrace)
      Error.prepareStackTrace = datadogPrepareStackTrace

      assert.strictEqual(sourceMaps.remapErrorStack(stack), stack)
    })

    it('bounds the direct source map cache', function () {
      const modulePaths = []
      for (let i = 0; i <= 256; i++) {
        const modulePath = writeTranspiledCommonJS(`datadogCache${i}`, 'external', `before-${i}.ts`)
        modulePaths.push(modulePath)
        require.cache[modulePath] = /** @type {NodeModule} */ ({})
        cachedModulePaths.add(modulePath)
      }
      sourceMaps.configure('datadog')

      for (let i = 0; i < 256; i++) {
        sourceMaps.remapErrorStack(`Error: boom\n    at run (${modulePaths[i]}:3:1)`)
      }
      writeTranspiledCommonJS('datadogCache0', 'external', 'after-0.ts')
      assert.match(
        sourceMaps.remapErrorStack(`Error: boom\n    at run (${modulePaths[0]}:3:1)`),
        /before-0\.ts:1:1/
      )

      writeTranspiledCommonJS('datadogCache1', 'external', 'after-1.ts')
      sourceMaps.remapErrorStack(`Error: boom\n    at run (${modulePaths[256]}:3:1)`)

      assert.match(
        sourceMaps.remapErrorStack(`Error: boom\n    at run (${modulePaths[1]}:3:1)`),
        /after-1\.ts:1:1/
      )
    })

    it('caches direct source maps without a CommonJS module entry', function () {
      const modulePath = writeTranspiledCommonJS('datadog-uncached-module', 'external', 'before.ts')
      const stack = `Error: boom\n    at run (${modulePath}:3:1)`
      sourceMaps.configure('datadog')

      assert.match(sourceMaps.remapErrorStack(stack), /before\.ts:1:1/)
      writeTranspiledCommonJS('datadog-uncached-module', 'external', 'after.ts')

      assert.match(sourceMaps.remapErrorStack(stack), /before\.ts:1:1/)
    })

    it('reloads a direct source map when a CommonJS module entry appears', function () {
      const modulePath = writeTranspiledCommonJS('datadog-late-module', 'external', 'before.ts')
      const stack = `Error: boom\n    at run (${modulePath}:3:1)`
      sourceMaps.configure('datadog')
      assert.match(sourceMaps.remapErrorStack(stack), /before\.ts:1:1/)

      writeTranspiledCommonJS('datadog-late-module', 'external', 'after.ts')
      require.cache[modulePath] = /** @type {NodeModule} */ ({})
      cachedModulePaths.add(modulePath)

      assert.match(sourceMaps.remapErrorStack(stack), /after\.ts:1:1/)
    })

    it('resolves cached relative frames from the current working directory', function () {
      const originalWorkingDirectory = process.cwd()
      const beforeDirectory = path.join(temporaryDirectory, 'relative-before')
      const afterDirectory = path.join(temporaryDirectory, 'relative-after')
      const beforePath = writeTranspiledCommonJS('relative-before', 'external', 'before.ts')
      const afterPath = writeTranspiledCommonJS('relative-after', 'external', 'after.ts')
      fs.mkdirSync(beforeDirectory)
      fs.mkdirSync(afterDirectory)
      fs.copyFileSync(beforePath, path.join(beforeDirectory, 'generated.js'))
      fs.copyFileSync(`${beforePath}.map`, path.join(beforeDirectory, 'relative-before.js.map'))
      fs.copyFileSync(afterPath, path.join(afterDirectory, 'generated.js'))
      fs.copyFileSync(`${afterPath}.map`, path.join(afterDirectory, 'relative-after.js.map'))
      const stack = 'Error: boom\n    at run (generated.js:3:1)'
      sourceMaps.configure('datadog')

      try {
        process.chdir(beforeDirectory)
        assert.match(sourceMaps.remapErrorStack(stack), /before\.ts:1:1/)
        process.chdir(afterDirectory)
        assert.match(sourceMaps.remapErrorStack(stack), /after\.ts:1:1/)
      } finally {
        process.chdir(originalWorkingDirectory)
      }
    })

    it('bounds cached direct stack frames', function () {
      sourceMaps.configure('datadog')

      for (let i = 0; i <= 4096; i++) {
        const stack = `Error: boom\n    at run (webpack://application/generated-${i}.js:1:1)`
        assert.strictEqual(sourceMaps.remapErrorStack(stack), stack)
      }
    })

    it('caches an invalid generated file URL', function () {
      const stack = 'Error: boom\n    at run (file:///%E0%A4%A:1:1)'
      sourceMaps.configure('datadog')

      assert.strictEqual(sourceMaps.remapErrorStack(stack), stack)
      assert.strictEqual(sourceMaps.remapErrorStack(stack), stack)
    })

    it('ignores an oversized external source map', function () {
      const modulePath = writeTranspiledCommonJS('datadog-oversized-map', 'external')
      fs.truncateSync(`${modulePath}.map`, 64 * 1024 * 1024 + 1)
      const stack = `Error: boom\n    at run (${modulePath}:3:1)`
      sourceMaps.configure('datadog')

      assert.strictEqual(sourceMaps.remapErrorStack(stack), stack)
    })

    it('ignores inline source map data without a comma', function () {
      const modulePath = writeTranspiledCommonJS('datadog-invalid-inline-map', 'inline')
      const source = fs.readFileSync(modulePath, 'utf8')
      const marker = '//# sourceMappingURL='
      const markerIndex = source.indexOf(marker)
      fs.writeFileSync(modulePath, `${source.slice(0, markerIndex)}${marker}data:application/json;base64\n`)
      const stack = `Error: boom\n    at run (${modulePath}:3:1)`
      sourceMaps.configure('datadog')

      assert.strictEqual(sourceMaps.remapErrorStack(stack), stack)
    })

    it('recognizes Windows source map paths', function () {
      const sourceMappingURLs = [
        'C:\\source-map.js.map',
        '\\\\server\\source-map.js.map',
      ]
      sourceMaps.configure('datadog')

      for (let i = 0; i < sourceMappingURLs.length; i++) {
        const modulePath = writeTranspiledCommonJS(`datadog-windows-map-${i}`, 'external')
        const source = fs.readFileSync(modulePath, 'utf8')
        fs.writeFileSync(
          modulePath,
          source.replace(`datadog-windows-map-${i}.js.map`, sourceMappingURLs[i])
        )
        const stack = `Error: boom\n    at run (${modulePath}:3:1)`
        assert.strictEqual(sourceMaps.remapErrorStack(stack), stack)
      }
    })

    it('keeps a relative source when its URL source root is invalid', function () {
      const modulePath = writeTranspiledCommonJS(
        'datadog-invalid-source-root',
        'external',
        'original.ts',
        false,
        undefined,
        'https://[invalid'
      )
      const stack = `Error: boom\n    at run (${modulePath}:3:1)`
      sourceMaps.configure('datadog')

      assert.match(sourceMaps.remapErrorStack(stack), /original\.ts:1:1/)
    })
  })

  describe('remapping', function () {
    before(function () {
      if (!canResolveSourceMaps) this.skip()
    })

    for (const mapKind of mapKinds) {
      it(`remaps ${mapKind} CommonJS source maps`, function () {
        const modulePath = writeTranspiledCommonJS(`${mapKind}app`, mapKind)
        cachedModulePaths.add(modulePath)
        sourceMaps.configure('all')
        const { run } = require(modulePath)

        const frames = getThrownStack(run).split('\n').slice(1, 4)

        assert.match(frames[0], new RegExp(`${mapKind}app\\.ts:1:1`))
        assert.match(frames[1], new RegExp(`${mapKind}app\\.ts:2:1`))
        assert.match(frames[2], new RegExp(`${mapKind}app\\.ts:3:1`))
      })
    }

    it('remaps structured source locations through Node source maps', function () {
      const modulePath = writeTranspiledCommonJS('allLocation', 'external')
      cachedModulePaths.add(modulePath)
      sourceMaps.configure('all')
      require(modulePath)

      assert.deepStrictEqual(sourceMapRemapping.location({
        file: modulePath,
        line: 3,
        column: 1,
      }), {
        file: path.join(temporaryDirectory, 'allLocation.ts'),
        line: 1,
        column: 1,
      })
    })

    it('remaps a CommonJS frame rendered with sourceURL', function () {
      const modulePath = writeTranspiledCommonJS(
        'sourceurl',
        'inline',
        'sourceurl.ts',
        false,
        'virtual-sourceurl.js'
      )
      cachedModulePaths.add(modulePath)
      sourceMaps.configure('all')
      const { run } = require(modulePath)

      const frame = getThrownStack(run).split('\n')[1]

      assert.match(frame, /sourceurl\.ts:1:1/)
      assert.doesNotMatch(frame, /virtual-sourceurl\.js/)
    })

    it('remaps ES modules', async function () {
      const modulePath = writeTranspiledESM('esmapp')
      sourceMaps.configure('all')
      const { run } = await import(`${pathToFileURL(modulePath).href}?test=${Date.now()}`)

      const frames = getThrownStack(run).split('\n').slice(1, 4)

      assert.match(frames[0], /esmapp\.ts:1:1/)
      assert.match(frames[1], /esmapp\.ts:2:1/)
      assert.match(frames[2], /esmapp\.ts:3:1/)
    })

    it('matches the native error header', function () {
      const errors = [
        new Error('boom'),
        new assert.AssertionError({ message: 'boom' }),
        Object.assign(new Error(), { name: '', message: 'boom' }),
        Object.assign(new Error(), { name: 'CustomError', message: '' }),
        Object.assign(new Error(), { name: undefined, message: undefined }),
      ]
      const nativePrepareStackTrace = Error.prepareStackTrace
      if (typeof nativePrepareStackTrace !== 'function') {
        sourceMaps.configure('all')
        assert.strictEqual(Error.prepareStackTrace, undefined)
        return
      }
      const expected = errors.map(error => typeof nativePrepareStackTrace === 'function'
        ? nativePrepareStackTrace.call(Error, error, [])
        : Error.prototype.toString.call(error))
      sourceMaps.configure('all')

      for (let i = 0; i < errors.length; i++) {
        assert.strictEqual(
          Error.prepareStackTrace(errors[i], []),
          expected[i]
        )
      }
    })

    it('keeps native header formatting when prepareStackTrace is not exposed', function () {
      const originalToString = Error.prototype.toString
      try {
        // eslint-disable-next-line no-extend-native
        Error.prototype.toString = () => 'replaced header'
        Reflect.deleteProperty(Error, 'prepareStackTrace')
        let nativeError
        try {
          fs.readFileSync(/** @type {unknown} */ ({}))
        } catch (error) {
          nativeError = error
        }
        assert.ok(nativeError instanceof Error)
        const expectedHeader = nativeError.stack?.split('\n')[0]
        sourceMaps = loadStubbedSourceMaps(sinon.stub())
        sourceMaps.configure('all')

        assert.strictEqual(Error.prepareStackTrace, undefined)
        let actualError
        try {
          fs.readFileSync(/** @type {unknown} */ ({}))
        } catch (error) {
          actualError = error
        }
        assert.ok(actualError instanceof Error)
        assert.match(actualError.stack ?? '', /\[ERR_INVALID_ARG_TYPE\]/)
        assert.strictEqual(actualError.stack?.split('\n')[0], expectedHeader)
      } finally {
        // eslint-disable-next-line no-extend-native
        Error.prototype.toString = originalToString
      }
    })

    it('uses original symbol names from the source map', function () {
      const modulePath = writeTranspiledCommonJS('named', 'inline', 'named.ts', true)
      cachedModulePaths.add(modulePath)
      sourceMaps.configure('all')
      const { run } = require(modulePath)

      const frame = getThrownStack(run).split('\n')[1]

      assert.match(frame, /at namedOriginalInner \(.*named\.ts:1:1\)$/)
      assert.doesNotMatch(frame, /namedInner/)
    })

    it('replaces a repeated method name without changing its alias', function () {
      const fileName = path.join(temporaryDirectory, 'aliased-name.js')
      const sourceMap = {
        payload: { names: ['originalFoo'] },
        findEntry: sinon.stub()
          .onFirstCall().returns({
            originalColumn: 0,
            originalLine: 0,
            originalSource: 'aliased-name.ts',
          })
          .onSecondCall().returns({ name: 'originalFoo' }),
      }
      require.cache[fileName] = /** @type {NodeModule} */ ({})
      cachedModulePaths.add(fileName)
      sourceMaps = loadStubbedSourceMaps(() => sourceMap)
      sourceMaps.configure('all')
      const callSite = createCallSite(fileName)
      callSite.getFunctionName = () => 'foo'
      callSite.toString = () => `foo.foo [as foobar] (${fileName}:1:1)`

      const stack = Error.prepareStackTrace(new Error('boom'), [callSite])

      assert.match(String(stack), /foo\.originalFoo \[as foobar\] \(aliased-name\.ts:1:1\)$/)
    })

    it('checks a source map payload for names only once', function () {
      const fileName = path.join(temporaryDirectory, 'unnamed-map.js')
      let payloadReads = 0
      const sourceMap = {
        get payload () {
          payloadReads++
          return { names: [] }
        },
        findEntry: sinon.stub().returns({
          originalColumn: 0,
          originalLine: 0,
          originalSource: 'unnamed-map.ts',
        }),
      }
      require.cache[fileName] = /** @type {NodeModule} */ ({})
      cachedModulePaths.add(fileName)
      sourceMaps = loadStubbedSourceMaps(() => sourceMap)
      sourceMaps.configure('all')
      const callSite = createCallSite(fileName)

      Error.prepareStackTrace(new Error('first'), [callSite])
      Error.prepareStackTrace(new Error('second'), [callSite])

      assert.strictEqual(payloadReads, 1)
    })

    it('maps locations when source map symbol names cannot be read', function () {
      const fileName = path.join(temporaryDirectory, 'throwing-names-map.js')
      const failure = new Error('invalid names')
      const log = { debug: sinon.stub(), warn: sinon.stub() }
      const sourceMap = {
        get payload () {
          throw failure
        },
        findEntry: sinon.stub().returns({
          originalColumn: 0,
          originalLine: 0,
          originalSource: 'throwing-names-map.ts',
        }),
      }
      require.cache[fileName] = /** @type {NodeModule} */ ({})
      cachedModulePaths.add(fileName)
      sourceMaps = loadStubbedSourceMaps(() => sourceMap, log)
      sourceMaps.configure('all')

      const stack = Error.prepareStackTrace(new Error('boom'), [createCallSite(fileName)])

      assert.match(String(stack), /run \(throwing-names-map\.ts:1:1\)$/)
      sinon.assert.calledOnceWithExactly(
        log.debug,
        'Unable to read source map symbol names: %s',
        failure.message
      )
    })

    it('uses a caller mapping when the enclosing mapping has no symbol name', function () {
      const fileName = path.join(temporaryDirectory, 'caller-name.js')
      const sourceMap = {
        payload: { names: ['originalRun'] },
        findEntry: sinon.stub()
          .onCall(0).returns({
            originalColumn: 0,
            originalLine: 0,
            originalSource: 'current.ts',
          })
          .onCall(1).returns({})
          .onCall(2).returns({ name: 'originalRun' })
          .onCall(3).returns({
            originalColumn: 0,
            originalLine: 1,
            originalSource: 'caller.ts',
          })
          .onCall(4).returns({}),
      }
      require.cache[fileName] = /** @type {NodeModule} */ ({})
      cachedModulePaths.add(fileName)
      sourceMaps = loadStubbedSourceMaps(() => sourceMap)
      sourceMaps.configure('all')

      const stack = Error.prepareStackTrace(new Error('boom'), [
        createCallSite(fileName, 1, 1),
        createCallSite(fileName, 2, 1),
      ])

      assert.match(String(stack).split('\n')[1], /at originalRun \(current\.ts:1:1\)$/)
    })

    it('uses a caller mapping when a custom formatter stringifies a call site', function () {
      const fileName = path.join(temporaryDirectory, 'custom-caller-name.js')
      const sourceMap = {
        payload: { names: ['originalRun'] },
        findEntry: sinon.stub()
          .onCall(0).returns({
            originalColumn: 0,
            originalLine: 0,
            originalSource: 'custom-current.ts',
          })
          .onCall(1).returns({
            originalColumn: 0,
            originalLine: 1,
            originalSource: 'custom-caller.ts',
          })
          .onCall(2).returns({})
          .onCall(3).returns({ name: 'originalRun' }),
      }
      require.cache[fileName] = /** @type {NodeModule} */ ({})
      cachedModulePaths.add(fileName)
      Error.prepareStackTrace = formatFirstCallSite
      sourceMaps = loadStubbedSourceMaps(() => sourceMap)
      sourceMaps.configure('all')

      const stack = Error.prepareStackTrace(new Error('boom'), [
        createCallSite(fileName, 1, 1),
        createCallSite(fileName, 2, 1),
      ])

      assert.match(String(stack), /originalRun \(custom-current\.ts:1:1\)$/)
    })

    it('ignores malformed symbol name mappings', function () {
      const fileName = path.join(temporaryDirectory, 'malformed-name.js')
      const sourceMap = {
        payload: { names: ['originalRun'] },
        findEntry: sinon.stub()
          .onFirstCall().returns({
            originalColumn: 0,
            originalLine: 0,
            originalSource: 'mapped.ts',
          })
          .onSecondCall().throws(new Error('invalid name mapping')),
      }
      require.cache[fileName] = /** @type {NodeModule} */ ({})
      cachedModulePaths.add(fileName)
      sourceMaps = loadStubbedSourceMaps(() => sourceMap)
      sourceMaps.configure('all')

      const stack = Error.prepareStackTrace(new Error('boom'), [createCallSite(fileName)])

      assert.match(String(stack), /run \(mapped\.ts:1:1\)$/)
    })

    it('defers generated code to source maps enabled by another component', function () {
      const setSourceMapsSupport = sinon.stub()
      const sourceMap = {
        payload: { names: [] },
        findEntry: sinon.stub().returns({
          originalColumn: 4,
          originalLine: 3,
          originalSource: 'generated.ts',
        }),
      }
      const findSourceMap = sinon.stub().withArgs('generated.js').returns(sourceMap)
      sourceMaps = proxyquire.noPreserveCache()('../../src/source-maps', {
        'node:module': {
          findSourceMap,
          getSourceMapsSupport: () => ({
            enabled: true,
            generatedCode: true,
            nodeModules: false,
          }),
          setSourceMapsSupport,
        },
      })
      sourceMaps.configure('all')
      const callSite = createCallSite(null, 1, 2)
      callSite.getEvalOrigin = () => 'generated.js'
      callSite.toString = () => 'run (generated.js:1:2)'

      const stack = Error.prepareStackTrace(new Error('boom'), [callSite])

      assert.match(String(stack), /run \(generated\.js:1:2\)$/)
      sinon.assert.notCalled(findSourceMap)
      sinon.assert.notCalled(setSourceMapsSupport)
    })

    it('delegates remapped generated code to a custom formatter', function () {
      const sourceMap = {
        findEntry: sinon.stub().returns({
          originalColumn: 4,
          originalLine: 3,
          originalSource: 'generated.ts',
        }),
      }
      const findSourceMap = sinon.stub().withArgs('generated.js').returns(sourceMap)
      Error.prepareStackTrace = formatFirstFileName
      sourceMaps = loadStubbedSourceMaps(
        findSourceMap,
        undefined,
        () => ({ enabled: true, generatedCode: true, nodeModules: false })
      )
      sourceMaps.configure('all')
      const callSite = createCallSite(null, 1, 2)
      callSite.getEvalOrigin = () => 'generated.js'

      assert.strictEqual(Error.prepareStackTrace(new Error('boom'), [callSite]), 'generated.ts')
    })

    it('exposes every remapped location field to a custom formatter', function () {
      const sourceMap = {
        findEntry: sinon.stub().returns({
          originalColumn: 4,
          originalLine: 3,
          originalSource: 'original.ts',
        }),
      }
      const findSourceMap = sinon.stub().withArgs('generated.js').returns(sourceMap)
      Error.prepareStackTrace = (_error, callSites) => {
        const callSite = callSites[0]
        return [
          callSite.getFileName(),
          callSite.getLineNumber(),
          callSite.getColumnNumber(),
          callSite.getTypeName(),
        ]
      }
      sourceMaps = loadStubbedSourceMaps(findSourceMap)
      sourceMaps.configure('all')

      assert.deepStrictEqual(
        Error.prepareStackTrace(new Error('boom'), [createCallSite('generated.js', 1, 2)]),
        ['original.ts', 4, 5, null]
      )
    })

    it('preserves programmatic source maps for evaluated code', function () {
      // eslint-disable-next-line n/no-unsupported-features/node-builtins
      if (typeof sourceMapsModule.setSourceMapsSupport !== 'function') this.skip()

      const sourceURL = `generated-${Date.now()}.js`
      const generator = new SourceMapGenerator({ file: sourceURL })
      generator.addMapping({
        generated: { line: 1, column: 0 },
        original: { line: 8, column: 2 },
        source: 'generated-original.ts',
      })
      const inlineSourceMap = Buffer.from(generator.toString()).toString('base64')
      const code = [
        'throw new Error("boom")',
        `//# sourceURL=${sourceURL}`,
        `//# sourceMappingURL=data:application/json;base64,${inlineSourceMap}`,
      ].join('\n')
      // eslint-disable-next-line n/no-unsupported-features/node-builtins
      sourceMapsModule.setSourceMapsSupport(true, { generatedCode: true, nodeModules: false })
      sourceMaps.configure('all')

      // eslint-disable-next-line no-eval
      const stack = getThrownStack(() => eval(code))

      assert.match(stack.split('\n')[1], /generated-original\.ts:8:3/)
      assert.doesNotMatch(stack.split('\n')[1], new RegExp(`${sourceURL}:1:`))
    })

    it('reloads generated maps that reuse a file URL', function () {
      // eslint-disable-next-line n/no-unsupported-features/node-builtins
      if (typeof sourceMapsModule.setSourceMapsSupport !== 'function') this.skip()

      // eslint-disable-next-line n/no-unsupported-features/node-builtins
      sourceMapsModule.setSourceMapsSupport(true, { generatedCode: true, nodeModules: false })
      sourceMaps.configure('all')
      const evaluators = [
        ['eval', evaluateCode],
        ['function', runFunctionCode],
      ]

      for (const [name, evaluate] of evaluators) {
        const sourceURL = pathToFileURL(path.join(temporaryDirectory, `generated-${name}.js`)).href

        const beforeStack = getThrownStack(() => evaluate(createEvaluatedCode(sourceURL, `before-${name}.ts`)))
        const afterStack = getThrownStack(() => evaluate(createEvaluatedCode(sourceURL, `after-${name}.ts`)))

        assert.match(beforeStack.split('\n')[1], new RegExp(`before-${name}\\.ts:1:1`))
        assert.match(afterStack.split('\n')[1], new RegExp(`after-${name}\\.ts:1:1`))
      }
    })

    it('defers to a custom formatter without changing call-site locations', function () {
      const modulePath = writeTranspiledCommonJS('userhandler', 'inline')
      cachedModulePaths.add(modulePath)
      Error.prepareStackTrace = returnCallSites
      sourceMaps = proxyquire.noPreserveCache()('../../src/source-maps', {})
      sourceMaps.configure('all')
      const { run } = require(modulePath)

      /**
       * @param {unknown} error
       * @returns {boolean}
       */
      function hasGeneratedCallSiteLocation (error) {
        assert.ok(hasCallSiteStack(error))
        const callSite = error.stack[0]
        const fileName = callSite.getFileName()
        const scriptName = callSite.getScriptNameOrSourceURL()
        assert.ok(fileName)
        assert.ok(scriptName)
        assert.match(fileName, /userhandler\.js$/)
        assert.match(scriptName, /userhandler\.js$/)
        assert.strictEqual(callSite.getLineNumber(), 3)
        assert.strictEqual(callSite.getFunctionName(), 'userhandlerInner')
        assert.strictEqual(Reflect.get(callSite, 'missing'), undefined)
        assert.match(callSite.toString(), /userhandler\.js:3:/)
        return true
      }
      assert.throws(run, hasGeneratedCallSiteLocation)
    })

    it('defers to a custom formatter accessor', function () {
      const modulePath = writeTranspiledCommonJS('accessorhandler', 'inline')
      cachedModulePaths.add(modulePath)
      /** @type {PrepareStackTrace} */
      let actualPrepareStackTrace = returnCallSites
      Object.defineProperty(Error, 'prepareStackTrace', {
        configurable: true,
        get () {
          return actualPrepareStackTrace
        },
        /**
         * @param {PrepareStackTrace} value
         */
        set (value) {
          actualPrepareStackTrace = wrapPrepareStackTrace(value)
        },
      })
      sourceMaps = proxyquire.noPreserveCache()('../../src/source-maps', {})
      sourceMaps.configure('all')
      const { run } = require(modulePath)

      /**
       * @param {unknown} error
       * @returns {boolean}
       */
      function hasAccessorCallSiteLocation (error) {
        assert.ok(hasCallSiteStack(error))
        const fileName = error.stack[0].getFileName()
        assert.ok(fileName)
        assert.match(fileName, /accessorhandler\.js$/)
        return true
      }
      assert.throws(run, hasAccessorCallSiteLocation)
    })

    it('leaves frames without a source map untouched', function () {
      const modulePath = path.join(temporaryDirectory, 'nomap.js')
      fs.writeFileSync(modulePath, 'exports.run = function run () { throw new Error("plain"); }\n')
      cachedModulePaths.add(modulePath)
      sourceMaps.configure('all')
      const { run } = require(modulePath)

      assert.match(getThrownStack(run).split('\n')[1], /nomap\.js/)
    })

    it('preserves a formatted frame without a file name', function () {
      const findSourceMap = sinon.stub()
      let generatedCode = true
      sourceMaps = loadStubbedSourceMaps(
        findSourceMap,
        undefined,
        () => ({ enabled: true, generatedCode, nodeModules: false })
      )
      sourceMaps.configure('all')
      const callSite = createCallSite(null)
      delete callSite.getEvalOrigin
      callSite.toString = () => 'run (<anonymous>)'

      assert.match(String(Error.prepareStackTrace(new Error('boom'), [callSite])), /at run \(<anonymous>\)$/)
      generatedCode = false
      const disabledCallSite = createCallSite(null)
      const getEvalOrigin = sinon.stub()
      disabledCallSite.getEvalOrigin = getEvalOrigin
      Error.prepareStackTrace(new Error('boom'), [disabledCallSite])
      sinon.assert.notCalled(getEvalOrigin)
      sinon.assert.notCalled(findSourceMap)
    })

    it('passes unresolved call-site positions to a custom formatter unchanged', function () {
      const findSourceMap = sinon.stub()
      const withoutFileName = createCallSite(null)
      const withoutLineNumber = createCallSite('/without-line.js', null)
      Error.prepareStackTrace = returnCallSites
      sourceMaps = loadStubbedSourceMaps(findSourceMap)
      sourceMaps.configure('all')

      const callSites = Error.prepareStackTrace(new Error('boom'), [withoutFileName, withoutLineNumber])
      assert.ok(Array.isArray(callSites))
      assert.strictEqual(callSites[0], withoutFileName)
      assert.strictEqual(callSites[1], withoutLineNumber)
      sinon.assert.notCalled(findSourceMap)
    })

    it('remaps a frame without a generated column number', function () {
      sourceMaps = loadStubbedSourceMaps(() => ({
        findEntry: sinon.stub().returns({
          originalSource: 'line-only.ts',
          originalLine: 3,
          originalColumn: 4,
        }),
      }))
      sourceMaps.configure('all')

      const stack = Error.prepareStackTrace(new Error('boom'), [
        createCallSite('/line-only.js', 1, null),
      ])

      assert.match(String(stack), /line-only\.ts:4:5/)
    })

    it('reloads the map when a cached CommonJS module is replaced', function () {
      const modulePath = writeTranspiledCommonJS('reloadable', 'external', 'before.ts')
      cachedModulePaths.add(modulePath)
      sourceMaps.configure('all')
      let loadedModule = require(modulePath)
      assert.match(getThrownStack(loadedModule.run), /before\.ts:1:1/)

      delete require.cache[modulePath]
      writeTranspiledCommonJS('reloadable', 'external', 'after.ts')
      loadedModule = require(modulePath)

      assert.match(getThrownStack(loadedModule.run), /after\.ts:1:1/)
    })

    it('does not retain a stale map after a module throws while loading', function () {
      const modulePath = writeThrowingCommonJS('throwing-load', 'before.ts')
      cachedModulePaths.add(modulePath)
      sourceMaps.configure('all')
      assert.match(getThrownStack(() => require(modulePath)), /before\.ts:1:1/)
      assert.strictEqual(require.cache[modulePath], undefined)

      writeThrowingCommonJS('throwing-load', 'after.ts')

      assert.match(getThrownStack(() => require(modulePath)), /after\.ts:1:1/)
    })
  })

  describe('cache and failure handling', function () {
    it('caches source maps and locations by CommonJS module', function () {
      const fileName = path.join(temporaryDirectory, 'cached.js')
      const sourceMap = {
        findEntry: sinon.stub().returns({
          originalColumn: 2,
          originalLine: 1,
          originalSource: 'cached.ts',
        }),
      }
      const findSourceMap = sinon.stub().returns(sourceMap)
      require.cache[fileName] = /** @type {NodeModule} */ ({})
      cachedModulePaths.add(fileName)
      Error.prepareStackTrace = formatFirstFileName
      sourceMaps = loadStubbedSourceMaps(findSourceMap)
      sourceMaps.configure('all')
      const callSite = createCallSite(fileName, 3, 4)

      assert.strictEqual(Error.prepareStackTrace(new Error(), [callSite]), 'cached.ts')
      assert.strictEqual(Error.prepareStackTrace(new Error(), [callSite]), 'cached.ts')
      sinon.assert.calledOnceWithExactly(findSourceMap, fileName)
      sinon.assert.calledOnceWithExactly(sourceMap.findEntry, 2, 3)
    })

    it('bounds cached locations for each source map', function () {
      const fileName = path.join(temporaryDirectory, 'location-cache.js')
      /**
       * @param {number} lineNumber
       * @param {number} columnNumber
       * @returns {{ originalColumn: number, originalLine: number, originalSource: string }}
       */
      function findEntry (lineNumber, columnNumber) {
        return {
          originalColumn: columnNumber,
          originalLine: lineNumber,
          originalSource: 'location-cache.ts',
        }
      }
      const sourceMap = {
        findEntry: sinon.stub().callsFake(findEntry),
      }
      require.cache[fileName] = /** @type {NodeModule} */ ({})
      cachedModulePaths.add(fileName)
      sourceMaps = loadStubbedSourceMaps(() => sourceMap)
      sourceMaps.configure('all')

      for (let line = 1; line <= 4096; line++) {
        sourceMapRemapping.location({ file: fileName, line, column: 1 })
      }
      sourceMapRemapping.location({ file: fileName, line: 1, column: 1 })
      assert.strictEqual(sourceMap.findEntry.callCount, 4096)

      sourceMapRemapping.location({ file: fileName, line: 4097, column: 1 })
      sourceMapRemapping.location({ file: fileName, line: 1, column: 1 })
      assert.strictEqual(sourceMap.findEntry.callCount, 4098)
    })

    it('invalidates cached maps when the source map support options change', function () {
      const fileName = path.join(temporaryDirectory, 'support-state.js')
      const beforeSourceMap = {
        findEntry: () => ({
          originalColumn: 0,
          originalLine: 0,
          originalSource: 'before.ts',
        }),
      }
      const afterSourceMap = {
        findEntry: () => ({
          originalColumn: 0,
          originalLine: 0,
          originalSource: 'after.ts',
        }),
      }
      const findSourceMap = sinon.stub()
        .onFirstCall().returns(beforeSourceMap)
        .onSecondCall().returns(afterSourceMap)
      let support = {
        enabled: true,
        generatedCode: false,
        nodeModules: false,
      }
      require.cache[fileName] = /** @type {NodeModule} */ ({})
      cachedModulePaths.add(fileName)
      Error.prepareStackTrace = formatFirstFileName
      sourceMaps = loadStubbedSourceMaps(findSourceMap, undefined, () => support)
      sourceMaps.configure('all')
      const callSite = createCallSite(fileName)

      assert.strictEqual(Error.prepareStackTrace(new Error(), [callSite]), 'before.ts')
      support = { enabled: false, generatedCode: false, nodeModules: false }
      assert.strictEqual(Error.prepareStackTrace(new Error(), [callSite]), fileName)
      support = { enabled: true, generatedCode: false, nodeModules: true }
      assert.strictEqual(Error.prepareStackTrace(new Error(), [callSite]), 'after.ts')
      sinon.assert.calledTwice(findSourceMap)
    })

    it('preserves default generated frames when source map support is disabled', function () {
      // eslint-disable-next-line n/no-unsupported-features/node-builtins
      if (typeof sourceMapsModule.setSourceMapsSupport !== 'function') this.skip()

      const fileName = path.join(temporaryDirectory, 'disabled.js')
      const findSourceMap = sinon.stub()
      let support = {
        enabled: true,
        generatedCode: false,
        nodeModules: false,
      }
      sourceMaps = loadStubbedSourceMaps(findSourceMap, undefined, () => support)
      sourceMaps.configure('all')
      support = { enabled: false, generatedCode: false, nodeModules: false }

      const stack = Error.prepareStackTrace(new Error('boom'), [createCallSite(fileName)])
      const location = { file: fileName, line: 1, column: 1 }

      assert.match(String(stack), /disabled\.js:1:1/)
      assert.strictEqual(sourceMapRemapping.location(location), location)
      sinon.assert.notCalled(findSourceMap)
    })

    it('caches source map entries without original positions', function () {
      const fileName = path.join(temporaryDirectory, 'unmapped.js')
      const sourceMap = {
        findEntry: sinon.stub().returns({
          originalColumn: 0,
          originalLine: 0,
        }),
      }
      require.cache[fileName] = /** @type {NodeModule} */ ({})
      cachedModulePaths.add(fileName)
      Error.prepareStackTrace = formatFirstFileName
      sourceMaps = loadStubbedSourceMaps(() => sourceMap)
      sourceMaps.configure('all')
      const callSite = createCallSite(fileName)

      assert.strictEqual(Error.prepareStackTrace(new Error(), [callSite]), fileName)
      assert.strictEqual(Error.prepareStackTrace(new Error(), [callSite]), fileName)
      sinon.assert.calledOnce(sourceMap.findEntry)
    })

    it('keeps a source map entry with incomplete original positions', function () {
      const fileName = path.join(temporaryDirectory, 'incomplete-position.js')
      const sourceMap = {
        findEntry: sinon.stub().returns({
          originalSource: 'incomplete-position.ts',
        }),
      }
      require.cache[fileName] = /** @type {NodeModule} */ ({})
      cachedModulePaths.add(fileName)
      Error.prepareStackTrace = formatFirstFileName
      sourceMaps = loadStubbedSourceMaps(() => sourceMap)
      sourceMaps.configure('all')
      const callSite = createCallSite(fileName)

      assert.strictEqual(Error.prepareStackTrace(new Error(), [callSite]), fileName)
      assert.strictEqual(Error.prepareStackTrace(new Error(), [callSite]), fileName)
      sinon.assert.calledOnce(sourceMap.findEntry)
    })

    it('keys source maps by the current CommonJS module object', function () {
      const fileName = path.join(temporaryDirectory, 'reloaded.js')
      const beforeSourceMap = {
        findEntry: () => ({ originalColumn: 0, originalLine: 0, originalSource: 'before.ts' }),
      }
      const afterSourceMap = {
        findEntry: () => ({ originalColumn: 0, originalLine: 0, originalSource: 'after.ts' }),
      }
      const findSourceMap = sinon.stub()
        .onFirstCall().returns(beforeSourceMap)
        .onSecondCall().returns(afterSourceMap)
      require.cache[fileName] = /** @type {NodeModule} */ ({})
      cachedModulePaths.add(fileName)
      Error.prepareStackTrace = formatFirstFileName
      sourceMaps = loadStubbedSourceMaps(findSourceMap)
      sourceMaps.configure('all')
      const callSite = createCallSite(fileName)

      assert.strictEqual(Error.prepareStackTrace(new Error(), [callSite]), 'before.ts')
      require.cache[fileName] = /** @type {NodeModule} */ ({})
      assert.strictEqual(Error.prepareStackTrace(new Error(), [callSite]), 'after.ts')
      sinon.assert.calledTwice(findSourceMap)
    })

    it('does not cache a filename when no CommonJS module is cached', function () {
      const fileName = path.join(temporaryDirectory, 'failed-load.js')
      const findSourceMap = sinon.stub()
        .onFirstCall().returns({
          findEntry: () => ({ originalColumn: 0, originalLine: 0, originalSource: 'before.ts' }),
        })
        .onSecondCall().returns({
          findEntry: () => ({ originalColumn: 0, originalLine: 0, originalSource: 'after.ts' }),
        })
      Error.prepareStackTrace = formatFirstFileName
      sourceMaps = loadStubbedSourceMaps(findSourceMap)
      sourceMaps.configure('all')
      const callSite = createCallSite(fileName)

      assert.strictEqual(Error.prepareStackTrace(new Error(), [callSite]), 'before.ts')
      assert.strictEqual(Error.prepareStackTrace(new Error(), [callSite]), 'after.ts')
      sinon.assert.calledTwice(findSourceMap)
    })

    it('falls back to generated locations when loading a source map throws', function () {
      const fileName = path.join(temporaryDirectory, 'load-error.js')
      const failure = Symbol('load failed')
      const log = { warn: sinon.stub() }
      Error.prepareStackTrace = formatFirstFileName
      sourceMaps = loadStubbedSourceMaps(() => {
        throw failure
      }, log)
      sourceMaps.configure('all')

      assert.strictEqual(Error.prepareStackTrace(new Error(), [createCallSite(fileName)]), fileName)
      sinon.assert.calledOnceWithExactly(
        log.warn,
        'Unable to load the source map for %s: %s',
        fileName,
        'Symbol(load failed)'
      )
    })

    it('falls back to generated locations when resolving a source map throws', function () {
      const fileName = path.join(temporaryDirectory, 'resolve-error.js')
      const log = { warn: sinon.stub() }
      const sourceMap = {
        findEntry: () => {
          throw new Error('resolve failed')
        },
      }
      require.cache[fileName] = /** @type {NodeModule} */ ({})
      cachedModulePaths.add(fileName)
      Error.prepareStackTrace = formatFirstFileName
      sourceMaps = loadStubbedSourceMaps(() => sourceMap, log)
      sourceMaps.configure('all')

      assert.strictEqual(Error.prepareStackTrace(new Error(), [createCallSite(fileName)]), fileName)
      sinon.assert.calledOnce(log.warn)
    })

    it('falls back to generated locations when reading current support throws', function () {
      const fileName = path.join(temporaryDirectory, 'support-error.js')
      const failure = Symbol('support failed')
      const log = { warn: sinon.stub() }
      const getSourceMapsSupport = sinon.stub()
        .onFirstCall().returns({
          enabled: true,
          generatedCode: false,
          nodeModules: false,
        })
        .onSecondCall().throws(failure)
      const findSourceMap = sinon.stub()
      Error.prepareStackTrace = formatFirstFileName
      sourceMaps = loadStubbedSourceMaps(findSourceMap, log, getSourceMapsSupport)
      sourceMaps.configure('all')

      assert.strictEqual(Error.prepareStackTrace(new Error(), [createCallSite(fileName)]), fileName)
      sinon.assert.notCalled(findSourceMap)
      sinon.assert.calledOnceWithExactly(
        log.warn,
        'Unable to read source map support: %s',
        'Symbol(support failed)'
      )
    })

    it('uses the generated file name when a call site has no script name', function () {
      const fileName = path.join(temporaryDirectory, 'without-script-name.js')
      const sourceMap = {
        findEntry: () => ({
          originalColumn: 0,
          originalLine: 0,
          originalSource: 'without-script-name.ts',
        }),
      }
      require.cache[fileName] = /** @type {NodeModule} */ ({})
      cachedModulePaths.add(fileName)
      Error.prepareStackTrace = formatCallSites
      sourceMaps = loadStubbedSourceMaps(() => sourceMap)
      sourceMaps.configure('all')
      const callSite = createCallSite(fileName)
      callSite.getScriptNameOrSourceURL = () => null

      assert.match(
        String(Error.prepareStackTrace(new Error('boom'), [callSite])),
        /without-script-name\.ts:1:1/
      )
    })

    it('keeps a frame whose formatted location cannot be identified', function () {
      const fileName = path.join(temporaryDirectory, 'unexpected-frame.js')
      const sourceMap = {
        findEntry: () => ({
          originalColumn: 0,
          originalLine: 0,
          originalSource: 'original.ts',
        }),
      }
      require.cache[fileName] = /** @type {NodeModule} */ ({})
      cachedModulePaths.add(fileName)
      Error.prepareStackTrace = formatCallSites
      sourceMaps = loadStubbedSourceMaps(() => sourceMap)
      sourceMaps.configure('all')
      const callSite = createCallSite(fileName)
      callSite.toString = () => 'unexpected frame'

      assert.match(Error.prepareStackTrace(new Error(), [callSite]), /\n {4}at unexpected frame$/)
    })

    it('keeps an original file URL when it cannot be converted to a path', function () {
      const generatedFileName = path.join(temporaryDirectory, 'invalid-url.js')
      const originalFileName = 'file:///%E0%A4%A'
      const sourceMap = {
        findEntry: () => ({
          originalColumn: 0,
          originalLine: 0,
          originalSource: originalFileName,
        }),
      }
      require.cache[generatedFileName] = /** @type {NodeModule} */ ({})
      cachedModulePaths.add(generatedFileName)
      Error.prepareStackTrace = formatFirstFileName
      sourceMaps = loadStubbedSourceMaps(() => sourceMap)
      sourceMaps.configure('all')

      assert.strictEqual(
        Error.prepareStackTrace(new Error(), [createCallSite(generatedFileName)]),
        originalFileName
      )
    })

    it('bounds the ESM source map cache', function () {
      const sourceMap = {
        findEntry: () => ({
          originalColumn: 0,
          originalLine: 0,
          originalSource: 'original.ts',
        }),
      }
      const findSourceMap = sinon.stub().returns(sourceMap)
      Error.prepareStackTrace = formatFirstFileName
      sourceMaps = loadStubbedSourceMaps(findSourceMap)
      sourceMaps.configure('all')

      for (let i = 0; i < 1024; i++) {
        const fileName = `file:///module-${i}.mjs`
        assert.strictEqual(Error.prepareStackTrace(new Error(), [createCallSite(fileName)]), 'original.ts')
      }
      assert.strictEqual(
        Error.prepareStackTrace(new Error(), [createCallSite('file:///module-0.mjs')]),
        'original.ts'
      )
      assert.strictEqual(findSourceMap.callCount, 1024)
      assert.strictEqual(
        Error.prepareStackTrace(new Error(), [createCallSite('file:///module-1024.mjs')]),
        'original.ts'
      )
      assert.strictEqual(findSourceMap.callCount, 1025)
      assert.strictEqual(Error.prepareStackTrace(
        new Error(),
        [createCallSite('file:///module-0.mjs')]
      ), 'original.ts')

      assert.strictEqual(findSourceMap.callCount, 1026)
    })
  })
})
