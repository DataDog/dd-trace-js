'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const { describe, it, before, after } = require('mocha')

const { instrumentSource } = require('../../../src/ci-visibility/line-coverage')

const MODULES = {
  'exports.mjs': `import { increment as add } from './counter.mjs'
import * as counter from './counter.mjs'
export const arrow = () => add(1)
export const expression = function () {
  return 2
}, anonymousClass = class {}
export function declared () {
  return 'declared'
}
export class Point {
  x = 1
  static origin = new Point()
  norm () {
    return this.x
  }
}
export default () => 'default'
export { increment as renamed } from './counter.mjs'
export * from './counter.mjs'
const value = await Promise.resolve(41)
export const awaited = value +
  1
export const counterExports = Object.keys(counter)
`,
  'counter.mjs': `export let count = 0
export function increment (by) {
  count += by
  return count
}
`,
  'default-class.mjs': `export default class {
  name () {
    return 'class'
  }
}
`,
  'default-function.mjs': `export default function () {
  return 'function'
}
`,
}

/**
 * @param {string} directory
 * @returns {Promise<Record<string, Record<string, unknown>>>} what each module exports, with the name of
 *   each function
 */
async function describeModules (directory) {
  const described = {}
  for (const name of Object.keys(MODULES)) {
    const namespace = await import(pathToFileURL(path.join(directory, name)).href)
    described[name] = Object.fromEntries(Object.entries(namespace).map(([key, value]) => {
      if (typeof value === 'function') return [key, `function ${value.name}`]
      return [key, value instanceof Object && !Array.isArray(value) ? value.constructor.name : value]
    }))
  }
  return described
}

describe('line coverage of ECMAScript modules', () => {
  let directory

  before(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-line-coverage-esm-'))
    fs.mkdirSync(path.join(directory, 'original'))
    fs.mkdirSync(path.join(directory, 'instrumented'))
    for (const [name, code] of Object.entries(MODULES)) {
      fs.writeFileSync(path.join(directory, 'original', name), code)
      const filename = path.join(directory, 'instrumented', name)
      const instrumented = instrumentSource(code, filename, { isModule: true })
      assert.notStrictEqual(instrumented, code, `${name} is instrumented`)
      fs.writeFileSync(filename, instrumented)
    }
  })

  after(() => {
    fs.rmSync(directory, { recursive: true, force: true })
  })

  it('keeps the exports of instrumented modules, their values and the names of their functions', async () => {
    const original = await describeModules(path.join(directory, 'original'))
    const instrumented = await describeModules(path.join(directory, 'instrumented'))

    assert.deepStrictEqual(instrumented, original)
    assert.deepStrictEqual(instrumented['exports.mjs'].counterExports, ['count', 'increment'])
    assert.strictEqual(instrumented['exports.mjs'].default, 'function default')
    assert.strictEqual(instrumented['exports.mjs'].arrow, 'function arrow')
    assert.strictEqual(instrumented['exports.mjs'].awaited, 42)
  })
})
