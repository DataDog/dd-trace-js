'use strict'

const childProcess = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const ts = require('typescript')

const packageRoot = process.argv[2]
const outputPath = process.argv[3]

if (!packageRoot || !outputPath) {
  throw new Error('usage: node 02-inventory-exports.js <package-root> <output-json>')
}

const manifestPath = path.join(packageRoot, 'package.json')
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))

if (manifest.name !== 'genkit' || manifest.version !== '1.21.0') {
  throw new Error(`expected genkit@1.21.0, found ${manifest.name}@${manifest.version}`)
}

const entryPoints = Object.entries(manifest.exports).map(([subpath, conditions]) => ({
  subpath,
  types: path.resolve(packageRoot, conditions.types),
  require: path.resolve(packageRoot, conditions.require),
  import: path.resolve(packageRoot, conditions.import)
}))

const program = ts.createProgram({
  rootNames: entryPoints.map(({ types }) => types),
  options: {
    module: ts.ModuleKind.Node16,
    moduleResolution: ts.ModuleResolutionKind.Node16,
    target: ts.ScriptTarget.ES2022,
    skipLibCheck: true,
    noEmit: true
  }
})
const checker = program.getTypeChecker()

function unique(values) {
  return [...new Set(values)]
}

function relativeSource(fileName) {
  const nodeModules = `${path.sep}node_modules${path.sep}`
  const markerIndex = fileName.lastIndexOf(nodeModules)
  return markerIndex === -1 ? fileName : fileName.slice(markerIndex + nodeModules.length)
}

function declarationLocation(declaration) {
  const sourceFile = declaration.getSourceFile()
  const position = sourceFile.getLineAndCharacterOfPosition(declaration.getStart(sourceFile, false))
  return {
    file: relativeSource(sourceFile.fileName),
    line: position.line + 1,
    character: position.character + 1
  }
}

function symbolKind(symbol) {
  const { flags } = symbol
  const kinds = []
  const candidates = [
    ['function', ts.SymbolFlags.Function],
    ['class', ts.SymbolFlags.Class],
    ['interface', ts.SymbolFlags.Interface],
    ['typeAlias', ts.SymbolFlags.TypeAlias],
    ['enum', ts.SymbolFlags.Enum],
    ['variable', ts.SymbolFlags.Variable],
    ['namespace', ts.SymbolFlags.NamespaceModule],
    ['method', ts.SymbolFlags.Method],
    ['property', ts.SymbolFlags.Property],
    ['alias', ts.SymbolFlags.Alias]
  ]

  for (const [name, flag] of candidates) {
    if (flags & flag) kinds.push(name)
  }

  return kinds.length ? kinds : ['other']
}

function signatureText(signature, declaration) {
  return checker.signatureToString(
    signature,
    declaration,
    ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope
  )
}

function signaturesForType(type, declaration, kind) {
  const signatureKind = kind === 'construct' ? ts.SignatureKind.Construct : ts.SignatureKind.Call
  return unique(checker.getSignaturesOfType(type, signatureKind).map(signature => signatureText(signature, declaration)))
}

function memberName(member) {
  if (!member.name) return ts.SyntaxKind[member.kind]
  return member.name.getText(member.getSourceFile())
}

function memberKind(member) {
  if (ts.isConstructorDeclaration(member)) return 'constructor'
  if (ts.isMethodDeclaration(member) || ts.isMethodSignature(member)) return 'method'
  if (ts.isPropertyDeclaration(member) || ts.isPropertySignature(member)) return 'property'
  if (ts.isGetAccessorDeclaration(member)) return 'getter'
  if (ts.isSetAccessorDeclaration(member)) return 'setter'
  if (ts.isCallSignatureDeclaration(member)) return 'callSignature'
  if (ts.isConstructSignatureDeclaration(member)) return 'constructSignature'
  if (ts.isIndexSignatureDeclaration(member)) return 'indexSignature'
  return ts.SyntaxKind[member.kind]
}

function inspectMember(member) {
  const signature = ts.isFunctionLike(member) ? checker.getSignatureFromDeclaration(member) : undefined
  let callSignatures = signature ? [signatureText(signature, member)] : []

  if (!signature && member.name) {
    const memberSymbol = checker.getSymbolAtLocation(member.name)
    if (memberSymbol) {
      const memberType = checker.getTypeOfSymbolAtLocation(memberSymbol, member)
      callSignatures = signaturesForType(memberType, member, 'call')
    }
  }

  return {
    name: memberName(member),
    kind: memberKind(member),
    static: Boolean(member.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword)),
    optional: Boolean(member.questionToken),
    callSignatures,
    declaration: declarationLocation(member)
  }
}

function declaredMembers(symbol) {
  const members = []

  for (const declaration of symbol.declarations || []) {
    if (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration) ||
        ts.isInterfaceDeclaration(declaration) || ts.isTypeLiteralNode(declaration)) {
      for (const member of declaration.members) members.push(inspectMember(member))
    }
  }

  return members
}

