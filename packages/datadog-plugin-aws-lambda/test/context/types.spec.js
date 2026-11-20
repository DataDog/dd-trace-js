'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const { describe, it } = require('mocha')
const ts = require('typescript')

describe('private Lambda extractor types', () => {
  it('checks callback shapes without importing AWS or root tracer declarations', () => {
    const program = ts.createProgram([path.join(__dirname, 'types.ts')], {
      strict: true,
      noEmit: true,
      types: [],
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
    })
    const diagnostics = ts.getPreEmitDiagnostics(program)
    assert.strictEqual(diagnostics.length, 0, ts.formatDiagnostics(diagnostics, {
      getCurrentDirectory: () => __dirname,
      getCanonicalFileName: file => file,
      getNewLine: () => '\n',
    }))
    const files = program.getSourceFiles().map(file => file.fileName)
    assert.ok(files.every(file => !file.includes('/@types/aws-lambda/')))
    assert.ok(!files.includes(path.resolve(__dirname, '../../../../index.d.ts')))
  })
})
