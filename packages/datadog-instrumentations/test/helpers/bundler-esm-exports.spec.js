'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const path = require('node:path')
const { PassThrough } = require('node:stream')
const { pathToFileURL } = require('node:url')

const sinon = require('sinon')

const {
  createEsmResolver,
  driveGetExportsGenerator,
  processModule,
} = require('../../src/helpers/bundler-esm-exports')
const transformTypeScript = require('./bundler-esm-exports/transform-typescript')

let spawn

function createChild () {
  const child = new EventEmitter()
  child.stderr = new PassThrough()
  child.stdio = [null, null, child.stderr, new PassThrough(), new PassThrough()]
  child.kill = sinon.stub()
  return child
}

/**
 * @param {ReturnType<typeof createChild>} child
 * @returns {ReturnType<typeof createEsmResolver>}
 */
function createStubbedResolver (child) {
  spawn = sinon.stub(childProcess, 'spawn').returns(child)
  return createEsmResolver()
}

describe('ESM resolver', () => {
  const parentURL = pathToFileURL(require.resolve('./bundler-esm-exports/export-method.mjs'))

  afterEach(() => {
    spawn?.restore()
    spawn = undefined
  })

  it('resolves concurrent import requests with the importing module as parent', async () => {
    const resolver = createEsmResolver()
    try {
      const localPath = require.resolve('./bundler-esm-exports/space ü.mjs')
      const localURL = pathToFileURL(localPath).href
      const [bare, subpath, relative, absolute, fileURL, builtin] = await Promise.all([
        resolver.resolve('@actions/core', parentURL),
        resolver.resolve('@eslint/eslintrc/universal', parentURL),
        resolver.resolve('./export-default-method.mjs', parentURL),
        resolver.resolve(localPath, parentURL),
        resolver.resolve(localURL, parentURL),
        resolver.resolve('node:fs', parentURL),
      ])

      assert.match(bare, /\/node_modules\/@actions\/core\/lib\/core\.js$/)
      assert.match(subpath, /\/node_modules\/@eslint\/eslintrc\/lib\/index-universal\.js$/)
      assert.equal(relative, pathToFileURL(require.resolve('./bundler-esm-exports/export-default-method.mjs')).href)
      assert.equal(absolute, localURL)
      assert.equal(fileURL, localURL)
      assert.equal(builtin, 'node:fs')
    } finally {
      await resolver.close()
    }
  })

  it('preserves NODE_OPTIONS resolution hooks in the child', async () => {
    const originalNodeOptions = process.env.NODE_OPTIONS
    const hookURL = pathToFileURL(require.resolve('./bundler-esm-exports/resolution-hook.mjs'))
    hookURL.searchParams.set('target', parentURL.href)
    process.env.NODE_OPTIONS = `--loader=${hookURL.href}`
    const resolver = createEsmResolver()

    try {
      assert.equal(await resolver.resolve('resolver-hook', parentURL), parentURL.href)
    } finally {
      await resolver.close()
      if (originalNodeOptions === undefined) delete process.env.NODE_OPTIONS
      else process.env.NODE_OPTIONS = originalNodeOptions
    }
  })

  it('isolates resolver responses from inherited standard output', async () => {
    const originalNodeOptions = process.env.NODE_OPTIONS
    const preloadPath = require.resolve('./bundler-esm-exports/resolver-stdout.cjs')
    process.env.NODE_OPTIONS = `--require=${JSON.stringify(preloadPath)}`
    const resolver = createEsmResolver()

    try {
      assert.equal(await resolver.resolve('./export-method.mjs', parentURL), parentURL.href)
    } finally {
      await resolver.close()
      if (originalNodeOptions === undefined) delete process.env.NODE_OPTIONS
      else process.env.NODE_OPTIONS = originalNodeOptions
    }
  })

  it('preserves mixed NODE_OPTIONS while disabling Datadog in the child', async () => {
    const originalNodeOptions = process.env.NODE_OPTIONS
    const hookURL = pathToFileURL(require.resolve('./bundler-esm-exports/resolution-hook.mjs')).href
    const initPath = require.resolve('../../../../init.js')
    const nodeOptions = `--loader=${hookURL} --require=${JSON.stringify(initPath)}`
    process.env.NODE_OPTIONS = nodeOptions
    const child = createChild()
    const resolver = createStubbedResolver(child)
    const resolved = resolver.resolve('first', parentURL)
    let env

    try {
      env = spawn.firstCall.args[2].env
      child.stdio[4].write(`${JSON.stringify({ id: 0, url: 'file:///first.mjs' })}\n`)
      assert.equal(await resolved, 'file:///first.mjs')
    } finally {
      const closed = resolver.close()
      child.emit('close', 0, null)
      await closed
      if (originalNodeOptions === undefined) delete process.env.NODE_OPTIONS
      else process.env.NODE_OPTIONS = originalNodeOptions
    }

    assert.equal(env.NODE_OPTIONS, nodeOptions)
    assert.equal(env.DD_CIVISIBILITY_ENABLED, 'false')
    assert.equal(env.DD_INSTRUMENTATION_TELEMETRY_ENABLED, 'false')
    assert.equal(env.DD_TRACE_ENABLED, 'false')
  })

  it('rejects invalid encoded ESM requests without affecting siblings', async () => {
    const resolver = createEsmResolver()
    try {
      const encodedSeparator = resolver.resolve('./%2F.mjs', parentURL)
      const sibling = resolver.resolve('./export-method.mjs', parentURL)
      const [, resolved] = await Promise.all([
        assert.rejects(encodedSeparator, { code: 'ERR_INVALID_MODULE_SPECIFIER' }),
        sibling,
      ])

      assert.equal(resolved, parentURL.href)
    } finally {
      await resolver.close()
    }
  })

  it('rejects requests after closing', async () => {
    const resolver = createEsmResolver()
    await resolver.close()

    await assert.rejects(resolver.resolve('closed', parentURL), /The ESM resolver is closed/)
  })

  it('drives synchronous loads and asynchronous resolutions through one generator', async () => {
    function * operations () {
      const loaded = yield [0, parentURL, { format: 'module' }]
      const resolved = yield [1, './value.mjs', { parentURL }]
      return new Set([loaded.source, resolved.url.href])
    }
    const getSource = sinon.stub().returns({ format: 'module', source: 'source' })
    const resolve = sinon.stub().resolves({ format: 'module', url: new URL('./value.mjs', parentURL) })

    const result = await driveGetExportsGenerator(operations(), getSource, resolve)

    assert.deepEqual(result, { exportNames: new Set(['source', new URL('./value.mjs', parentURL).href]) })
    sinon.assert.calledWithExactly(getSource, parentURL, { format: 'module' })
    sinon.assert.calledWithExactly(resolve, './value.mjs', { parentURL })
  })

  it('normalizes supported import-in-the-middle export result shapes', async () => {
    const legacyExportNames = new Set(['legacy'])
    const moduleExports = {
      exportNames: ['modern'],
      starReexports: [{ parentURL: parentURL.href, specifier: './value.mjs' }],
    }
    function * exportsResult (result) {
      yield [0, parentURL, { format: 'module' }]
      return result
    }

    assert.deepEqual(
      await driveGetExportsGenerator(exportsResult(legacyExportNames), sinon.stub(), sinon.stub()),
      { exportNames: legacyExportNames }
    )
    assert.strictEqual(
      await driveGetExportsGenerator(exportsResult(moduleExports), sinon.stub(), sinon.stub()),
      moduleExports
    )
  })

  it('returns generator-owned resolution and protocol errors', async () => {
    function * resolutionFailure () {
      try {
        yield [1, 'missing', { parentURL }]
      } catch (error) {
        return new Set([error.message])
      }
    }
    function * protocolFailure () {
      try {
        yield [2]
      } catch (error) {
        return new Set([error.message])
      }
    }
    const expected = new Error('resolution failed')

    assert.deepEqual(
      await driveGetExportsGenerator(resolutionFailure(), sinon.stub(), sinon.stub().rejects(expected)),
      { exportNames: new Set([expected.message]) }
    )
    assert.deepEqual(
      await driveGetExportsGenerator(protocolFailure(), sinon.stub(), sinon.stub()),
      { exportNames: new Set(['Unsupported import-in-the-middle getExports operation: 2']) }
    )
  })

  it('rejects malformed correlated responses without failing another request', async () => {
    const child = createChild()
    const resolver = createStubbedResolver(child)
    const first = resolver.resolve('first', parentURL)
    const second = resolver.resolve('second', parentURL)
    child.stdio[4].write(`${JSON.stringify({ id: 0, url: 1 })}\n`)
    child.stdio[4].write(`${JSON.stringify({ id: 1, url: 'file:///second.mjs' })}\n`)

    const [, resolved] = await Promise.all([
      assert.rejects(first, /malformed response/),
      second,
    ])
    assert.equal(resolved, 'file:///second.mjs')

    const closed = resolver.close()
    child.emit('close', 0, null)
    await closed
  })

  it('rejects synchronous spawn and request write failures', async () => {
    const spawnError = new Error('spawn failed')
    spawn = sinon.stub(childProcess, 'spawn').throws(spawnError)
    const resolver = createEsmResolver()
    await assert.rejects(resolver.resolve('first', parentURL), spawnError)
    await resolver.close()
    spawn.restore()

    const child = createChild()
    const writeError = new Error('write failed')
    sinon.stub(child.stdio[3], 'write').callsFake((value, callback) => {
      callback(writeError)
      return true
    })
    spawn = sinon.stub(childProcess, 'spawn').returns(child)
    const writeResolver = createEsmResolver()
    await assert.rejects(writeResolver.resolve('second', parentURL), writeError)
    const closed = writeResolver.close()
    child.emit('close', 0, null)
    await closed
  })

  it('uses a request EPIPE as the resolver lifecycle failure', async () => {
    const child = createChild()
    const resolver = createStubbedResolver(child)
    const failure = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
    const pending = resolver.resolve('first', parentURL)
    const results = Promise.all([
      assert.rejects(pending, failure),
      assert.rejects(resolver.close(), failure),
    ])
    let emitted
    try {
      child.stdio[3].emit('error', failure)
    } catch (error) {
      emitted = error
    }
    child.emit('close', 1, null)

    await results
    assert.equal(emitted, undefined)
    sinon.assert.calledOnce(child.kill)
  })

  it('does not emit an unhandled rejection before close observes a failure', async () => {
    const child = createChild()
    const resolver = createStubbedResolver(child)
    const pending = resolver.resolve('first', parentURL)
    let unhandled
    const onUnhandledRejection = error => { unhandled = error }
    process.once('unhandledRejection', onUnhandledRejection)

    try {
      child.stdio[4].write('not JSON\n')
      await assert.rejects(pending, /malformed JSON/)
      child.emit('close', 1, null)
      await new Promise(resolve => setImmediate(resolve))
      await assert.rejects(resolver.close(), /malformed JSON/)
    } finally {
      process.removeListener('unhandledRejection', onUnhandledRejection)
    }

    assert.equal(unhandled, undefined)
  })

  it('ignores a late write failure after the response completed', async () => {
    const child = createChild()
    let writeCallback
    sinon.stub(child.stdio[3], 'write').callsFake((value, callback) => {
      writeCallback = callback
      return true
    })
    const resolver = createStubbedResolver(child)
    const resolved = resolver.resolve('first', parentURL)
    child.stdio[4].write(`${JSON.stringify({ id: 0, url: 'file:///first.mjs' })}\n`)

    assert.equal(await resolved, 'file:///first.mjs')
    writeCallback(new Error('late write failure'))
    const closed = resolver.close()
    child.emit('close', 0, null)
    await closed
  })

  it('rejects unknown response identifiers and preserves the first protocol failure', async () => {
    const child = createChild()
    const resolver = createStubbedResolver(child)
    const pending = resolver.resolve('first', parentURL)
    const results = Promise.all([
      assert.rejects(pending, /unknown request identifier/),
      assert.rejects(resolver.close(), /unknown request identifier/),
    ])
    child.stdio[4].write(`${JSON.stringify({ id: 1, url: 'file:///unknown.mjs' })}\n`)
    child.emit('error', new Error('later child error'))
    child.emit('close', 1, null)

    await results
  })

  it('bounds standard error when a child exits from a signal', async () => {
    const child = createChild()
    const resolver = createStubbedResolver(child)
    const pending = resolver.resolve('first', parentURL)
    const isBoundedSignalError = error => {
      assert.match(error.message, /^The ESM resolver exited with signal SIGTERM: x+$/)
      assert.ok(error.message.length < 17 * 1024)
      return true
    }
    const results = Promise.all([
      assert.rejects(pending, isBoundedSignalError),
      assert.rejects(resolver.close(), isBoundedSignalError),
    ])
    child.stderr.write('x'.repeat(16 * 1024))
    child.stderr.write('ignored')
    child.emit('close', null, 'SIGTERM')

    await results
  })

  it('reports an early exit without standard error', async () => {
    const child = createChild()
    const resolver = createStubbedResolver(child)
    const pending = resolver.resolve('first', parentURL)
    const results = Promise.all([
      assert.rejects(pending, /exited with status 2$/),
      assert.rejects(resolver.close(), /exited with status 2$/),
    ])
    child.emit('close', 2, null)

    await results
  })

  it('rejects every pending request when the child exits early', async () => {
    const child = createChild()
    const resolver = createStubbedResolver(child)
    const first = resolver.resolve('first', parentURL)
    const second = resolver.resolve('second', parentURL)
    const results = Promise.all([
      assert.rejects(first, /status 1: resolver failed/),
      assert.rejects(second, /status 1: resolver failed/),
      assert.rejects(resolver.close(), /status 1: resolver failed/),
    ])
    child.stderr.write('resolver failed')
    child.emit('close', 1, null)
    child.stdio[3].emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))

    await results
  })

  it('bounds pending requests and rejects malformed uncorrelated output', async () => {
    const child = createChild()
    const resolver = createStubbedResolver(child)
    const pending = []
    for (let index = 0; index < 1024; index++) {
      pending.push(resolver.resolve(String(index), parentURL))
    }
    await assert.rejects(resolver.resolve('overflow', parentURL), /more than 1024 pending requests/)

    const results = Promise.all([
      ...pending.map(request => assert.rejects(request, /malformed JSON/)),
      assert.rejects(resolver.close(), /malformed JSON/),
    ])
    child.stdio[4].write('not JSON\n')
    child.emit('close', 1, null)

    await results
    sinon.assert.calledOnce(child.kill)
  })
})

