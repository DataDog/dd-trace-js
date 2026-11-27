'use strict'

const assert = require('node:assert/strict')
const vm = require('node:vm')

const { describe, it } = require('mocha')

const { installGlobal, instrumentSource } = require('../../../src/ci-visibility/line-coverage')

// Statements only: every probe goes before a statement.
const ADD = `function add (a, b) {
  const sum = a + b
  return sum
}`

// Probes inside expressions, a braceless branch and a shorthand property, which group what they wrap.
const SUMMARIZE = `summarize (items) {
    const total = items
      .map(item => item * 2)
      .reduce((sum, item) => sum + item, 0)
    let label
    if (total > 10)
      label = 'big'
    else
      label = 'small'
    return {
      total,
      label,
    }
  }`

const CODE = `${ADD}
module.exports = {
  add,
  ${SUMMARIZE},
}
`

/**
 * @param {string} filename
 * @returns {{ global: typeof globalThis, exports: Record<string, Function> }}
 */
function loadInstrumented (filename) {
  const instrumented = instrumentSource(CODE, filename)
  assert.notStrictEqual(instrumented, CODE)
  const context = vm.createContext({})
  const global = vm.runInContext('this', context)
  installGlobal(global)
  const module = { exports: {} }
  const runModule = vm.runInContext(`(function (module) {${instrumented}\n})`, context)
  runModule(module)
  return { global, exports: module.exports }
}

describe('line coverage function source', () => {
  it('gives the original source of a function whose probes go before its statements', () => {
    const { exports } = loadInstrumented('/repository/add.js')

    assert.strictEqual(exports.add.toString(), ADD)
    assert.strictEqual(exports.add(1, 2), 3)
  })

  it('gives source without probes that runs where the module that defined it does not exist', () => {
    const { exports } = loadInstrumented('/repository/summarize.js')

    const source = exports.summarize.toString()
    assert.doesNotMatch(source, /\$dd/)
    const copy = vm.runInContext(`({ ${source} }).summarize`, vm.createContext({}))
    assert.deepStrictEqual({ ...copy([1, 2, 3]) }, { total: 12, label: 'big' })
    assert.deepStrictEqual({ ...copy([1]) }, { total: 2, label: 'small' })
  })

  it('keeps Function.prototype.toString looking like the built-in, and replaces it once', () => {
    const { global } = loadInstrumented('/repository/native.js')
    const { toString } = global.Function.prototype

    assert.strictEqual(toString.toString(), 'function toString() { [native code] }')
    assert.strictEqual(toString.name, 'toString')
    assert.strictEqual(toString.length, 0)
    assert.throws(() => toString.call({}), { name: 'TypeError' })
    installGlobal(global)
    assert.strictEqual(global.Function.prototype.toString, toString)
  })
})
