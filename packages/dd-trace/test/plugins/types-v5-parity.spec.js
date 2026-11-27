'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { describe, it } = require('mocha')
const ts = require('typescript')

require('../setup/core')

const repoRoot = path.join(__dirname, '..', '..', '..', '..')

// Declarations that master intentionally exposes without a v5 counterpart, as dotted paths such as
// `tracer.TracerOptions.someOption`. Leave this empty for anything that is meant to be backported.
const MASTER_ONLY_DECLARATIONS = new Set()

/**
 * Collects the dotted path of every named API declaration (namespaces, interfaces, types, classes, functions,
 * variables and their members) in a declaration file. Parameters and type parameters are ignored on purpose, since
 * renaming them does not change the public surface.
 *
 * @param {string} source
 * @returns {Set<string>}
 */
function collectDeclarationPaths (source) {
  const sourceFile = ts.createSourceFile('index.d.ts', source, ts.ScriptTarget.Latest, true)
  const paths = new Set()

  /**
   * @param {import('typescript').Node} node
   * @param {string} prefix
   */
  function visit (node, prefix) {
    let next = prefix
    if (
      ts.isModuleDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) ||
      ts.isClassDeclaration(node) || ts.isEnumDeclaration(node) || ts.isFunctionDeclaration(node) ||
      ts.isVariableDeclaration(node) || ts.isPropertySignature(node) || ts.isMethodSignature(node) ||
      ts.isPropertyDeclaration(node) || ts.isMethodDeclaration(node) || ts.isEnumMember(node)
    ) {
      const name = ts.getNameOfDeclaration(node)
      if (name && (ts.isIdentifier(name) || ts.isStringLiteral(name))) {
        next = prefix ? `${prefix}.${name.text}` : name.text
        paths.add(next)
      }
    }
    ts.forEachChild(node, child => visit(child, next))
  }

  visit(sourceFile, '')
  return paths
}

/**
 * @param {string} dtsSource
 * @param {string} v5DtsSource
 * @returns {string[]}
 */
function findMissingInV5 (dtsSource, v5DtsSource) {
  const v5Paths = collectDeclarationPaths(v5DtsSource)

  return [...collectDeclarationPaths(dtsSource)]
    .filter(declaration => !v5Paths.has(declaration) && !MASTER_ONLY_DECLARATIONS.has(declaration))
}

describe('Public type declarations', () => {
  it('reports declarations that exist only in index.d.ts', () => {
    const missing = findMissingInV5(
      'declare namespace tracer { interface Options { kept?: boolean, added?: string } }',
      'declare namespace tracer { interface Options { kept?: boolean } }'
    )

    assert.deepStrictEqual(missing, ['tracer.Options.added'])
  })

  it('keeps every index.d.ts declaration in index.d.v5.ts', () => {
    const missing = findMissingInV5(
      fs.readFileSync(path.join(repoRoot, 'index.d.ts'), 'utf8'),
      fs.readFileSync(path.join(repoRoot, 'index.d.v5.ts'), 'utf8')
    )

    // The v5 release copies index.d.v5.ts over index.d.ts, so a declaration that is only in index.d.ts is missing
    // from the published v5 types.
    assert.deepStrictEqual(
      missing,
      [],
      'Declarations in index.d.ts are missing from index.d.v5.ts. Add them there too, or list them in ' +
      `MASTER_ONLY_DECLARATIONS if they must not be backported:\n${missing.join('\n')}`
    )
  })
})
