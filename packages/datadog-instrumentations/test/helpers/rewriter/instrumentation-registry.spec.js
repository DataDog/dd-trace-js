'use strict'

const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { runInNewContext } = require('node:vm')

const {
  getActivationSetup,
  isRewriteActivationEnabled,
  instrumentations,
  registry,
} = require('../../../src/helpers/rewriter/instrumentation-registry')

describe('instrumentation registry', () => {
  it('exposes every registry instrumentation as a rewrite target', () => {
    assert.deepStrictEqual(instrumentations, registry.flatMap(entry => entry.instrumentations))
  })

  it('activates only the explicitly listed rewrite modules', () => {
    for (const { activate, instrumentations: entryInstrumentations } of registry) {
      const modules = new Set(activate?.modules)
      for (const { module } of entryInstrumentations) {
        assert.strictEqual(isRewriteActivationEnabled(module.name), modules.has(module.name))
        assert.strictEqual(getActivationSetup(module.name), modules.has(module.name) ? activate?.setup : undefined)
      }
    }
  })

  it('returns false for unknown module names', () => {
    assert.strictEqual(isRewriteActivationEnabled('not-a-registered-module'), false)
    assert.strictEqual(getActivationSetup('not-a-registered-module'), undefined)
  })

  it('normalizes explicit activation modules without running setup', () => {
    let setupCalls = 0
    const setup = () => { setupCalls++ }
    const entries = [
      { instrumentations: [{ module: { name: 'unset' } }] },
      { activate: { modules: ['enabled'] }, instrumentations: [{ module: { name: 'enabled' } }] },
      {
        activate: { modules: ['first', 'second'], setup },
        instrumentations: [
          { module: { name: 'first' } },
          { module: { name: 'second' } },
          { module: { name: 'shared' } },
        ],
      },
    ]
    const registry = loadRegistry(entries)

    for (const name of ['unset', 'shared', 'unknown']) {
      assert.strictEqual(registry.isRewriteActivationEnabled(name), false)
      assert.strictEqual(registry.getActivationSetup(name), undefined)
    }
    assert.strictEqual(registry.isRewriteActivationEnabled('enabled'), true)
    assert.strictEqual(registry.getActivationSetup('enabled'), undefined)
    for (const name of ['first', 'second']) {
      assert.strictEqual(registry.isRewriteActivationEnabled(name), true)
      assert.strictEqual(registry.getActivationSetup(name), setup)
    }
    assert.strictEqual(setupCalls, 0)
  })

  for (const value of [null, false, true, 0, 1, '', 'true', [], Symbol('activate'), () => {}]) {
    it(`rejects invalid activation value ${String(value)} at registry load`, () => {
      assert.throws(() => loadRegistry([{ activate: value, instrumentations: [] }]), {
        name: 'TypeError',
        message: 'Instrumentation registry activate must be an object',
      })
    })
  }

  it('keeps setup functions out of rewrite targets', () => {
    const setup = () => {}
    const registry = loadRegistry([{
      activate: { modules: ['example'], setup },
      instrumentations: [{ module: { name: 'example' } }],
    }])
    const targetModule = { exports: {} }
    const source = readFileSync(require.resolve('../../../src/helpers/rewriter/targets'), 'utf8')
    runInNewContext(source, {
      module: targetModule,
      require: name => name === './targets.json' ? { 'example/index.js': 'example' } : registry,
    })
    const target = targetModule.exports.getRewriteTarget('/app/node_modules/example/index.js')

    assert.strictEqual(target.activate, true)
    assert.strictEqual(JSON.stringify(target), '{"moduleName":"example","filePath":"index.js","activate":true}')
  })
})

/**
 * @param {object[]} entries
 * @returns {typeof import('../../../src/helpers/rewriter/instrumentation-registry')}
 */
function loadRegistry (entries) {
  const source = readFileSync(require.resolve('../../../src/helpers/rewriter/instrumentation-registry'), 'utf8')
  // Substitute fixture entries without adding a production API to configure the static registry.
  const fixtureSource = source.replace(/const registry = \[[\s\S]*?\n\]/, 'const registry = entries')
  assert.notStrictEqual(fixtureSource, source)
  const module = { exports: {} }
  runInNewContext(fixtureSource, { entries, module })
  return module.exports
}
