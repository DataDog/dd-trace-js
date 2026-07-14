'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ts = require('typescript')

const packageRoot = process.argv[2]
const outputPath = process.argv[3]

if (!packageRoot || !outputPath) {
  throw new Error('usage: node 03-extract-source-docs.js <package-root> <output-json>')
}

const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
if (manifest.name !== 'genkit' || manifest.version !== '1.21.0') {
  throw new Error(`expected genkit@1.21.0, found ${manifest.name}@${manifest.version}`)
}

const sourceRoot = path.join(packageRoot, 'src')
const sourceFiles = []

function collectSourceFiles(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) collectSourceFiles(entryPath)
    if (entry.isFile() && entry.name.endsWith('.ts')) sourceFiles.push(entryPath)
  }
}

function declarationName(node, sourceFile) {
  if (node.name) return node.name.getText(sourceFile)
  if (ts.isConstructorDeclaration(node)) return 'constructor'
  return '<anonymous>'
}

function inspectFile(fileName) {
  const sourceText = fs.readFileSync(fileName, 'utf8')
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS)
  const documentation = []

  function visit(node) {
    if (node.jsDoc?.length) {
      const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile, false))
      for (const jsDoc of node.jsDoc) {
        documentation.push({
          name: declarationName(node, sourceFile),
          syntaxKind: ts.SyntaxKind[node.kind],
          line: position.line + 1,
          comment: ts.getTextOfJSDocComment(jsDoc.comment) || '',
          tags: (jsDoc.tags || []).map(tag => ({
            name: tag.tagName.text,
            comment: ts.getTextOfJSDocComment(tag.comment) || '',
            text: tag.getText(sourceFile)
          }))
        })
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return {
    file: path.relative(packageRoot, fileName),
    sha256: require('node:crypto').createHash('sha256').update(sourceText).digest('hex'),
    documentation
  }
}

collectSourceFiles(sourceRoot)
sourceFiles.sort()
const files = sourceFiles.map(inspectFile)
const output = {
  package: `${manifest.name}@${manifest.version}`,
  packageRoot,
  extraction: 'TypeScript AST node.jsDoc collection from every bundled src/**/*.ts file',
  sourceFileCount: files.length,
  sourceFilesWithDocumentation: files.filter(file => file.documentation.length).length,
  documentationBlockCount: files.reduce((total, file) => total + file.documentation.length, 0),
  files
}

fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`)
console.log(JSON.stringify({
  sourceFileCount: output.sourceFileCount,
  sourceFilesWithDocumentation: output.sourceFilesWithDocumentation,
  documentationBlockCount: output.documentationBlockCount
}, null, 2))