function inspectExport(exportSymbol) {
  let target = exportSymbol
  let aliasResolutionError

  if (exportSymbol.flags & ts.SymbolFlags.Alias) {
    try {
      target = checker.getAliasedSymbol(exportSymbol)
    } catch (error) {
      aliasResolutionError = error.message
    }
  }

  const declaration = target.valueDeclaration || target.declarations?.[0] || exportSymbol.declarations?.[0]
  let valueCallSignatures = []
  let valueConstructSignatures = []
  let typeCallSignatures = []

  if (declaration && target.flags & ts.SymbolFlags.Value) {
    const valueType = checker.getTypeOfSymbolAtLocation(target, declaration)
    valueCallSignatures = signaturesForType(valueType, declaration, 'call')
    valueConstructSignatures = signaturesForType(valueType, declaration, 'construct')
  }

  if (declaration && target.flags & ts.SymbolFlags.Type) {
    try {
      const declaredType = checker.getDeclaredTypeOfSymbol(target)
      typeCallSignatures = signaturesForType(declaredType, declaration, 'call')
    } catch (error) {
      typeCallSignatures = [`<unresolved: ${error.message}>`]
    }
  }

  return {
    name: exportSymbol.getName(),
    targetName: target.getName(),
    kinds: symbolKind(target),
    valueExport: Boolean(target.flags & ts.SymbolFlags.Value),
    typeExport: Boolean(target.flags & ts.SymbolFlags.Type),
    valueCallSignatures,
    valueConstructSignatures,
    typeCallSignatures,
    declaredMembers: declaredMembers(target),
    declarations: (target.declarations || []).map(declarationLocation),
    ...(aliasResolutionError ? { aliasResolutionError } : {})
  }
}

