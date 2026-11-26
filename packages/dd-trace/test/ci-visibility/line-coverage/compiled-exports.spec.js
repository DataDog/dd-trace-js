'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const { runCompiledTest } = require('./compiled-modules')
// Each compiler's CommonJS output for the modules in `sources`, with its source map; `options` says how it
// was compiled.
const { compilers } = require('./fixtures/compiled-exports.json')

// The lines of math.ts that calling `add` covers: its body on line 2, and the initialiser lines of the
// module, the declaration of `add` on line 1 and `answer` on line 5.
const ADD_LINES = { 'math.ts': [1, 2, 5] }

/**
 * @param {string} compiler
 * @param {Parameters<typeof runCompiledTest>[1]} options
 */
function runTest (compiler, options) {
  return runCompiledTest(compilers[compiler].modules, options)
}

describe('line coverage of exports that compilers define through getters', () => {
  // A getter that returns a binding runs each time an importer reads the export. In the source, reading an
  // export runs no code of the module, so the test that reads one gets no line of it, as if it ran no code.

  it('gives no line to a test that reads an export SWC defines with Object.defineProperty', () => {
    const lines = runTest('swc 1.15.41', {
      loadFirst: ['value.ts'],
      test: load => load('value.ts').default,
    })

    assert.deepStrictEqual(lines, {})
  })

  it('gives no line to a test that reads an export SWC defines through its _export helper', () => {
    const lines = runTest('swc 1.15.41', {
      loadFirst: ['math.ts'],
      test: load => load('math.ts').answer,
    })

    assert.deepStrictEqual(lines, {})
  })

  it('gives a function that SWC\'s _export helper returns through a getter its own lines', () => {
    const lines = runTest('swc 1.15.41', {
      loadFirst: ['math.ts'],
      test: load => load('math.ts').add(1, 2),
    })

    assert.deepStrictEqual(lines, ADD_LINES)
  })

  it('treats the functions that SWC\'s _export helper took before 1.4 as getters', () => {
    const read = runTest('swc 1.3.100', {
      loadFirst: ['math.ts'],
      test: load => load('math.ts').answer,
    })
    const called = runTest('swc 1.3.100', {
      loadFirst: ['math.ts'],
      test: load => load('math.ts').add(1, 2),
    })

    assert.deepStrictEqual(read, {})
    assert.deepStrictEqual(called, ADD_LINES)
  })

  // Babel's source map gives these getters no position, so they never had probes.
  it('gives no line of the re-exporting module for an export Babel re-exports with Object.defineProperty', () => {
    const read = runTest('babel 7.28.5', {
      loadFirst: ['index.ts'],
      test: load => load('index.ts').add,
    })
    const called = runTest('babel 7.28.5', {
      loadFirst: ['index.ts'],
      test: load => load('index.ts').add(1, 2),
    })

    assert.deepStrictEqual(read, {})
    assert.deepStrictEqual(called, ADD_LINES)
  })

  it('gives no line of the re-exporting module for an export Babel defines in its export * loop', () => {
    const read = runTest('babel 7.28.5', {
      loadFirst: ['all.ts'],
      test: load => load('all.ts').answer,
    })
    const called = runTest('babel 7.28.5', {
      loadFirst: ['all.ts'],
      test: load => load('all.ts').add(1, 2),
    })

    assert.deepStrictEqual(read, {})
    assert.deepStrictEqual(called, ADD_LINES)
  })

  it('gives no line to a test that loads a module with Babel\'s export * loop', () => {
    // The loop runs while the module loads, in a function, but no code of the source runs there.
    const lines = runTest('babel 7.28.5', {
      loadFirst: ['math.ts'],
      test: load => load('all.ts'),
    })

    assert.deepStrictEqual(lines, {})
  })

  it('keeps the line of an export * that Babel turns into a loop as an initialiser line of the module', () => {
    // reexport.ts imports `add` on line 1, declares `twice` on lines 3-5, and has `export *` on line 7. Babel
    // puts the import's require on line 1 and the loop on line 7.
    const read = runTest('babel 7.28.5', {
      loadFirst: ['reexport.ts'],
      test: load => load('reexport.ts').answer,
    })
    const called = runTest('babel 7.28.5', {
      loadFirst: ['reexport.ts'],
      test: load => load('reexport.ts').twice(2),
    })

    assert.deepStrictEqual(read, {})
    assert.deepStrictEqual(called, { 'reexport.ts': [1, 3, 4, 7], ...ADD_LINES })
  })

  it('keeps the line of an export list that SWC turns into getters as an initialiser line of the module', () => {
    // list.ts declares `base` on line 1 and `plus` on lines 3-5, and exports both on line 7, where SWC's
    // source map puts its _export call.
    const read = runTest('swc 1.15.41', {
      loadFirst: ['list.ts'],
      test: load => load('list.ts').base,
    })
    const called = runTest('swc 1.15.41', {
      loadFirst: ['list.ts'],
      test: load => load('list.ts').plus(1),
    })

    assert.deepStrictEqual(read, {})
    assert.deepStrictEqual(called, { 'list.ts': [1, 3, 4, 7] })
  })

  it('gives no line of the re-exporting module for an export TypeScript re-exports with Object.defineProperty', () => {
    const read = runTest('typescript 6.0.3', {
      loadFirst: ['index.ts'],
      test: load => load('index.ts').add,
    })
    const called = runTest('typescript 6.0.3', {
      loadFirst: ['index.ts'],
      test: load => load('index.ts').add(1, 2),
    })

    assert.deepStrictEqual(read, {})
    assert.deepStrictEqual(called, ADD_LINES)
  })

  // TypeScript's source map gives its helpers no position, so the getter __createBinding defines never had
  // probes.
  it('gives no line of the re-exporting module for an export TypeScript defines with __createBinding', () => {
    const read = runTest('typescript 6.0.3', {
      loadFirst: ['all.ts'],
      test: load => load('all.ts').answer,
    })
    const called = runTest('typescript 6.0.3', {
      loadFirst: ['all.ts'],
      test: load => load('all.ts').add(1, 2),
    })

    assert.deepStrictEqual(read, {})
    assert.deepStrictEqual(called, ADD_LINES)
  })

  it('gives no line to a test that reads an export esbuild defines through __export', () => {
    const read = runTest('esbuild 0.25.12', {
      loadFirst: ['math.ts'],
      test: load => load('math.ts').answer,
    })
    const called = runTest('esbuild 0.25.12', {
      loadFirst: ['math.ts'],
      test: load => load('math.ts').add(1, 2),
    })

    assert.deepStrictEqual(read, {})
    assert.deepStrictEqual(called, ADD_LINES)
  })

  it('keeps the lines of a getter that does more than return a binding', () => {
    const lines = runTest('swc 1.15.41', {
      loadFirst: ['value.ts'],
      test: load => load('value.ts').default,
      edit: line => line.replace('return _default;', 'return _default + 1;'),
    })

    assert.deepStrictEqual(lines, { 'value.ts': [1] })
  })

  it('counts a getter as code of the file when the code has no source map', () => {
    // Without a source map, the compiled code is the file: its getter runs on line 8.
    const lines = runTest('swc 1.15.41', {
      loadFirst: ['value.ts'],
      test: load => load('value.ts').default,
      withSourceMaps: false,
    })

    assert.deepStrictEqual(lines, { 'value.js': [1, 2, 3, 5, 6, 7, 8, 11] })
  })
})
