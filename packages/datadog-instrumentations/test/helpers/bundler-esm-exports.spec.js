'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const path = require('node:path')
const { PassThrough } = require('node:stream')
const { pathToFileURL } = require('node:url')

const iitm = require('import-in-the-middle')
const sinon = require('sinon')

const { createEsmResolver, createEsmWrapper } = require('../../src/helpers/bundler-esm-exports')
const transformTypeScript = require('./bundler-esm-exports/transform-typescript')

const FIXTURES = path.join(__dirname, 'bundler-esm-exports')

let spawn

/**
 * Wrappers import modules by absolute path, which bundlers resolve. Data URLs need file URLs instead.
 *
 * @param {string} code
 */
function importWrapper (code) {
  const source = code.replaceAll(/from ("[^"]+")/g, (match, literal) => {
    const specifier = JSON.parse(literal)
    return path.isAbsolute(specifier) ? `from ${JSON.stringify(pathToFileURL(specifier).href)}` : match
  })
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
}

/**
 * @param {Parameters<typeof createEsmWrapper>[0]['path']} modulePath
 * @param {Partial<Parameters<typeof createEsmWrapper>[0]>} [options]
 */
async function createWrapper (modulePath, options) {
  const resolver = createEsmResolver()
  try {
    return await createEsmWrapper({ path: modulePath, specifier: 'fixture', resolver, ...options })
  } finally {
    await resolver.close()
  }
}

/**
 * @param {string} code
 */
