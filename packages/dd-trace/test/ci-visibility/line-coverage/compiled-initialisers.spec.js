'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { describe, it } = require('mocha')

const { runCompiledTest } = require('./compiled-modules')
// Each compiler's CommonJS output for the modules in `sources`, with its source map and the sources' text;
// `options` says how it was compiled.
const { compilers, sources } = require('./fixtures/compiled-initialisers.json')

/**
 * @param {string} compiler
 * @param {Parameters<typeof runCompiledTest>[1]} options
 */
function runTest (compiler, options) {
  return runCompiledTest(compilers[compiler].modules, options)
}

/**
 * @param {{ Shape: new (size: number) => object }} shape
 */
function createShape ({ Shape }) {
  return new Shape(2)
}

describe('line coverage of compiled code that moves the source\'s top level into functions', () => {
  // Initialiser code is the module's top level in the source. TypeScript's ES5 output defines a class and an
  // enum in a function it calls at once, which says nothing about the source.

  it('keeps the declaration line of a method no test calls, of a class TypeScript defines in a function', () => {
    // shape.ts declares the class on line 1, its constructor on line 4 and `area` on line 8. Calling a method
    // would give the test its declaration line anyway: the compiled body maps there.
    const lines = runTest('typescript 6.0.3', {
      loadFirst: ['shape.ts'],
      test: load => createShape(load('shape.ts')),
    })

    assert.deepStrictEqual(lines, { 'shape.ts': [1, 4, 5, 8] })
  })

  it('keeps the member lines of an enum that TypeScript defines in a function', () => {
    // color.ts declares the enum on lines 1 to 3, the member on line 2 without an initializer, and `isRed` on
    // line 6.
    const lines = runTest('typescript 6.0.3', {
      loadFirst: ['color.ts'],
      test: load => load('color.ts').isRed(0),
    })

    assert.deepStrictEqual(lines, { 'color.ts': [1, 2, 3, 6, 7] })
  })

  it('gives the line of a one-line function to the test that calls it when SWC maps its body to its name', () => {
    const lines = runTest('swc 1.15.41', {
      loadFirst: ['noop.ts'],
      test: load => load('noop.ts').default(),
    })

    assert.deepStrictEqual(lines, { 'noop.ts': [1] })
  })

  it('reads the source from its file when the source map does not include its text', () => {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'line-coverage-')))
    try {
      fs.writeFileSync(path.join(directory, 'shape.ts'), sources['shape.ts'].join('\n') + '\n')

      const lines = runTest('typescript 6.0.3', {
        loadFirst: ['shape.ts'],
        test: load => createShape(load('shape.ts')),
        directory,
        editMap: ({ sourcesContent, ...map }) => map,
      })

      assert.deepStrictEqual(lines, { 'shape.ts': [1, 4, 5, 8] })
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it('keeps the structure of the compiled code when the source does not parse', () => {
    // In the compiled code, the declaration of `area` runs in the function that defines the class.
    const lines = runTest('typescript 6.0.3', {
      loadFirst: ['shape.ts'],
      test: load => createShape(load('shape.ts')),
      editMap: map => ({ ...map, sourcesContent: ['export class Shape {'] }),
    })

    assert.deepStrictEqual(lines, { 'shape.ts': [1, 4, 5] })
  })
})