describe('ESM export analysis', () => {
  describe('processModule', () => {
    it('should set a single exported method', async () => {
      const setters = await processModule({
        path: path.join(__dirname, 'bundler-esm-exports', 'export-method.mjs'),
        context: { format: 'module' },
      })
      assert.strictEqual(setters.size, 1)
      assert.strictEqual(setters.has('exportMethod'), true)
    })

    it('should set the default exported method', async () => {
      const setters = await processModule({
        path: path.join(__dirname, 'bundler-esm-exports', 'export-default-method.mjs'),
        context: { format: 'module' },
      })

      assert.strictEqual(setters.size, 1)
      assert.strictEqual(setters.has('default'), true)
    })

    it('should set the nested exports', async () => {
      const modulePath = path.join(__dirname, 'bundler-esm-exports', 'export-method-and-nested-method.mjs')
      const nestedPath = path.join(__dirname, 'bundler-esm-exports', 'export-method.mjs')
      const moduleSources = new Map()
      const setters = await processModule({
        path: modulePath,
        context: { format: 'module' },
        moduleSources,
      })

      assert.strictEqual(setters.size, 2)
      assert.strictEqual(setters.has('exportMethod'), true)
      assert.strictEqual(setters.has('exportedMethod2'), true)
      assert.strictEqual(moduleSources.size, 2)
      assert.strictEqual(moduleSources.get(modulePath), fs.readFileSync(modulePath, 'utf8'))
      assert.strictEqual(moduleSources.get(nestedPath), fs.readFileSync(nestedPath, 'utf8'))
    })

    it('should resolve bare star exports with import conditions', async () => {
      const modulePath = path.join(__dirname, 'bundler-esm-exports', 'export-bare-star.mjs')
      const setters = await processModule({
        path: modulePath,
        context: { format: 'module' },
        moduleSources: new Map([[modulePath, "export * from '@actions/core'\n"]]),
      })

      assert.strictEqual(setters.has('setSecret'), true)
    })

    it('should resolve package imports with import conditions', async () => {
      const setters = await processModule({
        path: path.join(__dirname, 'bundler-esm-exports', 'imports', 'index.mjs'),
        context: { format: 'module' },
      })

      assert.strictEqual(setters.has('imported'), true)
    })

    it('should collect builtin star exports without reading them as files', async () => {
      const modulePath = path.join(__dirname, 'bundler-esm-exports', 'export-builtin.mjs')
      const setters = await processModule({
        path: modulePath,
        context: { format: 'module' },
        moduleSources: new Map([[modulePath, "export * from 'node:fs'\n"]]),
      })

      assert.strictEqual(setters.has('readFile'), true)
    })

    it('should reject non-file star export targets', async () => {
      const nonFilePath = path.join(__dirname, 'bundler-esm-exports', 'export-non-file.mjs')

      await assert.rejects(processModule({
        path: nonFilePath,
        context: { format: 'module' },
        moduleSources: new Map([[
          nonFilePath,
          "export * from 'data:text/javascript,export const value = true'\n",
        ]]),
      }), /Unsupported ESM resolution URL: data:/)
    })

    it('should reject native module star exports', async () => {
      const nativePath = path.join(__dirname, 'bundler-esm-exports', 'export-native.mjs')

      await assert.rejects(processModule({
        path: nativePath,
        context: { format: 'module' },
        moduleSources: new Map([[nativePath, "export * from './value.node'\n"]]),
      }), /Unsupported ESM analysis target: .*value\.node/)
    })

    it('should ignore JSON star exports', async () => {
      const jsonPath = path.join(__dirname, 'bundler-esm-exports', 'export-json.mjs')
      const setters = await processModule({
        path: jsonPath,
        context: { format: 'module' },
        moduleSources: new Map([[jsonPath, "export * from './value.json'\n"]]),
      })

      assert.deepStrictEqual([...setters.keys()], [])
    })

    it('should terminate cyclic star exports', async () => {
      const setters = await processModule({
        path: path.join(__dirname, 'bundler-esm-exports', 'export-cycle-a.mjs'),
        context: { format: 'module' },
      })

      assert.deepStrictEqual([...setters.keys()].sort(), ['fromA', 'fromB'])
    })

    it('should set TypeScript star exports', async () => {
      let transforms = 0
      const setters = await processModule({
        path: path.join(__dirname, 'bundler-esm-exports', 'export-typescript-star.mjs'),
        context: { format: 'module' },
        transform: (source, options) => {
          transforms++
          return transformTypeScript(source, options)
        },
      })

      assert.deepStrictEqual([...setters.keys()].sort(), ['Client', 'sibling', 'value'])
      assert.strictEqual(transforms, 3)
    })

    it('should preserve explicit ESM module.exports star exports', async () => {
      const setters = await processModule({
        path: path.join(__dirname, 'bundler-esm-exports', 'export-module-exports-star.mjs'),
        context: { format: 'module' },
      })

      assert.deepStrictEqual([...setters.keys()], ['module.exports'])
    })

    it('should set the native module exports', async () => {
      const setters = await processModule({
        path: 'http',
        internal: true,
        context: { format: 'module' },
      })

      assert.strictEqual(setters.size, Object.keys(await import('http')).length)
      assert.strictEqual(setters.has('default'), true)
      assert.strictEqual(setters.has('createServer'), true)
      assert.strictEqual(setters.has('METHODS'), true)
    })

    it('should generate distinct locals for export names that sanitize identically', async () => {
      const modulePath = path.join(__dirname, 'bundler-esm-exports', 'colliding-export-names.mjs')
      const setters = await processModule({
        path: modulePath,
        context: { format: 'module' },
        moduleSources: new Map([[
          modulePath,
          'const foo_bar = 1, fooBar = 2\nexport { foo_bar, fooBar as "foo-bar" }\n',
        ]]),
      })
      const source = `
        const namespace = { foo_bar: 1, 'foo-bar': 2 }
        const _ = {}
        const set = {}
        const get = {}
        ${[...setters.values()].join('\n')}
      `
      const namespace = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)

      assert.strictEqual(namespace.foo_bar, 1)
      assert.strictEqual(namespace['foo-bar'], 2)
    })
  })
})
