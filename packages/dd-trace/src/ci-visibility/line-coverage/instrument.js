'use strict'

// Inserts per-test line probes into JavaScript source text.
//
// A line counts as executed when a statement starting on it began to run, which is Istanbul's
// line model. Every such statement gets a probe that stores 1 into a module-scope variable named
// after the line. A context-slot store needs no inline cache, so it stays cheap in the
// interpreter and the baseline compiler, where most test code runs.
//
// The first probe each function runs also checks the module's touched flag. The first check
// after a test boundary queues the module's reader with the collector, so a boundary only reads
// the modules that ran since the previous one. Async functions and generators check it on every
// probe, because they can resume after a boundary.
//
// Initialiser code (the module's top level, and the static blocks and static field initialisers of
// classes defined there) stores into a separate set of variables, which the reader reports as
// negative line numbers.
//
// Inserted text never contains a newline, so line numbers stay intact. A probe goes right after
// the previous statement when only whitespace separates the two, so most statements keep their
// columns too.

const STATEMENTS = new Set([
  'ExpressionStatement', 'BreakStatement', 'ContinueStatement', 'DebuggerStatement', 'ReturnStatement',
  'ThrowStatement', 'TryStatement', 'IfStatement', 'ForStatement', 'ForInStatement', 'ForOfStatement',
  'WhileStatement', 'DoWhileStatement', 'SwitchStatement', 'WithStatement', 'LabeledStatement',
])

const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'])

// Anonymous function and class definitions take their name from the binding they initialize, so
// their initializer cannot be wrapped in a sequence expression.
const NAMED_BY_BINDING = new Set(['FunctionExpression', 'ArrowFunctionExpression', 'ClassExpression'])

// Child keys per node type, in source order. Unknown types fall back to their own keys.
const CHILD_KEYS = {
  ArrayExpression: ['elements'],
  ArrayPattern: ['elements'],
  AssignmentExpression: ['left', 'right'],
  AssignmentPattern: ['left', 'right'],
  AwaitExpression: ['argument'],
  BinaryExpression: ['left', 'right'],
  CallExpression: ['callee', 'arguments'],
  ChainExpression: ['expression'],
  ClassBody: ['body'],
  ClassDeclaration: ['decorators', 'id', 'superClass', 'body'],
  ClassExpression: ['decorators', 'id', 'superClass', 'body'],
  ConditionalExpression: ['test', 'consequent', 'alternate'],
  Decorator: ['expression'],
  ImportExpression: ['source', 'options'],
  LogicalExpression: ['left', 'right'],
  MemberExpression: ['object', 'property'],
  MethodDefinition: ['decorators', 'key', 'value'],
  NewExpression: ['callee', 'arguments'],
  ObjectExpression: ['properties'],
  ObjectPattern: ['properties'],
  Property: ['key', 'value'],
  RestElement: ['argument'],
  SequenceExpression: ['expressions'],
  SpreadElement: ['argument'],
  TaggedTemplateExpression: ['tag', 'quasi'],
  TemplateLiteral: ['expressions'],
  UnaryExpression: ['argument'],
  UpdateExpression: ['argument'],
  VariableDeclarator: ['id', 'init'],
  YieldExpression: ['argument'],
  Identifier: [],
  Literal: [],
  ThisExpression: [],
  Super: [],
  MetaProperty: [],
  PrivateIdentifier: [],
  TemplateElement: [],
}

const SKIPPED_KEYS = new Set(['type', 'start', 'end', 'range', 'loc'])

/**
 * @typedef {object} InstrumentOptions
 * @property {(code: string, isModule: boolean) => object} parse returns an ESTree Program with UTF-16
 *   `start` and `end` offsets
 * @property {boolean} [isModule]
 * @property {number} fileIndex the collector's index for this file
 * @property {(line: number, column: number) => number} [originalLine] maps a generated position to
 *   its original line, or 0 when it has no mapping
 */

/**
 * @param {string} code
 * @param {InstrumentOptions} options
 * @returns {{ code: string, lines: number[], initLines: number[] } | undefined} undefined when there is
 *   nothing to probe
 */
