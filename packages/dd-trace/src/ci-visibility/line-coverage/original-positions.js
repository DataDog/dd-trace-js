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

// How the children of a node are visited.
const GENERIC = 0
const NONE = 1
const FUNCTION = 2
const CLASS = 3
const PROPERTY = 4
const MEMBER = 5
const DECLARATOR = 6
const ASSIGNMENT_PATTERN = 7
const ASSIGNMENT = 8
const ARRAY_PATTERN = 9
const OBJECT_PATTERN = 10
const REST = 11
const FOR_IN_OF = 12
const CATCH = 13
const LABELED = 14
const EXPORT = 15
// TypeScript nodes whose expression is code: the type part is not.
const TYPESCRIPT_WRAPPER = 16
const TYPESCRIPT_PARAMETER_PROPERTY = 17
const TYPESCRIPT_ENUM = 18
const TYPESCRIPT_MODULE = 19
const TYPESCRIPT_MODULE_BLOCK = 20
const TYPESCRIPT_EXPORT_ASSIGNMENT = 21
const TYPESCRIPT_IMPORT_EQUALS = 22

/** @type {Map<string, number>} other TypeScript types are not code, and other types are GENERIC */
const CHILDREN = new Map([
  ['Identifier', NONE],
  ['PrivateIdentifier', NONE],
  ['FunctionDeclaration', FUNCTION],
  ['FunctionExpression', FUNCTION],
  ['ArrowFunctionExpression', FUNCTION],
  ['ClassDeclaration', CLASS],
  ['ClassExpression', CLASS],
  ['Property', PROPERTY],
  ['MemberExpression', MEMBER],
  ['VariableDeclarator', DECLARATOR],
  ['AssignmentPattern', ASSIGNMENT_PATTERN],
  ['AssignmentExpression', ASSIGNMENT],
  ['ArrayPattern', ARRAY_PATTERN],
  ['ObjectPattern', OBJECT_PATTERN],
  ['RestElement', REST],
  ['ForInStatement', FOR_IN_OF],
  ['ForOfStatement', FOR_IN_OF],
  ['CatchClause', CATCH],
  ['LabeledStatement', LABELED],
  ['BreakStatement', NONE],
  ['ContinueStatement', NONE],
  ['MetaProperty', NONE],
  ['TemplateElement', NONE],
  ['ImportDeclaration', NONE],
  ['ExportAllDeclaration', NONE],
  ['ExportNamedDeclaration', EXPORT],
  ['ExportDefaultDeclaration', EXPORT],
  ['TSAsExpression', TYPESCRIPT_WRAPPER],
  ['TSSatisfiesExpression', TYPESCRIPT_WRAPPER],
  ['TSNonNullExpression', TYPESCRIPT_WRAPPER],
  ['TSTypeAssertion', TYPESCRIPT_WRAPPER],
  ['TSInstantiationExpression', TYPESCRIPT_WRAPPER],
  ['TSParameterProperty', TYPESCRIPT_PARAMETER_PROPERTY],
  ['TSEnumDeclaration', TYPESCRIPT_ENUM],
  ['TSModuleDeclaration', TYPESCRIPT_MODULE],
  ['TSModuleBlock', TYPESCRIPT_MODULE_BLOCK],
  ['TSExportAssignment', TYPESCRIPT_EXPORT_ASSIGNMENT],
  ['TSImportEqualsDeclaration', TYPESCRIPT_IMPORT_EQUALS],
])

const SKIPPED_KEYS = new Set(['type', 'start', 'end', 'range', 'loc'])

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
  let isSorted = true
  collectPositions(program, (offset, isInitialiser) => {
    if (isSorted && offsets.length > 0 && offset < offsets.at(-1)) isSorted = false
    offsets.push(offset)
    flags.push(isInitialiser ? 1 : 0)
  })
  // Positions come mostly in source order. The sort is stable, so equal offsets keep the order they came in.
  const order = isSorted ? undefined : [...offsets.keys()].sort((a, b) => offsets[a] - offsets[b])
  // Source maps count lines by `\n` alone.
  const lineOffsets = [0]
  for (let i = source.indexOf('\n'); i !== -1; i = source.indexOf('\n', i + 1)) lineOffsets.push(i + 1)
  const lineStarts = new Int32Array(lineOffsets.length + 2)
  const entries = new Int32Array(offsets.length)
  let line = 1
  for (let i = 0; i < offsets.length; i++) {
    const index = order === undefined ? i : order[i]
    const offset = offsets[index]
    while (line < lineOffsets.length && lineOffsets[line] <= offset) lineStarts[++line] = i
    entries[i] = (offset - lineOffsets[line - 1]) * 2 + flags[index]
  }
  while (line < lineStarts.length - 1) lineStarts[++line] = offsets.length
  return { lineStarts, entries }
}

/**
 * @typedef {object} NodeKind what visiting a node of one type does
 * @property {number} children how its children are visited
 * @property {number} recordedRoles bit `1 << role` is set for each role in which its start is recorded
 * @property {boolean} canDeclare whether it has a `declare` field
 * @property {boolean} canBeType whether it has an `importKind` or `exportKind` field
 * @property {string[]} keys the fields that can hold a node, for GENERIC children
 */

/**
 * A program gives every node of a type the same fields, apart from fields that never hold a node, such
 * as a literal's `regex`: the first node of a type describes them all.
 *
 * @param {object} node
 * @returns {NodeKind}
 */
