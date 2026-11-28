'use strict'

// Tells whether a position in a file that code was compiled from is initialiser code, by that file's
// own structure. A compiler can move module-scope code into a function, such as a class into a
// function that it calls at once, so the structure of the compiled code does not tell.
//
// The executable positions of a file are the starts of its statements and expressions, each
// initialiser code or not: initialiser code is the module's top level, with the headers of the
// functions and classes defined there and the static blocks and static field initialisers of those
// classes. A compiled position takes the flag of the file's position at or before its column on its
// line, or of the first position on the line. TypeScript types are not code.

// Taken before any test runs, since tests replace fs functions.
const { readFileSync } = require('node:fs')
const { extname } = require('node:path')

const EXPRESSION = 0
const PATTERN = 1
const NAME = 2

const EXPRESSIONS = new Set([
  'ThisExpression',
  'Super',
  'Literal',
  'ArrayExpression',
  'ObjectExpression',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'ClassExpression',
  'TemplateLiteral',
  'TaggedTemplateExpression',
  'MemberExpression',
  'ChainExpression',
  'CallExpression',
  'NewExpression',
  'ImportExpression',
  'UpdateExpression',
  'UnaryExpression',
  'BinaryExpression',
  'LogicalExpression',
  'ConditionalExpression',
  'AssignmentExpression',
  'SequenceExpression',
  'YieldExpression',
  'AwaitExpression',
  'JSXElement',
  'JSXFragment',
])

// TypeScript nodes whose expression is code: the type part is not.
const TYPESCRIPT_WRAPPERS = new Set([
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'TSTypeAssertion',
  'TSInstantiationExpression',
])

/**
 * @typedef {(code: string, lang: 'jsx' | 'ts' | 'tsx', sourceType: 'module' | 'commonjs') => object} ParseOriginal
 *   returns an ESTree Program with UTF-16 `start` and `end`, and throws on a syntax error
 *
 * @typedef {{ lineStarts: Int32Array, entries: Int32Array }} PositionTable the positions of line `l`
 *   are `entries[lineStarts[l]]` up to `entries[lineStarts[l + 1]]`, each `column * 2 + 1` for
 *   initialiser code and `column * 2` for other code, in column order
 */

/**
 * @param {string} filename the original file
 * @param {string | null | undefined} content its text, as the source map gives it; read from the file
 *   when not a string
 * @param {ParseOriginal} parse
 * @returns {PositionTable | null} null when the file cannot be read or does not parse
 */
function createPositionTable (filename, content, parse) {
  try {
    const source = typeof content === 'string' ? content : readFileSync(filename, 'utf8')
    const extension = extname(filename)
    let lang = 'jsx'
    if (extension === '.ts' || extension === '.mts' || extension === '.cts') lang = 'ts'
    else if (extension === '.tsx') lang = 'tsx'
    let program
    try {
      program = parse(source, lang, 'module')
    } catch {
      // A CommonJS file can return at its top level.
      program = parse(source, lang, 'commonjs')
    }
    return buildTable(source, program)
  } catch {
    return null
  }
}

/**
 * @param {PositionTable} table the positions of the original file
 * @param {number} line 1-based
 * @param {number} column 0-based
 * @param {boolean} compiledIsInitialiser whether the compiled code's structure makes it initialiser code
 * @returns {boolean | undefined} undefined when the file has no position on the line
 */
function isOriginalInitialiser ({ lineStarts, entries }, line, column, compiledIsInitialiser) {
  if (line + 1 >= lineStarts.length) return
  const first = lineStarts[line]
  const last = lineStarts[line + 1]
  if (first === last) return
  let found = first
  let next = -1
  for (let i = first; i < last; i++) {
    if (entries[i] >> 1 > column) {
      next = i
      break
    }
    found = i
  }
  const isInitialiser = (entries[found] & 1) === 1
  // A compiler can map the body of a one-line function to its name, before the body's own position
  // (`export default function noop() {}`). The compiled position is not initialiser code there, the
  // header before it is, and code that is not follows on the line: the body is meant.
  if (!compiledIsInitialiser && isInitialiser && column > entries[found] >> 1 && next !== -1 &&
    (entries[next] & 1) === 0) {
    return false
  }
  return isInitialiser
}

