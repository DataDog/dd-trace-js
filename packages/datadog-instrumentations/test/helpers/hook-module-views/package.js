'use strict'

const assert = require('node:assert/strict')

const Hook = require('../../../src/helpers/hook')
const { addHook } = require('../../../src/helpers/instrument')
const shimmer = require('../../../../datadog-shimmer')

let calls = 0
let hookCalls = 0
const [kind, ...orders] = process.argv.slice(2)
const request = kind === 'esm' ? 'cookie/esm.mjs' : 'cookie'

/** @param {object} exported */
function wrap (exported) {
  hookCalls++
  if (exported?.Target) {
    shimmer.wrap(exported.Target.prototype, 'operation', original => function () {
      calls++
      return original.apply(this, arguments)
    })
  }
  if (typeof exported?.operation === 'function') {
    exported = shimmer.wrap(exported, 'operation', original => function () {
      calls++
      return original.apply(this, arguments)
    })
  }
  return exported
}

async function main () {
  const views = []
  async function load () {
    for (const order of orders) {
      views.push(order === 'cjs' ? require(request) : await import(request))
    }
  }
  if (kind === 'late') await load()
  if (kind.startsWith('registered-')) {
    const patchDefault = kind === 'registered-true' ? true : kind === 'registered-false' ? false : undefined
    addHook({ name: 'cookie', versions: ['>=0.4'], patchDefault }, wrap)
  } else if (kind !== 'native') {
    Hook(['cookie'], { internals: true }, wrap)
  }
  if (kind !== 'late') await load()
  for (const [name, expected] of [['null', null], ['undefined', undefined], ['primitive', 42]]) {
    assert.equal(require(`cookie/${name}.cjs`), expected)
    assert.equal((await import(`cookie/${name}.cjs`)).default, expected)
  }
  const counts = []
  for (const [index, view] of views.entries()) {
    const before = calls
    assert.equal(new view.Target().operation(), 'original')
    assert.equal(calls - before, kind === 'native' ? 0 : 1)
    assert.equal(view.operation(), 'original')
    assert.equal(calls - before, kind === 'native' ? 0 : 2)
    counts.push(calls - before)
    if (kind === 'esm') {
      const beforeDefault = calls
      assert.equal(new view.default.Target().operation(), 'default')
      counts.push(calls - beforeDefault)
    } else if (orders[index] === 'esm') {
      assert.equal(view.Target, view.default.Target)
      assert.equal(view.operation, view.default.operation)
      assert.equal(view.default.default.marker, 'CommonJS property')
    }
  }
  process.stdout.write(JSON.stringify({ counts, hookCalls }), () => process.exit(0))
}

main()
