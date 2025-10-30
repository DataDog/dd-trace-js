'use strict'

const { parseSync, Visitor } = require('oxc-parser')

const code = 'const url: String = /* 🤨 */ import.meta.url;'

// File extension is used to determine which dialect to parse source as.
const filename = 'test.tsx'

const result = parseSync(filename, code)
// or `await parseAsync(filename, code)`

// An array of errors, if any.
console.log(result.errors)

// AST and comments.
console.log(result.program, result.comments)

// ESM information - imports, exports, `import.meta`s.
console.log(result.module)

// Visit the AST
const visitations = []

const visitor = new Visitor({
  VariableDeclaration (decl) {
    visitations.push(`enter ${decl.kind}`)
  },
  'VariableDeclaration:exit' (decl) {
    visitations.push(`exit ${decl.kind}`)
  },
  Identifier (ident) {
    visitations.push(ident.name)
  },
})

visitor.visit(result.program)

// Logs: [ 'enter const', 'url', 'String', 'import', 'meta', 'url', 'exit const' ]
console.log(visitations)
