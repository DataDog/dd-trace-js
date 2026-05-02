'use strict'

Object.defineProperty(exports, '__esModule', { value: true })
const transforms = require('./transforms')

// Apollo Server / Yoga / Mercurius hand back the same parsed `DocumentNode`
// from their own document caches per execute, so memoizing the signature on
// the document keeps the visit/print pipeline off the hot path. The inner
// Map keys on operationName since `separateOperations` picks a different
// sub-document for each operation.
const cache = new WeakMap()

function defaultEngineReportingSignature (ast, operationName) {
  const key = operationName == null ? '' : operationName
  let inner = cache.get(ast)
  if (inner !== undefined) {
    const cached = inner.get(key)
    if (cached !== undefined) {
      return cached
    }
  }
  const signature = transforms.printWithReducedWhitespace(
    transforms.transformForSignature(
      transforms.dropUnusedDefinitions(ast, operationName)
    )
  )
  if (inner === undefined) {
    inner = new Map()
    cache.set(ast, inner)
  }
  inner.set(key, signature)
  return signature
}
exports.defaultEngineReportingSignature = defaultEngineReportingSignature
