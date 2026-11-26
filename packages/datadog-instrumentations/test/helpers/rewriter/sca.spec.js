'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { mkdtempSync, readFileSync } = require('node:fs')
const Module = require('node:module')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { pathToFileURL } = require('node:url')

const { channel } = require('dc-polyfill')
const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')

const { instrumentations: scaInstrumentations } = require('../../../src/helpers/rewriter/sca-targets')
const { getRewriteTarget } = require('../../../src/helpers/rewriter/targets')

const packageDirectory = resolve(__dirname, 'node_modules', 'test-sca')
const filename = join(packageDirectory, 'index.js')
const source = readFileSync(filename, 'utf8')
const rewriterDirectory = resolve(__dirname, '../../../src/helpers/rewriter')

/**
 * @param {string} channelName
 * @param {object} functionQuery
 * @param {string} [versionRange]
 */
function entry (channelName, functionQuery, versionRange = '>=1.0.0 <2.0.0') {
  return { module: { name: 'test-sca', versionRange, filePath: 'index.js' }, functionQuery, channelName }
}

describe('rewriter Runtime SCA targets', () => {
  let scaEnabled
  let subscriptions

  beforeEach(() => {
    scaEnabled = process.env.DD_APPSEC_SCA_ENABLED
    process.env.DD_APPSEC_SCA_ENABLED = 'true'
    subscriptions = []
  })

  afterEach(() => {
    if (scaEnabled === undefined) {
      delete process.env.DD_APPSEC_SCA_ENABLED
    } else {
      process.env.DD_APPSEC_SCA_ENABLED = scaEnabled
    }
    for (const [name, subscriber] of subscriptions) channel(name).unsubscribe(subscriber)
  })

  /**
   * @param {object[]} table
   */
  function createRewriter (table) {
    const scaTargets = proxyquire('../../../src/helpers/rewriter/sca-targets', {
      './sca-instrumentations.json': table,
    })
    return proxyquire('../../../src/helpers/rewriter', { './sca-targets': scaTargets })
  }

  /**
   * @param {string} code
   */
  function load (code) {
    const mod = new Module(filename, module)
    mod.filename = filename
    mod.paths = Module._nodeModulePaths(packageDirectory)
    mod._compile(code, filename)
    return mod.exports
  }

  /**
   * @param {string} name
   */
  function record (name) {
    const messages = []
    const subscriber = message => messages.push(message)
    channel(name).subscribe(subscriber)
    subscriptions.push([name, subscriber])
    return messages
  }

  it('publishes each time a vulnerable function is entered, without changing what it does', async () => {
    const names = ['declared', 'arrow', 'named', 'constructor', 'method', 'property', 'async', 'generator', 'throws']
    const rewriter = createRewriter([
      entry('declared', { functionName: 'declared' }),
      entry('arrow', { expressionName: 'arrow' }),
      entry('named', { expressionName: 'named' }),
      entry('constructor', { className: 'Derived' }),
      entry('method', { className: 'Derived', methodName: 'method' }),
      entry('property', { methodName: 'property' }),
      entry('async', { functionName: 'asyncFunction' }),
      entry('generator', { functionName: 'generator' }),
      entry('throws', { functionName: 'throws' }),
    ])
    const { declared, arrow, named, Base, Derived, object, asyncFunction, generator, throws } =
      load(rewriter.rewrite(source, filename, 'commonjs'))
    const entries = Object.fromEntries(names.map(name => [name, record(`orchestrion:test-sca:${name}`)]))
    const entryCounts = () => Object.fromEntries(names.map(name => [name, entries[name].length]))
    const receiver = {}

    assert.deepStrictEqual(declared.call(receiver, 'a', 'b'), [receiver, 'a', 2])
    // The function keeps its own 'use strict' directive.
    assert.deepStrictEqual(declared('a'), [undefined, 'a', 1])
    assert.strictEqual(arrow(2), 4)
    assert.strictEqual(named(3), 3)
    const instance = new Derived(1)
    assert.ok(instance instanceof Base)
    assert.strictEqual(instance.derived, true)
    assert.strictEqual(instance.method(2), 3)
    assert.strictEqual(object.property(5), 5)
    const promise = asyncFunction(6)
    assert.strictEqual(entries.async.length, 1)
    assert.strictEqual(await promise, 6)
    const iterator = generator()
    assert.strictEqual(entries.generator.length, 0)
    assert.deepStrictEqual(iterator.next(), { value: 1, done: false })
    assert.throws(() => throws(), { message: 'boom' })

    assert.deepStrictEqual(entryCounts(), {
      declared: 2,
      arrow: 1,
      named: 1,
      constructor: 1,
      method: 1,
      property: 1,
      async: 1,
      generator: 1,
      throws: 1,
    })
  })

  it('publishes once per call when a target is rewritten again', () => {
    const rewriter = createRewriter([entry('named', { expressionName: 'named' })])
    const rewritten = rewriter.rewrite(source, filename, 'commonjs')
    const { named } = load(rewriter.rewrite(rewritten, filename, 'commonjs'))
    const entries = record('orchestrion:test-sca:named')

    named(1)

    assert.strictEqual(entries.length, 1)
  })

  it('leaves targets untouched when Runtime SCA is disabled', () => {
    process.env.DD_APPSEC_SCA_ENABLED = 'false'
    const rewriter = createRewriter([entry('declared', { functionName: 'declared' })])

    assert.strictEqual(rewriter.rewrite(source, filename, 'commonjs'), source)
  })

  it('leaves versions outside the vulnerable range untouched', () => {
    const rewriter = createRewriter([entry('declared', { functionName: 'declared' }, '>=2.0.0')])

    assert.strictEqual(rewriter.rewrite(source, filename, 'commonjs'), source)
  })

  it('publishes the vulnerable functions it could not rewrite when the module is evaluated', () => {
    const failures = record('dd-trace:sca:rewrite:failed')
    const rewriter = createRewriter([
      entry('declared', { functionName: 'declared' }),
      entry('missing', { functionName: 'missing' }),
      // The class matches, but the method is not defined in its body.
      entry('undefined-method', { className: 'Derived', methodName: 'undefinedMethod' }),
    ])
    const entries = record('orchestrion:test-sca:declared')

    const { declared } = load(rewriter.rewrite(source, filename, 'commonjs'))
    declared('a')

    assert.deepStrictEqual(failures, [{
      moduleName: 'test-sca',
      version: '1.2.3',
      filePath: 'index.js',
      channelNames: ['missing', 'undefined-method'],
    }])
    assert.strictEqual(entries.length, 1)
  })

  it('keeps the original code and publishes every vulnerable function when the rewrite fails', () => {
    const failures = record('dd-trace:sca:rewrite:failed')
    const rewriter = createRewriter([entry('missing', { functionName: 'missing' })])

    const rewritten = rewriter.rewrite(source, filename, 'commonjs')
    const { arrow } = load(rewritten)

    assert.strictEqual(rewritten.slice(0, source.length), source)
    assert.strictEqual(arrow(2), 4)
    assert.deepStrictEqual(failures, [{
      moduleName: 'test-sca',
      version: '1.2.3',
      filePath: 'index.js',
      channelNames: ['missing'],
    }])
  })

  it('rewrites ES modules in the loader hooks, reading the configuration only for targets', () => {
    const table = [{
      module: { name: 'test-sca', versionRange: '>=1.0.0', filePath: 'index.mjs' },
      functionQuery: { functionName: 'declared' },
      channelName: 'declared',
    }]
    const targetFilename = join(packageDirectory, 'index.mjs')
    const helperFilename = resolve(__dirname, '../../../../dd-trace/src/config/helper.js')
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', `
      import assert from 'node:assert/strict'
      import { writeFileSync } from 'node:fs'
      import { createRequire } from 'node:module'
      import { join } from 'node:path'
      import { pathToFileURL } from 'node:url'

      const require = createRequire(import.meta.url)
      const tablePath = ${JSON.stringify(join(rewriterDirectory, 'sca-instrumentations.json'))}
      const helperPath = ${JSON.stringify(helperFilename)}
      require.cache[tablePath] = { id: tablePath, filename: tablePath, loaded: true, exports: ${JSON.stringify(table)} }

      const { load } = await import(${JSON.stringify(pathToFileURL(join(rewriterDirectory, 'loader.mjs')).href)})
      const nextLoad = source => () => ({ format: 'module', source })

      await load('file:///app/node_modules/example/index.mjs', { format: 'module' }, nextLoad('export {}'))
      assert.strictEqual(require.cache[helperPath], undefined)

      const { source } = await load(
        ${JSON.stringify(pathToFileURL(targetFilename).href)},
        { format: 'module' },
        nextLoad(${JSON.stringify(readFileSync(targetFilename, 'utf8'))})
      )
      const rewritten = join(${JSON.stringify(mkdtempSync(join(tmpdir(), 'dd-rewriter-sca-')))}, 'index.mjs')
      writeFileSync(rewritten, source)

      const { channel } = require('dc-polyfill')
      let entries = 0
      channel('orchestrion:test-sca:declared').subscribe(() => { entries++ })
      const { declared } = await import(pathToFileURL(rewritten).href)

      assert.strictEqual(declared(1), 1)
      assert.strictEqual(entries, 1)
    `], {
      cwd: resolve(__dirname, '../../../../..'),
      encoding: 'utf8',
      env: { ...process.env, DD_APPSEC_SCA_ENABLED: 'true' },
    })

    assert.strictEqual(result.status, 0, result.stderr)
  })

  it('lists no APM rewrite target', () => {
    for (const { module: { name, filePath } } of scaInstrumentations) {
      assert.strictEqual(getRewriteTarget(`/app/node_modules/${name}/${filePath}`), undefined, `${name}/${filePath}`)
    }
  })
})