/**
 * @param {string} source
 * @param {object} program
 * @returns {PositionTable}
 */
function buildTable (source, program) {
  /** @type {number[]} */
  const offsets = []
  /** @type {number[]} */
  const flags = []
  collectPositions(program, (offset, isInitialiser) => {
    offsets.push(offset)
    flags.push(isInitialiser ? 1 : 0)
  })
  const order = [...offsets.keys()].sort((a, b) => offsets[a] - offsets[b])
  // Source maps count lines by `\n` alone.
  const lineOffsets = [0]
  for (let i = source.indexOf('\n'); i !== -1; i = source.indexOf('\n', i + 1)) lineOffsets.push(i + 1)
  const lineStarts = new Int32Array(lineOffsets.length + 2)
  const entries = new Int32Array(order.length)
  let line = 1
  for (let i = 0; i < order.length; i++) {
    const offset = offsets[order[i]]
    while (line < lineOffsets.length && lineOffsets[line] <= offset) lineStarts[++line] = i
    entries[i] = (offset - lineOffsets[line - 1]) * 2 + flags[order[i]]
  }
  while (line < lineStarts.length - 1) lineStarts[++line] = order.length
  return { lineStarts, entries }
}

/**
 * Calls `record` with the offset of each executable position of `program`, and whether it is
 * initialiser code, as the accuracy checker's definition counts them.
 *
 * @param {object} program
 * @param {(offset: number, isInitialiser: boolean) => void} record
 */