function staticRuntimeSurface(fileName) {
  const sourceText = fs.readFileSync(fileName, 'utf8')
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS)
  const explicitExports = new Set()
  const reExportSources = new Set()
  const computedExportWrites = []

  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === '__export') {
      const exportMap = node.arguments[1]
      if (exportMap && ts.isObjectLiteralExpression(exportMap)) {
        for (const property of exportMap.properties) {
          if (property.name) explicitExports.add(property.name.getText(sourceFile).replace(/^['"]|['"]$/g, ''))
        }
      } else {
        computedExportWrites.push({ kind: '__export-non-literal', text: node.getText(sourceFile) })
      }
    }

    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === '__reExport') {
      const requireCall = node.arguments[1]
      if (requireCall && ts.isCallExpression(requireCall) && requireCall.expression.getText(sourceFile) === 'require' &&
          requireCall.arguments[0] && ts.isStringLiteral(requireCall.arguments[0])) {
        reExportSources.add(requireCall.arguments[0].text)
      } else {
        computedExportWrites.push({ kind: '__reExport-dynamic-source', text: node.getText(sourceFile) })
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)

  return {
    file: relativeSource(fileName),
    explicitExports: [...explicitExports].sort(),
    reExportSources: [...reExportSources].sort(),
    computedExportWrites
  }
}

function runtimeValidation(fileName) {
  const expression = 'const value=require(process.argv[1]); process.stdout.write(JSON.stringify(Object.keys(value).sort()))'
  const result = childProcess.spawnSync(process.execPath, ['-e', expression, fileName], {
    encoding: 'utf8',
    timeout: 10000
  })

  if (result.status !== 0) {
    return {
      status: result.status,
      signal: result.signal,
      error: result.error?.message,
      stderr: result.stderr.trim()
    }
  }

  return { status: 0, exports: JSON.parse(result.stdout) }
}

const inventory = entryPoints.map(entryPoint => {
  const sourceFile = program.getSourceFile(entryPoint.types)
  if (!sourceFile) throw new Error(`TypeScript did not load ${entryPoint.types}`)
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile)
  if (!moduleSymbol) throw new Error(`TypeScript found no module symbol for ${entryPoint.types}`)

  const exports = checker.getExportsOfModule(moduleSymbol)
    .map(inspectExport)
    .sort((left, right) => left.name.localeCompare(right.name))
  const staticRuntime = staticRuntimeSurface(entryPoint.require)
  const runtime = runtimeValidation(entryPoint.require)
  const declaredValueNames = exports.filter(item => item.valueExport).map(item => item.name).sort()
  const runtimeNames = runtime.exports || []

  return {
    subpath: entryPoint.subpath,
    files: {
      types: relativeSource(entryPoint.types),
      require: relativeSource(entryPoint.require),
      import: relativeSource(entryPoint.import)
    },
    exports,
    staticRuntime,
    runtimeValidation: runtime,
    validation: {
      declarationExportCount: exports.length,
      declarationValueExportCount: declaredValueNames.length,
      declarationTypeOnlyExportCount: exports.length - declaredValueNames.length,
      runtimeExportCount: runtimeNames.length,
      valuesMissingAtRuntime: declaredValueNames.filter(name => !runtimeNames.includes(name)),
      runtimeValuesMissingFromDeclarations: runtimeNames.filter(name => !declaredValueNames.includes(name))
    }
  }
})

const allExports = inventory.flatMap(entryPoint => entryPoint.exports)
const allMembers = allExports.flatMap(item => item.declaredMembers)
const diagnostics = ts.getPreEmitDiagnostics(program).map(diagnostic => {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
  if (!diagnostic.file || diagnostic.start === undefined) return { message }
  const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
  return {
    message,
    file: relativeSource(diagnostic.file.fileName),
    line: position.line + 1,
    character: position.character + 1,
    code: diagnostic.code,
    category: ts.DiagnosticCategory[diagnostic.category]
  }
})

const output = {
  generatedAt: new Date().toISOString(),
  analyzer: {
    script: '.dd-apm-evidence/genkit/02-inventory-exports.js',
    typescriptVersion: ts.version,
    method: 'TypeScript compiler API over every package.json exports[*].types entry; esbuild CJS export AST scan',
    runtimeCrossCheck: 'Each package.json exports[*].require entry loaded in an isolated child process; Object.keys compared'
  },
  package: {
    name: manifest.name,
    version: manifest.version,
    root: packageRoot,
    manifest: manifestPath
  },
  summary: {
    entryPointCount: inventory.length,
    exportOccurrences: allExports.length,
    uniqueExportNames: new Set(allExports.map(item => item.name)).size,
    valueExportOccurrences: allExports.filter(item => item.valueExport).length,
    typeOnlyExportOccurrences: allExports.filter(item => !item.valueExport).length,
    callableValueExportOccurrences: allExports.filter(item => item.valueCallSignatures.length > 0).length,
    classExportOccurrences: allExports.filter(item => item.kinds.includes('class')).length,
    interfaceExportOccurrences: allExports.filter(item => item.kinds.includes('interface')).length,
    declaredMemberOccurrences: allMembers.length,
    declaredMethodOccurrences: allMembers.filter(item => item.kind === 'method').length,
    staticRuntimeExplicitExportOccurrences: inventory.reduce((total, item) => {
      return total + item.staticRuntime.explicitExports.length
    }, 0),
    dynamicReExportOccurrences: inventory.reduce((total, item) => {
      return total + item.staticRuntime.reExportSources.length
    }, 0),
    diagnosticCount: diagnostics.length,
    runtimeValidationFailures: inventory.filter(item => item.runtimeValidation.status !== 0).length,
    runtimeDeclarationMismatchEntryPoints: inventory.filter(item => {
      return item.validation.valuesMissingAtRuntime.length || item.validation.runtimeValuesMissingFromDeclarations.length
    }).length
  },
  limitations: [
    'The primary inventory is static and follows public TypeScript declaration re-exports into installed dependencies.',
    'Declared members include members written directly on exported class/interface declarations; inherited members are not duplicated.',
    'Computed object properties reachable through exported values are not recursively expanded.',
    'CJS __reExport calls are dynamic at runtime; their sources are listed and resolved through TypeScript declarations.',
    'Runtime Object.keys checks validate value names only and intentionally do not replace the static inventory.'
  ],
  diagnostics,
  entryPoints: inventory
}

fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`)

function tsvCell(value) {
  return String(value).replaceAll('\t', ' ').replaceAll('\r', ' ').replaceAll('\n', ' ')
}

const exportRows = [['subpath', 'name', 'kinds', 'value_export', 'type_export', 'value_call_signature_count',
  'type_call_signature_count', 'constructor_signature_count', 'direct_member_count', 'declaration_files']]
const methodRows = [['subpath', 'export_name', 'member_name', 'member_kind', 'static', 'optional', 'signatures',
  'declaration']]

for (const entryPoint of inventory) {
  for (const item of entryPoint.exports) {
    exportRows.push([
      entryPoint.subpath,
      item.name,
      item.kinds.join(','),
      item.valueExport,
      item.typeExport,
      item.valueCallSignatures.length,
      item.typeCallSignatures.length,
      item.valueConstructSignatures.length,
      item.declaredMembers.length,
      unique(item.declarations.map(declaration => declaration.file)).join(',')
    ])

    for (const member of item.declaredMembers) {
      methodRows.push([
        entryPoint.subpath,
        item.name,
        member.name,
        member.kind,
        member.static,
        member.optional,
        member.callSignatures.join(' | '),
        `${member.declaration.file}:${member.declaration.line}:${member.declaration.character}`
      ])
    }
  }
}

const outputStem = outputPath.replace(/\.json$/, '')
fs.writeFileSync(`${outputStem}.tsv`, `${exportRows.map(row => row.map(tsvCell).join('\t')).join('\n')}\n`)
fs.writeFileSync(`${outputStem}-members.tsv`, `${methodRows.map(row => row.map(tsvCell).join('\t')).join('\n')}\n`)
console.log(JSON.stringify(output.summary, null, 2))
