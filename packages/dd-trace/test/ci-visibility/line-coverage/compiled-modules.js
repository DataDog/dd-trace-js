'use strict'

const vm = require('node:vm')

const { instrumentSource } = require('../../../src/ci-visibility/line-coverage')
const { LineCoverageCollector, LineSet } = require('../../../src/ci-visibility/line-coverage/collector')

const SOURCE_DIRECTORY = '/repository/src'
const OUTPUT_DIRECTORY = '/repository/dist'

/**
 * Loads a compiler's CommonJS output in a context of its own, then runs `test` in the window of one test.
 *
 * @param {Record<string, { code: string[], map: object }>} modules the output and source map of each module,
 *   by the name of its source
 * @param {object} options
 * @param {string[]} options.loadFirst modules to load before the test starts
 * @param {(load: (name: string) => Record<string, Function | number>) => void} options.test
 * @param {boolean} [options.withSourceMaps] whether the code comes with its source map; without one, the
 *   code stands for a file of its own
 * @param {string} [options.directory] the directory of the sources
 * @param {(line: string) => string} [options.edit] changes each line of the code before it loads
 * @param {(map: object) => object} [options.editMap] changes the source map before the code loads
 * @returns {Record<string, number[]>} the lines the test got, by file name
 */
function runCompiledTest (modules, {
  loadFirst,
  test,
  withSourceMaps = true,
  directory = withSourceMaps ? SOURCE_DIRECTORY : OUTPUT_DIRECTORY,
  edit = line => line,
  editMap = map => map,
}) {
  const collector = new LineCoverageCollector()
  const context = vm.createContext({})
  collector.install(vm.runInContext('this', context))
  const loaded = new Map()
  const load = name => {
    let module = loaded.get(name)
    if (module === undefined) {
      const { code, map } = modules[name]
      const filename = `${directory}/${withSourceMaps ? name : name.replace(/\.ts$/, '.js')}`
      const instrumented = instrumentSource(code.map(edit).join('\n'), filename, {
        sourceMap: withSourceMaps ? editMap(map) : undefined,
      })
      module = { exports: {} }
      loaded.set(name, module)
      const evaluate = vm.runInContext(`(function (exports, require, module) {${instrumented}\n})`, context)
      evaluate(module.exports, request => load(`${request.slice(2)}.ts`), module)
    }
    return module.exports
  }
  for (const name of loadFirst) load(name)

  const owner = collector.createOwner()
  collector.resolveOwner = () => owner
  collector.boundary()
  test(load)
  collector.boundary()

  const lineSet = new LineSet()
  collector.takeLines(owner, lineSet)
  const lines = {}
  for (const [file, bitmap] of lineSet.bitmaps) {
    const fileLines = []
    for (let line = 0; line < bitmap.length * 8; line++) {
      if (bitmap[line >> 3] & (1 << (line & 7))) fileLines.push(line)
    }
    lines[collector.filename(file).slice(directory.length + 1)] = fileLines
  }
  return lines
}

module.exports = { runCompiledTest }
