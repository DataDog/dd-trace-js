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

  it('does not expand activation when a shared rewrite descriptor is added', () => {
    const setup = () => {}
    for (const activate of [{ modules: ['entry'] }, { modules: ['entry'], setup }]) {
      const entry = { activate, instrumentations: [{ module: { name: 'entry' } }] }
      const before = loadRegistry([entry])
      entry.instrumentations.push({ module: { name: 'shared' } })
      const after = loadRegistry([entry])

      assert.strictEqual(before.isRewriteActivationEnabled('entry'), true)
      assert.strictEqual(after.isRewriteActivationEnabled('entry'), true)
      assert.strictEqual(after.getActivationSetup('entry'), before.getActivationSetup('entry'))
      assert.strictEqual(after.isRewriteActivationEnabled('shared'), false)
      assert.strictEqual(after.getActivationSetup('shared'), undefined)
      assert.strictEqual(after.instrumentations.length, 2)
    }
  })

  it('allows multiple rewrite descriptors for the same activation module', () => {
    const setup = () => {}
    const registry = loadRegistry([{
      activate: { modules: ['entry'], setup },
      instrumentations: [
        { module: { name: 'entry', filePath: 'index.js' } },
        { module: { name: 'entry', filePath: 'index.mjs' } },
      ],
    }])

    assert.strictEqual(registry.isRewriteActivationEnabled('entry'), true)
    assert.strictEqual(registry.getActivationSetup('entry'), setup)
    assert.strictEqual(registry.instrumentations.length, 2)
  })

  for (const value of [null, false, true, 0, 1, '', 'true', [], Symbol('activate'), () => {}]) {
    it(`rejects invalid activation value ${String(value)} at registry load`, () => {
      assert.throws(() => loadRegistry([{ activate: value, instrumentations: [] }]), {
        name: 'TypeError',
        message: 'Instrumentation registry activate must be an object',
      })
    })
  }

  for (const modules of [undefined, null, true, 'entry', {}, []]) {
    it(`rejects invalid activation modules ${String(modules)}`, () => {
      assert.throws(() => loadRegistry([{
        activate: { modules },
        instrumentations: [{ module: { name: 'entry' } }],
      }]), {
        name: 'TypeError',
        message: 'Instrumentation registry activate.modules must be a non-empty array',
      })
    })
  }

  for (const name of [undefined, null, 0, '', {}, [], Symbol('module')]) {
    it(`rejects invalid activation module name ${String(name)}`, () => {
      assert.throws(() => loadRegistry([{
        activate: { modules: [name] },
        instrumentations: [{ module: { name: 'entry' } }],
      }]), {
        name: 'TypeError',
        message: 'Instrumentation registry activate.modules must contain non-empty strings',
      })
    })
  }

  for (const setup of [null, true, false, 0, 'setup', {}, []]) {
    it(`rejects invalid activation setup ${String(setup)}`, () => {
      assert.throws(() => loadRegistry([{
        activate: { modules: ['entry'], setup },
        instrumentations: [{ module: { name: 'entry' } }],
      }]), {
        name: 'TypeError',
        message: 'Instrumentation registry activate.setup must be a function',
      })
    })
  }

  it('rejects activation modules without rewrite descriptors in their entry', () => {
    assert.throws(() => loadRegistry([{
      activate: { modules: ['unknown'] },
      instrumentations: [{ module: { name: 'entry' } }],
    }]), {
      name: 'TypeError',
      message: 'Instrumentation registry activation module "unknown" is not a rewrite target in its entry',
    })
  })

  it('does not resolve activation modules against another registry entry', () => {
    assert.throws(() => loadRegistry([
      { activate: { modules: ['other'] }, instrumentations: [{ module: { name: 'entry' } }] },
      { instrumentations: [{ module: { name: 'other' } }] },
    ]), {
      name: 'TypeError',
      message: 'Instrumentation registry activation module "other" is not a rewrite target in its entry',
    })
  })

  it('rejects duplicate activation module names within an entry', () => {
    assert.throws(() => loadRegistry([{
      activate: { modules: ['entry', 'entry'] },
      instrumentations: [{ module: { name: 'entry' } }],
    }]), {
      name: 'TypeError',
      message: 'Instrumentation registry activation module "entry" is duplicated in its entry',
    })
  })

  for (const [firstSetup, secondSetup] of [[undefined, () => {}], [() => {}, undefined], [() => {}, () => {}]]) {
    it(`rejects conflicting setup functions from ${typeof firstSetup} to ${typeof secondSetup}`, () => {
      assert.throws(() => loadRegistry([
        {
          activate: { modules: ['entry'], setup: firstSetup },
          instrumentations: [{ module: { name: 'entry' } }],
        },
        {
          activate: { modules: ['entry'], setup: secondSetup },
          instrumentations: [{ module: { name: 'entry' } }],
        },
      ]), {
        name: 'TypeError',
        message: 'Instrumentation registry activation module "entry" has conflicting setup functions',
      })
    })
  }

  it('allows the same activation setup across entries for one module', () => {
    const setup = () => {}
    const registry = loadRegistry([
      { activate: { modules: ['entry'], setup }, instrumentations: [{ module: { name: 'entry' } }] },
      { activate: { modules: ['entry'], setup }, instrumentations: [{ module: { name: 'entry' } }] },
    ])

    assert.strictEqual(registry.isRewriteActivationEnabled('entry'), true)
    assert.strictEqual(registry.getActivationSetup('entry'), setup)
  })

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