function createNodeKind (node) {
  const type = node.type
  const isTypeScript = type.startsWith('TS')
  const isIdentifier = type === 'Identifier' || type === 'PrivateIdentifier'
  const children = CHILDREN.get(type) ?? (isTypeScript ? NONE : GENERIC)
  let recordedRoles = 0
  if (isIdentifier) {
    recordedRoles = 1 << EXPRESSION
  } else if (!isTypeScript && (isStatement(type) || EXPRESSIONS.has(type))) {
    recordedRoles = (1 << EXPRESSION) | (1 << PATTERN)
  }
  const fields = Object.keys(node)
  /** @type {string[]} */
  const keys = []
  if (children === GENERIC) {
    for (const key of fields) {
      if (SKIPPED_KEYS.has(key)) continue
      // A field that holds a string, a number or a boolean holds one in every node of the type.
      const value = node[key]
      const isPrimitive = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
      if (!isPrimitive) keys.push(key)
    }
  }
  return {
    children,
    recordedRoles,
    canDeclare: fields.includes('declare'),
    canBeType: !isTypeScript && !isIdentifier && (fields.includes('importKind') || fields.includes('exportKind')),
    keys,
  }
}

/**
 * Calls `record` with the offset of each executable position of `program`, and whether it is
 * initialiser code, as the accuracy checker's definition counts them.
 *
 * @param {object} program
 * @param {(offset: number, isInitialiser: boolean) => void} record
 */
function collectPositions (program, record) {
  /** @type {Map<string, NodeKind>} */
  const kinds = new Map()

  /**
   * @param {object | null | undefined} node
   * @param {number} role
   * @param {boolean} isInitialiser
   */
  const visit = (node, role, isInitialiser) => {
    if (!node) return
    const type = node.type
    if (typeof type !== 'string') return
    let kind = kinds.get(type)
    if (kind === undefined) {
      kind = createNodeKind(node)
      kinds.set(type, kind)
    }
    if (kind.canDeclare && node.declare === true) return
    if (kind.canBeType && (node.importKind === 'type' || node.exportKind === 'type')) return
    if ((kind.recordedRoles >> role) & 1) record(node.start, isInitialiser)
    switch (kind.children) {
      case GENERIC:
        for (const key of kind.keys) {
          const value = node[key]
          if (Array.isArray(value)) {
            for (const child of value) visit(child, EXPRESSION, isInitialiser)
          } else if (value !== null && typeof value === 'object') {
            visit(value, EXPRESSION, isInitialiser)
          }
        }
        return
      case FUNCTION:
        for (const parameter of node.params) visit(parameter, PATTERN, false)
        visit(node.body, EXPRESSION, false)
        return
      case CLASS:
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
      case PROPERTY:
        visit(node.key, node.computed ? EXPRESSION : NAME, isInitialiser)
        visit(node.value, role === PATTERN ? PATTERN : EXPRESSION, isInitialiser)
        return
      case MEMBER:
        visit(node.object, EXPRESSION, isInitialiser)
        visit(node.property, EXPRESSION, isInitialiser)
        return
      case DECLARATOR:
        visit(node.id, PATTERN, isInitialiser)
        visit(node.init, EXPRESSION, isInitialiser)
        return
      case ASSIGNMENT_PATTERN:
        visit(node.left, PATTERN, isInitialiser)
        visit(node.right, EXPRESSION, isInitialiser)
        return
      case ASSIGNMENT:
        visit(node.left, node.left.type === 'MemberExpression' ? EXPRESSION : PATTERN, isInitialiser)
        visit(node.right, EXPRESSION, isInitialiser)
        return
      case ARRAY_PATTERN:
        for (const element of node.elements) visit(element, PATTERN, isInitialiser)
        return
      case OBJECT_PATTERN:
        for (const property of node.properties) visit(property, PATTERN, isInitialiser)
        return
      case REST:
        visit(node.argument, PATTERN, isInitialiser)
        return
      case FOR_IN_OF:
        visit(node.left, node.left.type === 'VariableDeclaration' ? EXPRESSION : PATTERN, isInitialiser)
        visit(node.right, EXPRESSION, isInitialiser)
        visit(node.body, EXPRESSION, isInitialiser)
        return
      case CATCH:
        visit(node.param, PATTERN, isInitialiser)
        visit(node.body, EXPRESSION, isInitialiser)
        return
      case LABELED:
        visit(node.body, EXPRESSION, isInitialiser)
        return
      case EXPORT:
        visit(node.declaration, EXPRESSION, isInitialiser)
        return
      case TYPESCRIPT_WRAPPER:
        visit(node.expression, role, isInitialiser)
        return
      case TYPESCRIPT_PARAMETER_PROPERTY:
        visit(node.parameter, role, isInitialiser)
        return
      case TYPESCRIPT_ENUM: {
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
      case TYPESCRIPT_MODULE:
        record(node.start, isInitialiser)
        visit(node.body, EXPRESSION, isInitialiser)
        return
      case TYPESCRIPT_MODULE_BLOCK:
        for (const statement of node.body) visit(statement, EXPRESSION, isInitialiser)
        return
      case TYPESCRIPT_EXPORT_ASSIGNMENT:
        record(node.start, isInitialiser)
        visit(node.expression, EXPRESSION, isInitialiser)
        return
      case TYPESCRIPT_IMPORT_EQUALS:
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