function collectPositions (program, record) {
  /**
   * @param {object | null | undefined} node
   * @param {number} role
   * @param {boolean} isInitialiser
   */
  const visit = (node, role, isInitialiser) => {
    if (!node || typeof node.type !== 'string' || node.declare === true) return
    const type = node.type
    if (type.startsWith('TS')) {
      visitTypeScript(node, role, isInitialiser)
      return
    }
    if (type === 'Identifier' || type === 'PrivateIdentifier') {
      if (role === EXPRESSION) record(node.start, isInitialiser)
      return
    }
    if (node.importKind === 'type' || node.exportKind === 'type') return
    if (role !== NAME && (isStatement(type) || EXPRESSIONS.has(type))) record(node.start, isInitialiser)
    switch (type) {
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        for (const parameter of node.params) visit(parameter, PATTERN, false)
        visit(node.body, EXPRESSION, false)
        return
      case 'ClassDeclaration':
      case 'ClassExpression':
        visitDecorators(node, isInitialiser)
        visit(node.superClass, EXPRESSION, isInitialiser)
        for (const element of node.body.body) {
          if (element.type === 'StaticBlock') {
            for (const statement of element.body) visit(statement, EXPRESSION, isInitialiser)
            continue
          }
          if (element.type.startsWith('TS') || element.declare === true ||
            element.value?.type === 'TSEmptyBodyFunctionExpression') {
            continue
          }
          visitDecorators(element, isInitialiser)
          visit(element.key, element.computed ? EXPRESSION : NAME, isInitialiser)
          // Instance fields run at construction.
          const isInstanceField = !element.static &&
            (element.type === 'PropertyDefinition' || element.type === 'AccessorProperty')
          visit(element.value, EXPRESSION, !isInstanceField && isInitialiser)
        }
        return
      case 'Property':
        visit(node.key, node.computed ? EXPRESSION : NAME, isInitialiser)
        visit(node.value, role === PATTERN ? PATTERN : EXPRESSION, isInitialiser)
        return
      case 'MemberExpression':
        visit(node.object, EXPRESSION, isInitialiser)
        visit(node.property, EXPRESSION, isInitialiser)
        return
      case 'VariableDeclarator':
        visit(node.id, PATTERN, isInitialiser)
        visit(node.init, EXPRESSION, isInitialiser)
        return
      case 'AssignmentPattern':
        visit(node.left, PATTERN, isInitialiser)
        visit(node.right, EXPRESSION, isInitialiser)
        return
      case 'AssignmentExpression':
        visit(node.left, node.left.type === 'MemberExpression' ? EXPRESSION : PATTERN, isInitialiser)
        visit(node.right, EXPRESSION, isInitialiser)
        return
      case 'ArrayPattern':
        for (const element of node.elements) visit(element, PATTERN, isInitialiser)
        return
      case 'ObjectPattern':
        for (const property of node.properties) visit(property, PATTERN, isInitialiser)
        return
      case 'RestElement':
        visit(node.argument, PATTERN, isInitialiser)
        return
      case 'ForInStatement':
      case 'ForOfStatement':
        visit(node.left, node.left.type === 'VariableDeclaration' ? EXPRESSION : PATTERN, isInitialiser)
        visit(node.right, EXPRESSION, isInitialiser)
        visit(node.body, EXPRESSION, isInitialiser)
        return
      case 'CatchClause':
        visit(node.param, PATTERN, isInitialiser)
        visit(node.body, EXPRESSION, isInitialiser)
        return
      case 'LabeledStatement':
        visit(node.body, EXPRESSION, isInitialiser)
        return
      case 'BreakStatement':
      case 'ContinueStatement':
      case 'MetaProperty':
      case 'TemplateElement':
      case 'ImportDeclaration':
      case 'ExportAllDeclaration':
        return
      case 'ExportNamedDeclaration':
      case 'ExportDefaultDeclaration':
        visit(node.declaration, EXPRESSION, isInitialiser)
        return
      default:
        for (const key of Object.keys(node)) {
          if (key === 'type' || key === 'start' || key === 'end' || key === 'range' || key === 'loc') continue
          const value = node[key]
          if (Array.isArray(value)) {
            for (const child of value) visit(child, EXPRESSION, isInitialiser)
          } else if (value !== null && typeof value === 'object') {
            visit(value, EXPRESSION, isInitialiser)
          }
        }
    }
  }

  /**
   * @param {object} node
   * @param {number} role
   * @param {boolean} isInitialiser
   */
  const visitTypeScript = (node, role, isInitialiser) => {
    if (TYPESCRIPT_WRAPPERS.has(node.type)) {
      visit(node.expression, role, isInitialiser)
      return
    }
    switch (node.type) {
      case 'TSParameterProperty':
        visit(node.parameter, role, isInitialiser)
        return
      case 'TSEnumDeclaration': {
        record(node.start, isInitialiser)
        const members = node.body?.members ?? node.members
        if (!Array.isArray(members)) return
        // Each member is assigned, with or without an initializer.
        for (const member of members) {
          record(member.start, isInitialiser)
          visit(member.initializer, EXPRESSION, isInitialiser)
        }
        return
      }
      case 'TSModuleDeclaration':
        record(node.start, isInitialiser)
        visit(node.body, EXPRESSION, isInitialiser)
        return
      case 'TSModuleBlock':
        for (const statement of node.body) visit(statement, EXPRESSION, isInitialiser)
        return
      case 'TSExportAssignment':
        record(node.start, isInitialiser)
        visit(node.expression, EXPRESSION, isInitialiser)
        return
      case 'TSImportEqualsDeclaration':
        if (node.importKind !== 'type') record(node.start, isInitialiser)
    }
  }

  /**
   * @param {object} node
   * @param {boolean} isInitialiser
   */
  const visitDecorators = (node, isInitialiser) => {
    if (!Array.isArray(node.decorators)) return
    for (const decorator of node.decorators) visit(decorator.expression, EXPRESSION, isInitialiser)
  }

  visit(program, EXPRESSION, true)
}

/**
 * @param {string} type
 */
function isStatement (type) {
  return (type.endsWith('Statement') || type.endsWith('Declaration')) && type !== 'Program'
}

module.exports = { createPositionTable, isOriginalInitialiser }
