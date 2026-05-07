'use strict'

Object.defineProperty(exports, '__esModule', { value: true })

const ddGlobal = globalThis[Symbol.for('dd-trace')]
const visitor = ddGlobal.graphql_visitor
const printer = ddGlobal.graphql_printer
const utilities = ddGlobal.graphql_utilities

function dropUnusedDefinitions (ast, operationName) {
  const separated = utilities.separateOperations(ast)[operationName]
  if (!separated) {
    return ast
  }
  return separated
}

// One walk replaces Apollo's `hideLiterals` + `removeAliases` + `sortAST` +
// the `StringValue` pre-pass that used to live in `printWithReducedWhitespace`.
// The byte output is unchanged: hideLiterals had already collapsed every
// `StringValue.value` to '', so the original hex round-trip degenerated to
// hex('') === '' anyway.
function transformForSignature (ast) {
  return visitor.visit(ast, {
    IntValue (node) {
      return { ...node, value: '0' }
    },
    FloatValue (node) {
      return { ...node, value: '0' }
    },
    StringValue (node) {
      return { ...node, value: '', block: false }
    },
    ListValue (node) {
      return { ...node, values: [] }
    },
    ObjectValue (node) {
      return { ...node, fields: [] }
    },
    Field (node) {
      return {
        ...node,
        alias: undefined,
        arguments: sortByName(node.arguments),
      }
    },
    OperationDefinition (node) {
      return {
        ...node,
        variableDefinitions: sortByVariableName(node.variableDefinitions),
      }
    },
    SelectionSet (node) {
      return { ...node, selections: sortByKindThenName(node.selections) }
    },
    FragmentSpread (node) {
      return { ...node, directives: sortByName(node.directives) }
    },
    InlineFragment (node) {
      return { ...node, directives: sortByName(node.directives) }
    },
    FragmentDefinition (node) {
      return {
        ...node,
        directives: sortByName(node.directives),
        variableDefinitions: sortByVariableName(node.variableDefinitions),
      }
    },
    Directive (node) {
      return { ...node, arguments: sortByName(node.arguments) }
    },
  })
}

function printWithReducedWhitespace (ast) {
  return printer.print(ast)
    .replaceAll(/\s+/g, ' ')
    .replaceAll(/([^_a-zA-Z0-9]) /g, '$1')
    .replaceAll(/ ([^_a-zA-Z0-9])/g, '$1')
}

function sortByName (items) {
  if (!items) return
  return [...items].sort(byName)
}

function byName (a, b) {
  const left = a.name.value
  const right = b.name.value
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function sortByVariableName (items) {
  if (!items) return
  return [...items].sort(byVariableName)
}

function byVariableName (a, b) {
  const left = a.variable.name.value
  const right = b.variable.name.value
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

// SelectionSet children include InlineFragment, which has no `name`, so the
// secondary key falls back to undefined and stable sort keeps sibling order.
function sortByKindThenName (items) {
  return [...items].sort(byKindThenName)
}

function byKindThenName (a, b) {
  if (a.kind < b.kind) return -1
  if (a.kind > b.kind) return 1
  const left = a.name?.value
  const right = b.name?.value
  if (left === right) return 0
  if (left === undefined) return 1
  if (right === undefined) return -1
  return left < right ? -1 : 1
}

exports.dropUnusedDefinitions = dropUnusedDefinitions
exports.transformForSignature = transformForSignature
exports.printWithReducedWhitespace = printWithReducedWhitespace