function instrument (code, { parse, isModule = false, fileIndex, originalLine }) {
  const program = parse(code, isModule)
  const lineStarts = getLineStarts(code)
  const prefix = choosePrefix(code)
  const touch = `${prefix}t||${prefix}r()`

  /** @type {Array<[number, number, number, string]>} offset, order, sequence, text */
  const inserts = []
  const lineSet = new Set()
  const initLineSet = new Set()
  let sequence = 0
  let syntheticNames = 0

  // State of the function whose own body is being visited.
  let fn = { init: false, touchEveryProbe: false, touched: false }

  function lineAt (offset) {
    let lo = 0
    let hi = lineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lineStarts[mid] <= offset) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }

  function recordedLine (offset) {
    const line = lineAt(offset)
    if (!originalLine) return line
    return originalLine(line, offset - lineStarts[line - 1])
  }

  function probeText (line) {
    let store
    if (fn.init) {
      initLineSet.add(line)
      store = `${prefix}i${line}=1`
    } else {
      lineSet.add(line)
      store = `${prefix}${line}=1`
    }
    if (fn.touchEveryProbe || !fn.touched) {
      fn.touched = true
      return `${touch},${store}`
    }
    return store
  }

  function insert (offset, order, text) {
    inserts.push([offset, order, sequence++, text])
  }

  // Offset of the first character after whitespace and comments.
  function skipTrivia (offset) {
    while (offset < code.length) {
      const c = code.charCodeAt(offset)
      if (c === 32 || c === 9 || c === 10 || c === 13 || c === 0x20_28 || c === 0x20_29 || c === 0xA0 ||
        c === 0xFE_FF || c === 11 || c === 12) {
        offset++
      } else if (c === 47 && code.charCodeAt(offset + 1) === 47) {
        while (offset < code.length && !isLineBreak(code.charCodeAt(offset))) offset++
      } else if (c === 47 && code.charCodeAt(offset + 1) === 42) {
        const end = code.indexOf('*/', offset + 2)
        offset = end === -1 ? code.length : end + 2
      } else {
        break
      }
    }
    return offset
  }

  // A probe for a list statement goes right after the previous token when only whitespace sits
  // between them, which keeps the statement's own columns, and right before the statement otherwise.
  function listInsertOffset (stmtStart, minOffset) {
    for (let i = minOffset; i < stmtStart; i++) {
      const c = code.charCodeAt(i)
      if (c !== 32 && c !== 9 && c !== 10 && c !== 13) return stmtStart
    }
    return minOffset
  }

  function insertListProbe (stmtStart, minOffset, line) {
    insert(listInsertOffset(stmtStart, minOffset), 1, ';' + probeText(line) + ';')
  }

  /**
   * @param {object[]} list
   * @param {number} minOffset first offset a probe may go at: just after the list's opening token
   * @param {number} dominatingLine a line recorded by a probe that runs whenever the list runs
   */
  function visitStatementList (list, minOffset, dominatingLine) {
    let prevLine = dominatingLine
    let floor = minOffset
    for (const stmt of list) {
      prevLine = visitListStatement(stmt, floor, prevLine)
      floor = stmt.end
    }
  }

  // Returns the line of a probe that dominates the code after this statement, or -1.
  function visitListStatement (stmt, minOffset, prevLine) {
    const type = stmt.type
    if (type === 'VariableDeclaration') {
      return visitVariableDeclaration(stmt, minOffset, prevLine, stmt.start)
    }
    if (type === 'ExportNamedDeclaration' && stmt.declaration?.type === 'VariableDeclaration') {
      return visitVariableDeclaration(stmt.declaration, minOffset, prevLine, stmt.start)
    }
    if (type === 'ExportDefaultDeclaration' && !isDeclaration(stmt.declaration)) {
      const line = recordedLine(stmt.start)
      if (line !== 0) insertListProbe(stmt.start, minOffset, line)
      visitNode(stmt.declaration)
      return -1
    }
    if (!STATEMENTS.has(type)) {
      visitNonCounted(stmt)
      return type === 'EmptyStatement' || type === 'FunctionDeclaration' ? prevLine : -1
    }
    const line = recordedLine(stmt.start)
    if (line !== 0 && (line !== prevLine || fn.touchEveryProbe)) insertListProbe(stmt.start, minOffset, line)
    const dominating = line === 0 || fn.touchEveryProbe ? -1 : line
    visitStatementChildren(stmt, dominating)
    return dominating
  }

  // A statement in a position that takes a single statement, like an if branch or a loop body.
  function visitBodyStatement (stmt, dominatingLine) {
    const type = stmt.type
    if (type === 'BlockStatement') {
      visitStatementList(stmt.body, stmt.start + 1, dominatingLine)
      return
    }
    let line = 0
    if (type === 'VariableDeclaration') {
      line = stmt.declarations[0]?.init ? recordedLine(stmt.declarations[0].init.start) : 0
    } else if (STATEMENTS.has(type)) {
      line = recordedLine(stmt.start)
    }
    if (line !== 0 && (line !== dominatingLine || fn.touchEveryProbe)) {
      insert(stmt.start, 1, '{' + probeText(line) + ';')
      insert(stmt.end, 0, '}')
    }
    if (type === 'VariableDeclaration') {
      for (const declarator of stmt.declarations) visitNode(declarator)
    } else if (STATEMENTS.has(type)) {
      visitStatementChildren(stmt, line === 0 || fn.touchEveryProbe ? -1 : line)
    } else {
      visitNonCounted(stmt)
    }
  }

  function visitVariableDeclaration (declaration, minOffset, prevLine, statementStart) {
    let dominating = prevLine
    let first = true
    for (const declarator of declaration.declarations) {
      const init = declarator.init
      visitNode(declarator.id)
      if (!init) continue
      const line = recordedLine(init.start)
      if (line !== 0) {
        if (first) {
          // The first initializer runs before anything else in the statement, so its probe can go
          // before the statement, which also keeps name inference for `const f = () => {}`.
          if (line !== dominating || fn.touchEveryProbe) insertListProbe(statementStart, minOffset, line)
        } else if (NAMED_BY_BINDING.has(init.type)) {
          // A synthetic declarator before this one records the line without wrapping the initializer.
          insert(declarator.start, 1, `${prefix}d${syntheticNames++}=(${probeText(line)}),`)
        } else {
          insert(init.start, 1, '(' + probeText(line) + ',')
          insert(init.end, 0, ')')
        }
        dominating = fn.touchEveryProbe ? -1 : line
      }
      first = false
      visitNode(init)
    }
    return -1
  }

  function visitStatementChildren (stmt, dominatingLine) {
    switch (stmt.type) {
      case 'ExpressionStatement':
        visitNode(stmt.expression)
        return
      case 'ReturnStatement':
      case 'ThrowStatement':
        visitNode(stmt.argument)
        return
      case 'IfStatement':
        visitNode(stmt.test)
        visitBodyStatement(stmt.consequent, dominatingLine)
        if (stmt.alternate) visitBodyStatement(stmt.alternate, -1)
        return
      case 'ForStatement':
        if (stmt.init?.type === 'VariableDeclaration') {
          for (const declarator of stmt.init.declarations) visitNode(declarator)
        } else {
          visitNode(stmt.init)
        }
        visitNode(stmt.test)
        visitNode(stmt.update)
        visitBodyStatement(stmt.body, dominatingLine)
        return
      case 'ForInStatement':
      case 'ForOfStatement':
        visitNode(stmt.left)
        visitNode(stmt.right)
        visitBodyStatement(stmt.body, dominatingLine)
        return
      case 'WhileStatement':
        visitNode(stmt.test)
        visitBodyStatement(stmt.body, dominatingLine)
        return
      case 'DoWhileStatement':
        visitBodyStatement(stmt.body, dominatingLine)
        visitNode(stmt.test)
        return
      case 'WithStatement':
        visitNode(stmt.object)
        visitBodyStatement(stmt.body, dominatingLine)
        return
      case 'LabeledStatement':
        visitBodyStatement(stmt.body, dominatingLine)
        return
      case 'SwitchStatement':
        visitNode(stmt.discriminant)
        for (const switchCase of stmt.cases) {
          visitNode(switchCase.test)
          // `case <test>:` or `default:`
          const colon = skipTrivia(switchCase.test ? switchCase.test.end : switchCase.start + 7)
          visitStatementList(switchCase.consequent, colon + 1, -1)
        }
        return
      case 'TryStatement':
        visitStatementList(stmt.block.body, stmt.block.start + 1, dominatingLine)
        if (stmt.handler) {
          visitNode(stmt.handler.param)
          visitStatementList(stmt.handler.body.body, stmt.handler.body.start + 1, -1)
        }
        if (stmt.finalizer) visitStatementList(stmt.finalizer.body, stmt.finalizer.start + 1, -1)
    }
  }

  function visitNonCounted (stmt) {
    switch (stmt.type) {
      case 'BlockStatement':
        visitStatementList(stmt.body, stmt.start + 1, -1)
        return
      case 'ExportNamedDeclaration':
      case 'ExportDefaultDeclaration':
        visitNode(stmt.declaration)
        return
      case 'VariableDeclaration':
        for (const declarator of stmt.declarations) visitNode(declarator)
        return
      default:
        if (!STATEMENTS.has(stmt.type)) visitNode(stmt)
    }
  }

  function visitFunction (node) {
    for (const param of node.params) visitNode(param)
    const outer = fn
    fn = {
      init: false,
      touchEveryProbe: (node.async || node.generator) && containsSuspension(node.body),
      touched: false,
    }
    const body = node.body
    if (body.type === 'BlockStatement') {
      // A probe before 'use strict' would turn the directive into a plain expression.
      const directives = countDirectives(body.body, code)
      if (directives === 0) {
        visitStatementList(body.body, body.start + 1, -1)
      } else {
        visitStatementList(body.body.slice(directives), body.body[directives - 1].end, -1)
      }
    } else {
      // Arrow function with an expression body.
      const line = recordedLine(body.start)
      if (line !== 0) {
        insert(body.start, 1, '(' + probeText(line) + ',')
        insert(body.end, 0, ')')
      }
      visitNode(body)
    }
    fn = outer
  }

  // Class field initializers and static blocks run as functions of their own. Static ones run when
  // the class is defined, so they are initialiser code when the class is.
  function visitClassMember (node) {
    if (node.type === 'StaticBlock') {
      const outer = fn
      fn = { init: outer.init, touchEveryProbe: false, touched: false }
      visitStatementList(node.body, skipTrivia(node.start + 6) + 1, -1)
      fn = outer
      return
    }
    if (node.decorators) {
      for (const decorator of node.decorators) visitNode(decorator)
    }
    if (node.computed) visitNode(node.key)
    const value = node.value
    if (!value) return
    const outer = fn
    fn = { init: node.static && outer.init, touchEveryProbe: false, touched: false }
    const line = recordedLine(value.start)
    if (line !== 0) {
      if (NAMED_BY_BINDING.has(value.type)) {
        // A synthetic private field just before this one records the line and keeps name inference.
        const name = `#${prefix}p${syntheticNames++}`
        insert(node.start, 1, `${node.static ? 'static ' : ''}${name}=(${probeText(line)},void 0);`)
      } else {
        insert(value.start, 1, '(' + probeText(line) + ',')
        insert(value.end, 0, ')')
      }
    }
    visitNode(value)
    fn = outer
  }

  function visitNode (node) {
    if (!node || typeof node !== 'object') return
    const type = node.type
    if (FUNCTION_TYPES.has(type)) {
      visitFunction(node)
      return
    }
    if (type === 'PropertyDefinition' || type === 'AccessorProperty' || type === 'StaticBlock') {
      visitClassMember(node)
      return
    }
    if (type === 'BlockStatement' || STATEMENTS.has(type)) {
      visitBodyStatement(node, -1)
      return
    }
    const keys = CHILD_KEYS[type] || Object.keys(node)
    for (const key of keys) {
      if (SKIPPED_KEYS.has(key)) continue
      const value = node[key]
      if (!value || typeof value !== 'object') continue
      if (Array.isArray(value)) {
        for (const item of value) visitNode(item)
      } else {
        visitNode(value)
      }
    }
  }

  // The header goes after the hashbang line and the directive prologue.
  const body = program.body
  const index = countDirectives(body, code)
  let headerOffset = code.startsWith('#!') ? (lineStarts[1] ?? code.length) : 0
  if (index > 0) headerOffset = body[index - 1].end
  fn = { init: true, touchEveryProbe: isModule && containsSuspension(body), touched: false }
  visitStatementList(index === 0 ? body : body.slice(index), headerOffset, -1)

  if (lineSet.size === 0 && initLineSet.size === 0) return

  const lines = [...lineSet].sort((a, b) => a - b)
  const initLines = [...initLineSet].sort((a, b) => a - b)
  inserts.push([headerOffset, -1, -1, header(prefix, lines, initLines, fileIndex)])
  inserts.sort(compareInserts)

  let out = ''
  let last = 0
  for (const [offset, , , text] of inserts) {
    out += code.slice(last, offset) + text
    last = offset
  }
  out += code.slice(last)
  return { code: out, lines, initLines }
}

