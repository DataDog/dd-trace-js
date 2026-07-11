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
 * @returns {string}
 */
function writeTranspiledCommonJS (
  name,
  mapKind,
  sourceName = `${name}.ts`,
  mapNames = false,
  sourceURL
) {
  const generator = new SourceMapGenerator({ file: `${name}.js` })
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
 * @param {{ warn: (...args: unknown[]) => unknown }} [log]
 * @param {() => { enabled: boolean, generatedCode: boolean, nodeModules: boolean }} [getSourceMapsSupport]
 * @returns {{ enable: () => void }}
 */
function loadStubbedSourceMaps (
  findSourceMap,
  log = { warn: sinon.stub() },
  getSourceMapsSupport = () => ({ enabled: true, generatedCode: false, nodeModules: false })
) {
  return proxyquire.noPreserveCache()('../../src/source-maps', {
    'node:module': {
      findSourceMap,
      getSourceMapsSupport,
      setSourceMapsSupport: () => {},
    },
    '../log': log,
  })
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
   *   enable: () => void,
   *   isNativeSourceMapSupportEnabled: () => boolean,
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
    if (Error.prepareStackTrace === undefined && canResolveSourceMaps) {
      Error.prepareStackTrace = formatCallSites
    }
    originalExecArgv = process.execArgv
    originalNodeOptions = process.env.NODE_OPTIONS
    // eslint-disable-next-line n/no-unsupported-features/node-builtins
    originalSourceMapsSupport = sourceMapsModule.getSourceMapsSupport?.()
    sourceMaps = proxyquire.noPreserveCache()('../../src/source-maps', {})
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
    delete require.cache[sourceMapsPath]
    for (const modulePath of cachedModulePaths) {
      delete require.cache[modulePath]
    }
    cachedModulePaths.clear()
  })

  describe('enable', function () {
    it('installs the formatter once', function () {
      const previousPrepareStackTrace = Error.prepareStackTrace
      sourceMaps.enable()

      if (!canResolveSourceMaps) {
        assert.strictEqual(Error.prepareStackTrace, previousPrepareStackTrace)
        return
      }

      const installedPrepareStackTrace = Error.prepareStackTrace
      assert.notStrictEqual(installedPrepareStackTrace, previousPrepareStackTrace)
      sourceMaps.enable()
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
      sourceMaps.enable()

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

      sourceMaps.enable()

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

      sourceMaps.enable()

      sinon.assert.notCalled(setSourceMapsSupport)
    })

    it('installs on older runtimes started with --enable-source-maps', function () {
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
      sourceMaps.enable()

      assert.notStrictEqual(Error.prepareStackTrace, previousPrepareStackTrace)
      assert.strictEqual(typeof Error.prepareStackTrace(new Error('boom'), []), 'string')
    })

    it('installs on older runtimes configured through NODE_OPTIONS', function () {
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

      sourceMaps.enable()

      assert.notStrictEqual(Error.prepareStackTrace, previousPrepareStackTrace)
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
        sourceMaps.enable()

        if (expected) {
          assert.notStrictEqual(Error.prepareStackTrace, customPrepareStackTrace)
        } else {
          assert.strictEqual(Error.prepareStackTrace, customPrepareStackTrace)
        }
      }
    })

    it('does not interrupt initialization when Node rejects source map support', function () {
      const log = { warn: sinon.stub() }
      const previousPrepareStackTrace = Error.prepareStackTrace
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

      sourceMaps.enable()

      assert.strictEqual(Error.prepareStackTrace, previousPrepareStackTrace)
      sinon.assert.calledOnce(log.warn)
    })

    it('preserves a custom formatter named like the Node default', function () {
      if (!canResolveSourceMaps) this.skip()

      function ErrorPrepareStackTrace () {
        return 'custom stack'
      }
      Error.prepareStackTrace = ErrorPrepareStackTrace
      sourceMaps = proxyquire.noPreserveCache()('../../src/source-maps', {})
      sourceMaps.enable()

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
      sourceMaps.enable()

      assert.strictEqual(new Error().stack, 'custom stack')
      assert.strictEqual(receiver, Error)
    })

    it('composes with an accessor that wraps assigned formatters', function () {
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

      sourceMaps.enable()

      assert.strictEqual(typeof assignedPrepareStackTrace, 'function')
      assert.strictEqual(Error.prepareStackTrace(new Error(), []), 'custom stack')
    })

    it('does not throw when the formatter cannot be replaced', function () {
      if (!canResolveSourceMaps) this.skip()

      const customPrepareStackTrace = () => 'custom stack'
      Object.defineProperty(Error, 'prepareStackTrace', {
        configurable: true,
        value: customPrepareStackTrace,
        writable: false,
      })
      sourceMaps = proxyquire.noPreserveCache()('../../src/source-maps', {})

      sourceMaps.enable()
      assert.strictEqual(Error.prepareStackTrace, customPrepareStackTrace)
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

      sourceMaps.enable()

      sinon.assert.calledOnceWithExactly(
        log.warn,
        'Unable to install the source map stack trace formatter: %s',
        'Unknown error'
      )
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
        sourceMaps.enable()
        const { run } = require(modulePath)

        const frames = getThrownStack(run).split('\n').slice(1, 4)

        assert.match(frames[0], new RegExp(`${mapKind}app\\.ts:1:1`))
        assert.match(frames[1], new RegExp(`${mapKind}app\\.ts:2:1`))
        assert.match(frames[2], new RegExp(`${mapKind}app\\.ts:3:1`))
      })
    }

    it('remaps a CommonJS frame rendered with sourceURL', function () {
      const modulePath = writeTranspiledCommonJS(
        'sourceurl',
        'inline',
        'sourceurl.ts',
        false,
        'virtual-sourceurl.js'
      )
      cachedModulePaths.add(modulePath)
      sourceMaps.enable()
      const { run } = require(modulePath)

      const frame = getThrownStack(run).split('\n')[1]

      assert.match(frame, /sourceurl\.ts:1:1/)
      assert.doesNotMatch(frame, /virtual-sourceurl\.js/)
    })

    it('remaps ES modules', async function () {
      const modulePath = writeTranspiledESM('esmapp')
      sourceMaps.enable()
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
        sourceMaps.enable()
        assert.strictEqual(Error.prepareStackTrace, undefined)
        return
      }
      const expected = errors.map(error => typeof nativePrepareStackTrace === 'function'
        ? nativePrepareStackTrace.call(Error, error, [])
        : Error.prototype.toString.call(error))
      sourceMaps.enable()

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
        sourceMaps.enable()

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
      sourceMaps.enable()
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
      sourceMaps.enable()
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
      sourceMaps.enable()
      const callSite = createCallSite(fileName)

      Error.prepareStackTrace(new Error('first'), [callSite])
      Error.prepareStackTrace(new Error('second'), [callSite])

      assert.strictEqual(payloadReads, 1)
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
      sourceMaps.enable()

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
      sourceMaps.enable()

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
      sourceMaps.enable()

      const stack = Error.prepareStackTrace(new Error('boom'), [createCallSite(fileName)])

      assert.match(String(stack), /run \(mapped\.ts:1:1\)$/)
    })

    it('remaps generated code when another component enabled it', function () {
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
      sourceMaps.enable()
      const callSite = createCallSite(null, 1, 2)
      callSite.getEvalOrigin = () => 'generated.js'
      callSite.toString = () => 'run (generated.js:1:2)'

      const stack = Error.prepareStackTrace(new Error('boom'), [callSite])

      assert.match(String(stack), /run \(generated\.ts:4:5\)$/)
      assert.doesNotMatch(String(stack), /generated\.js:1:2/)
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
      sourceMaps.enable()
      const callSite = createCallSite(null, 1, 2)
      callSite.getEvalOrigin = () => 'generated.js'

      assert.strictEqual(Error.prepareStackTrace(new Error('boom'), [callSite]), 'generated.ts')
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
      sourceMaps.enable()

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
      sourceMaps.enable()
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

    it('delegates to a custom formatter with original call-site locations', function () {
      const modulePath = writeTranspiledCommonJS('userhandler', 'inline')
      cachedModulePaths.add(modulePath)
      Error.prepareStackTrace = returnCallSites
      sourceMaps = proxyquire.noPreserveCache()('../../src/source-maps', {})
      sourceMaps.enable()
      const { run } = require(modulePath)

      /**
       * @param {unknown} error
       * @returns {boolean}
       */
      function hasOriginalCallSiteLocation (error) {
        assert.ok(hasCallSiteStack(error))
        const callSite = error.stack[0]
        const fileName = callSite.getFileName()
        const scriptName = callSite.getScriptNameOrSourceURL()
        assert.ok(fileName)
        assert.ok(scriptName)
        assert.match(fileName, /userhandler\.ts$/)
        assert.match(scriptName, /userhandler\.ts$/)
        assert.strictEqual(callSite.getLineNumber(), 1)
        assert.strictEqual(callSite.getColumnNumber(), 1)
        assert.strictEqual(callSite.getFunctionName(), 'userhandlerInner')
        assert.strictEqual(Reflect.get(callSite, 'missing'), undefined)
        assert.match(callSite.toString(), /userhandler\.ts:1:1/)
        return true
      }
      assert.throws(run, hasOriginalCallSiteLocation)
    })

    it('composes remapping with a formatter accessor', function () {
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
      sourceMaps.enable()
      const { run } = require(modulePath)

      /**
       * @param {unknown} error
       * @returns {boolean}
       */
      function hasAccessorCallSiteLocation (error) {
        assert.ok(hasCallSiteStack(error))
        const fileName = error.stack[0].getFileName()
        assert.ok(fileName)
        assert.match(fileName, /accessorhandler\.ts$/)
        return true
      }
      assert.throws(run, hasAccessorCallSiteLocation)
    })

    it('leaves frames without a source map untouched', function () {
      const modulePath = path.join(temporaryDirectory, 'nomap.js')
      fs.writeFileSync(modulePath, 'exports.run = function run () { throw new Error("plain"); }\n')
      cachedModulePaths.add(modulePath)
      sourceMaps.enable()
      const { run } = require(modulePath)

      assert.match(getThrownStack(run).split('\n')[1], /nomap\.js/)
    })

    it('preserves a formatted frame without a file name', function () {
      const findSourceMap = sinon.stub()
      sourceMaps = loadStubbedSourceMaps(findSourceMap)
      sourceMaps.enable()
      const callSite = createCallSite(null)
      callSite.toString = () => 'run (<anonymous>)'

      assert.match(String(Error.prepareStackTrace(new Error('boom'), [callSite])), /at run \(<anonymous>\)$/)
      sinon.assert.notCalled(findSourceMap)
    })

    it('passes unresolved call-site positions to a custom formatter unchanged', function () {
      const findSourceMap = sinon.stub()
      const withoutFileName = createCallSite(null)
      const withoutLineNumber = createCallSite('/without-line.js', null)
      Error.prepareStackTrace = returnCallSites
      sourceMaps = loadStubbedSourceMaps(findSourceMap)
      sourceMaps.enable()

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
      sourceMaps.enable()

      const stack = Error.prepareStackTrace(new Error('boom'), [
        createCallSite('/line-only.js', 1, null),
      ])

      assert.match(String(stack), /line-only\.ts:4:5/)
    })

    it('reloads the map when a cached CommonJS module is replaced', function () {
      const modulePath = writeTranspiledCommonJS('reloadable', 'external', 'before.ts')
      cachedModulePaths.add(modulePath)
      sourceMaps.enable()
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
      sourceMaps.enable()
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
      sourceMaps.enable()
      const callSite = createCallSite(fileName, 3, 4)

      assert.strictEqual(Error.prepareStackTrace(new Error(), [callSite]), 'cached.ts')
      assert.strictEqual(Error.prepareStackTrace(new Error(), [callSite]), 'cached.ts')
      sinon.assert.calledOnceWithExactly(findSourceMap, fileName)
      sinon.assert.calledOnceWithExactly(sourceMap.findEntry, 2, 3)
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
      sourceMaps.enable()
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
      sourceMaps.enable()
      support = { enabled: false, generatedCode: false, nodeModules: false }

      const stack = Error.prepareStackTrace(new Error('boom'), [createCallSite(fileName)])

      assert.match(String(stack), /disabled\.js:1:1/)
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
      sourceMaps.enable()
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
      sourceMaps.enable()
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
      sourceMaps.enable()
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
      sourceMaps.enable()
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
      sourceMaps.enable()

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
      sourceMaps.enable()

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
      sourceMaps.enable()

      assert.strictEqual(Error.prepareStackTrace(new Error(), [createCallSite(fileName)]), fileName)
      sinon.assert.notCalled(findSourceMap)
      sinon.assert.calledOnceWithExactly(
        log.warn,
        'Unable to read source map support: %s',
        'Symbol(support failed)'
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
      sourceMaps.enable()
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
      sourceMaps.enable()

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
      sourceMaps.enable()

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
