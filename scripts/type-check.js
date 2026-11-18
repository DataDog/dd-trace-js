#!/usr/bin/env node

'use strict'

// Reports type errors only in the files a tsconfig's `include` selects. With `checkJs`, `tsc -p` also checks every
// JavaScript file those files import, so a config scoped to one area would fail on errors outside it.

const path = require('node:path')

const ts = require('typescript')

const [configArgument] = process.argv.slice(2)

if (configArgument === undefined) {
  // eslint-disable-next-line no-console
  console.error('Usage: node scripts/type-check.js <tsconfig>')
  process.exit(2)
}

const configPath = path.resolve(configArgument)
const { config, error } = ts.readConfigFile(configPath, ts.sys.readFile)
/** @type {import('typescript').Diagnostic[]} */
const diagnostics = []

if (error === undefined) {
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, path.dirname(configPath), undefined, configPath)
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
    configFileParsingDiagnostics: parsed.errors,
  })

  diagnostics.push(
    ...program.getConfigFileParsingDiagnostics(),
    ...program.getOptionsDiagnostics(),
    ...program.getGlobalDiagnostics()
  )

  for (const fileName of parsed.fileNames) {
    const sourceFile = program.getSourceFile(fileName)
    // Without a source file, both calls below would return diagnostics for every file in the program.
    if (sourceFile === undefined) continue
    diagnostics.push(...program.getSyntacticDiagnostics(sourceFile), ...program.getSemanticDiagnostics(sourceFile))
  }
} else {
  diagnostics.push(error)
}

/** @type {import('typescript').FormatDiagnosticsHost} */
const formatHost = {
  getCanonicalFileName: fileName => fileName,
  getCurrentDirectory: ts.sys.getCurrentDirectory,
  getNewLine: () => ts.sys.newLine,
}
const format = process.stdout.isTTY ? ts.formatDiagnosticsWithColorAndContext : ts.formatDiagnostics

process.stdout.write(format(diagnostics, formatHost))

if (diagnostics.length > 0) {
  process.stdout.write(`\nFound ${diagnostics.length} type error(s).\n`)
  process.exitCode = 1
}