function getExportNames (code) {
  return [...code.matchAll(/\$\d+ as (default|"(?:[^"\\]|\\.)*")/g)]
    .map(([, name]) => name === 'default' ? name : JSON.parse(name))
    .sort()
}

describe('bundler ESM wrappers', () => {
  /** @type {Array<[string, boolean, string, string, string]>} */
  const modules = [
    [path.join(FIXTURES, 'space ü.mjs'), false, 'fixture/space "ü"', 'unicodePath',
      pathToFileURL(path.join(FIXTURES, 'space ü.mjs')).href],
    ['node:dns/promises', true, 'node:dns/promises', 'lookup', 'node:dns/promises'],
    ['dns/promises', true, 'dns/promises', 'lookup', 'node:dns/promises'],
  ]
  for (const [modulePath, internal, specifier, exportName, moduleURL] of modules) {
    it(`registers replaceable exports and the original specifier for ${specifier}`, async () => {
      const code = await createWrapper(modulePath, { internal, specifier })
      const replacement = () => 'instrumented'
      const registrations = []
      const hook = (url, namespace, originalSpecifier) => {
        if (url !== moduleURL) return
        registrations.push(originalSpecifier)
        namespace[exportName] = replacement
      }
      iitm.addHook(hook)
      // Adding a hook replays the registrations of wrappers evaluated by earlier tests.
      registrations.length = 0
      try {
        const exports = await importWrapper(code)

        assert.deepStrictEqual(registrations, [specifier])
        assert.strictEqual(exports[exportName], replacement)
        assert.doesNotMatch(code, /dd-trace:bundler:load|__iitm_/)
      } finally {
        iitm.removeHook(hook)
      }
    })
  }

  it('imports the module defining a name re-exported through several star exports', async () => {
    const definingPath = path.join(FIXTURES, 'export-method.mjs')
    const code = await createWrapper(path.join(FIXTURES, 'export-shared-star.mjs'))
    const exports = await importWrapper(code)

    assert.ok(code.includes(`from ${JSON.stringify(definingPath)}`))
    assert.deepStrictEqual(Object.keys(exports), ['exportMethod'])
    assert.strictEqual(typeof exports.exportMethod, 'function')
  })

  it('should set a single exported method', async () => {
    assert.deepStrictEqual(getExportNames(await createWrapper(path.join(FIXTURES, 'export-method.mjs'))),
      ['exportMethod'])
  })

  it('should set the default exported method', async () => {
    assert.deepStrictEqual(getExportNames(await createWrapper(path.join(FIXTURES, 'export-default-method.mjs'))),
      ['default'])
  })

  it('should set the nested exports and share the sources it reads', async () => {
    const modulePath = path.join(FIXTURES, 'export-method-and-nested-method.mjs')
    const nestedPath = path.join(FIXTURES, 'export-method.mjs')
    const moduleSources = new Map()
    const code = await createWrapper(modulePath, { moduleSources })

    assert.deepStrictEqual(getExportNames(code), ['exportMethod', 'exportedMethod2'])
    assert.strictEqual(moduleSources.size, 2)
    assert.strictEqual(moduleSources.get(modulePath), fs.readFileSync(modulePath, 'utf8'))
    assert.strictEqual(moduleSources.get(nestedPath), fs.readFileSync(nestedPath, 'utf8'))
  })

  it('should resolve bare star exports with import conditions', async () => {
    const modulePath = path.join(FIXTURES, 'export-bare-star.mjs')
    const code = await createWrapper(modulePath, {
      moduleSources: new Map([[modulePath, "export * from '@actions/core'\n"]]),
    })

    assert.ok(getExportNames(code).includes('setSecret'))
  })

  it('should resolve package imports with import conditions', async () => {
    const code = await createWrapper(path.join(FIXTURES, 'imports', 'index.mjs'))

    assert.deepStrictEqual(getExportNames(code), ['imported'])
  })

  it('should resolve CommonJS re-exports with require conditions', async () => {
    const code = await createWrapper(path.join(FIXTURES, 'conditions', 'index.mjs'))

    const names = getExportNames(code)

    assert.ok(names.includes('required'))
    assert.ok(names.includes('join'), 'builtin re-exports resolve to the builtin')
    assert.ok(!names.includes('imported'))
  })

  it('should collect builtin star exports without reading them as files', async () => {
    const modulePath = path.join(FIXTURES, 'export-builtin.mjs')
    const code = await createWrapper(modulePath, {
      moduleSources: new Map([[modulePath, "export * from 'node:fs'\n"]]),
    })

    assert.ok(getExportNames(code).includes('readFile'))
  })

  it('should reject non-file star export targets', async () => {
    const modulePath = path.join(FIXTURES, 'export-non-file.mjs')

    await assert.rejects(createWrapper(modulePath, {
      moduleSources: new Map([[modulePath, "export * from 'data:text/javascript,export const value = true'\n"]]),
    }), /Unsupported ESM resolution URL: data:/)
  })

  it('should reject native module star exports', async () => {
    const modulePath = path.join(FIXTURES, 'export-native.mjs')

    await assert.rejects(createWrapper(modulePath, {
      moduleSources: new Map([[modulePath, "export * from './value.node'\n"]]),
    }), /Unsupported ESM analysis target: .*value\.node/)
  })

  it('should ignore JSON star exports', async () => {
    const modulePath = path.join(FIXTURES, 'export-json.mjs')
    const code = await createWrapper(modulePath, {
      moduleSources: new Map([[modulePath, "export * from './value.json'\n"]]),
    })

    assert.deepStrictEqual(getExportNames(code), [])
  })

  it('should terminate cyclic star exports', async () => {
    const code = await createWrapper(path.join(FIXTURES, 'export-cycle-a.mjs'))

    assert.deepStrictEqual(getExportNames(code), ['fromA', 'fromB'])
  })

  it('should strip TypeScript from star export targets', async () => {
    let transforms = 0
    const code = await createWrapper(path.join(FIXTURES, 'export-typescript-star.mjs'), {
      transform: (source, options) => {
        transforms++
        return transformTypeScript(source, options)
      },
    })

    assert.deepStrictEqual(getExportNames(code), ['Client', 'sibling', 'value'])
    assert.strictEqual(transforms, 3)
  })

  it('should strip TypeScript from the wrapped module', async () => {
    const code = await createWrapper(path.join(FIXTURES, 'typescript-export.mts'), { transform: transformTypeScript })

    assert.deepStrictEqual(getExportNames(code), ['Client'])
  })

  it('should preserve explicit ESM module.exports star exports', async () => {
    const code = await createWrapper(path.join(FIXTURES, 'export-module-exports-star.mjs'))

    assert.deepStrictEqual(getExportNames(code), ['module.exports'])
  })

  it('should set the builtin module exports', async () => {
    const names = getExportNames(await createWrapper('http', { internal: true }))

    assert.strictEqual(names.length, Object.keys(await import('http')).length)
    assert.ok(names.includes('default'))
    assert.ok(names.includes('createServer'))
    assert.ok(names.includes('METHODS'))
  })
})

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
