'use strict'

const acorn = require('acorn')
const file = require('fs').readFileSync('./node_modules/express/lib/request.js', 'utf8')

// console.log('hello')
acorn.parse(file)

// const code = `async function test () {
//   const foo = globalThis.query()

//   return await foo
// }

// foo()`

// const ast = acorn.parse(code, { ecmaVersion: 2020 })

// console.log(ast.body)

// const before = code.slice(0, 24)
// const body = code.slice(24, 78)
// const after = code.slice(78)

// const prefix = 'const ctx = {};return tracingChannel(\'test\').tracePromise(ctx, async () => {'
// const suffix = '})'

// const patched = before + prefix + body + suffix + after

// console.log(patched)
// console.log(acorn.parse(patched))