// Number of leading statements that form a directive prologue, like 'use strict'.
function countDirectives (statements, code) {
  let count = 0
  while (count < statements.length) {
    const statement = statements[count]
    if (statement.type !== 'ExpressionStatement' || statement.expression.type !== 'Literal' ||
      typeof statement.expression.value !== 'string') {
      break
    }
    // A parenthesized string is an expression, not a directive.
    const quote = code.charCodeAt(statement.start)
    if (quote !== 39 && quote !== 34) break
    count++
  }
  return count
}

function isDeclaration (node) {
  return node?.type === 'FunctionDeclaration' || node?.type === 'ClassDeclaration'
}

function isLineBreak (c) {
  return c === 10 || c === 13 || c === 0x20_28 || c === 0x20_29
}

function compareInserts (a, b) {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

// Declares the line variables, the touch function and the reader. Both functions are hoisted, so
// code that runs before the header (hoisted functions called through a circular import) still works.
// The reader writes the file index and then the executed lines into `o`, initialiser lines negated,
// clears them, and returns the number of entries it wrote. It returns 0 when it already ran for
// boundary `g`.
function header (prefix, lines, initLines, fileIndex) {
  let reader = `function ${prefix}x(o,g){if(${prefix}g===g)return 0;${prefix}g=g;o[0]=${fileIndex};var n=1;`
  for (const line of lines) {
    reader += `if(${prefix}${line}){o[n++]=${line};${prefix}${line}=0}`
  }
  for (const line of initLines) {
    reader += `if(${prefix}i${line}){o[n++]=${-line};${prefix}i${line}=0}`
  }
  reader += `${prefix}t=0;return n}`
  const touch = `function ${prefix}r(){${prefix}t=1;var c=${prefix}c||(${prefix}c=` +
    `globalThis[Symbol.for('dd-trace.line-coverage')]);if(c)c.q.push(${prefix}x)}`
  let names = `${prefix}t=0,${prefix}g=0,${prefix}c`
  for (const line of lines) names += `,${prefix}${line}`
  for (const line of initLines) names += `,${prefix}i${line}`
  return `;var ${names};${touch}${reader}`
}

function choosePrefix (code) {
  let prefix = '$dd$'
  let n = 0
  while (code.includes(prefix)) prefix = `$dd${++n}$`
  return prefix
}

function getLineStarts (code) {
  const starts = [0]
  for (let i = 0; i < code.length; i++) {
    const c = code.charCodeAt(i)
    if (c === 10) {
      starts.push(i + 1)
    } else if (c === 13) {
      if (code.charCodeAt(i + 1) === 10) i++
      starts.push(i + 1)
    } else if (c === 0x20_28 || c === 0x20_29) {
      starts.push(i + 1)
    }
  }
  return starts
}

// Whether code awaits or yields, not counting nested functions.
function containsSuspension (node) {
  if (!node || typeof node !== 'object') return false
  if (Array.isArray(node)) {
    for (const item of node) {
      if (containsSuspension(item)) return true
    }
    return false
  }
  const type = node.type
  if (type === 'AwaitExpression' || type === 'YieldExpression') return true
  if (type === 'ForOfStatement' && node.await) return true
  if (FUNCTION_TYPES.has(type)) return false
  for (const key of Object.keys(node)) {
    if (SKIPPED_KEYS.has(key)) continue
    const value = node[key]
    if (value && typeof value === 'object' && containsSuspension(value)) return true
  }
  return false
}

module.exports = { instrument }
