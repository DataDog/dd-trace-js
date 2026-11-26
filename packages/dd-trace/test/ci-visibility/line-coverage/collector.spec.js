'use strict'

const assert = require('node:assert/strict')
const vm = require('node:vm')

const { describe, it } = require('mocha')

const { instrumentSource } = require('../../../src/ci-visibility/line-coverage')
const { LineCoverageCollector, LineSet } = require('../../../src/ci-visibility/line-coverage/collector')

const FILENAME = '/repository/branches.js'

// Its initialiser takes the branch that the global `branch` selects: lines 4 and 5, or 4, 6 and 7.
const SOURCE = `'use strict'

let branch
if (globalThis.branch === 'first') {
  branch = 'first'
} else {
  branch = 'second'
}

module.exports = function getBranch () {
  return branch
}
`

/**
 * @param {LineSet} lineSet
 * @param {LineCoverageCollector} collector
 * @returns {Record<string, number[]>}
 */
function toLines (lineSet, collector) {
  const lines = {}
  for (const [file, bitmap] of lineSet.bitmaps) {
    const fileLines = []
    for (let line = 0; line < bitmap.length * 8; line++) {
      if (bitmap[line >> 3] & (1 << (line & 7))) fileLines.push(line)
    }
    lines[collector.filename(file)] = fileLines
  }
  return lines
}

describe('line coverage of initialiser lines', () => {
  // A framework can run a module more than once, as Jest does once per test file, each copy with its own
  // globals. A file's initialiser lines are what it ran anywhere in the process, in any copy.
  it('credits a test with the initialiser lines its file ran in every module copy so far', () => {
    const instrumented = instrumentSource(SOURCE, FILENAME, {})
    const collector = new LineCoverageCollector()
    let owner = collector.unowned
    collector.resolveOwner = () => owner

    const loadCopy = branch => {
      const context = vm.createContext({ branch })
      collector.install(vm.runInContext('this', context))
      const module = { exports: {} }
      const evaluate = vm.runInContext(`(function (exports, require, module) {${instrumented}\n})`, context)
      evaluate(module.exports, require, module)
      collector.boundary()
      return module.exports
    }
    const runTest = getBranch => {
      const test = collector.createOwner()
      owner = test
      collector.boundary()
      getBranch()
      collector.boundary()
      owner = collector.unowned
      test.open = false
      const lines = new LineSet()
      collector.takeLines(test, lines)
      return toLines(lines, collector)
    }

    const first = loadCopy('first')
    const beforeSecondCopy = runTest(first)
    const second = loadCopy('second')
    const ofSecondCopy = runTest(second)
    const afterSecondCopy = runTest(first)

    assert.deepStrictEqual(beforeSecondCopy, { [FILENAME]: [1, 3, 4, 5, 10, 11] })
    assert.deepStrictEqual(ofSecondCopy, { [FILENAME]: [1, 3, 4, 5, 6, 7, 10, 11] })
    assert.deepStrictEqual(afterSecondCopy, { [FILENAME]: [1, 3, 4, 5, 6, 7, 10, 11] })
    assert.deepStrictEqual(toLines(collector.sharedInit, collector), { [FILENAME]: [1, 3, 4, 5, 6, 7, 10] })
  })
})
