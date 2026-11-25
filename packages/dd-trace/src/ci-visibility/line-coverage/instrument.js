'use strict'

// Inserts per-test line probes into JavaScript source text.
//
// A line counts in a window when code on it began to run in that window. Code is the start of an
// ESTree statement or expression node (a position), counted by the rules of the accuracy checker's
// definition: when control reaches it, so an untaken branch, a short-circuited operand or the rest
// of a line after a throw does not count; a function declaration when its scope is entered; a
// method header when the class definition reaches it; code after an `await` or `yield` in the
// window in which it resumes.
//
// A probe stores 1 into a module-scope variable that stands for one line of one source file (a
// slot). The walk follows evaluation order and leaves out a probe when a probe for the same slot
// has run on every path since the current activation started or last resumed. Probes that run at
// the same instant share one place, which is the cheapest one available: before a statement,
// inside a block, around an expression, in the key of a property access, or right after an
// expression that may throw, through an identity call. Positions with no such place, like a method
// header, take a computed key or a synthetic declaration.
//
// The first probe of an activation checks the module's touched flag, and calls the collector when it
// is clear: the collector works out who owns the running context and queues the module's reader.
// Code that may start a new job, so run in another context, calls the collector unconditionally:
// the first probe after each resumption, and the first probe of a function passed inline to
// `then`, `catch`, `finally` or `queueMicrotask`.
//
// Inserted text never contains a newline, so line numbers stay intact.

const UNMAPPED = -2
const TOUCHED = -1

// What the first probe of an activation segment does with the module's touched flag.
const TOUCH_IF_CLEAR = 1
const TOUCH_ALWAYS = 2

// Calls whose function arguments run as a job of their own.
const JOB_METHODS = new Set(['then', 'catch', 'finally'])

// Line terminators besides `\n`, which JavaScript counts and source maps do not.
const OTHER_LINE_TERMINATORS = /[\r\u2028\u2029]/

const LIST = 0
const SLOT = 1
const LABEL = 2

// Slots are bits of module-scope integers, 30 per variable so the values stay small integers.
const SLOTS_PER_WORD = 30

const RANK_CLOSER = 0
const RANK_PREFIX = 1
const RANK_OPENER = 2
const RANK_REPLACE = 3

const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'])

/**
 * @typedef {object} InstrumentOptions
 * @property {(code: string) => object} parse returns an ESTree Program with UTF-16 `start` and `end`
 * @property {string} [moduleKey] identifies the instrumented code: the module gives it to the collector,
 *   with its slot table, the first time it runs
 * @property {Array<string | null>} [sources] the file each source stands for, null for a source whose
 *   lines count nowhere; one entry, for the code itself, when there is no `mapPosition`
 * @property {(line: number, column: number) => ({ source: number, line: number } | undefined)} [mapPosition]
 *   maps a generated position (1-based line, 0-based column) to a source and its 1-based line, or
 *   undefined when the position is not credited
 *
 * @typedef {{ source: number, line: number, init: boolean }} Slot
 */

/**
 * @param {string} code
 * @param {InstrumentOptions} options
 * @returns {{ code: string, slots: Slot[], unprobed: number } | undefined} undefined when nothing is
 *   probed. Slot `i` is bit `i % 30` of word `Math.floor(i / 30)` in what the reader writes.
 */
function instrument (code, options) {
  const program = options.parse(code)
  for (const statement of program.body) {
    if (statement.type.startsWith('Import') || statement.type.startsWith('Export')) return
  }
  return new Instrumenter(code, program, options).run()
}

class Instrumenter {
  /**
   * @param {string} code
   * @param {object} program
   * @param {InstrumentOptions} options
   */
  constructor (code, program, { moduleKey = '', sources = [null], mapPosition }) {
    this.code = code
    this.program = program
    this.moduleKey = moduleKey
    this.sources = sources
    this.mapPosition = mapPosition
    this.prefix = choosePrefix(code)
    const isNewlineOnly = !OTHER_LINE_TERMINATORS.test(code)
    this.lineStarts = isNewlineOnly ? getNewlineStarts(code) : getLineStarts(code)
    // Source maps count lines by `\n` alone.
    this.mapLineStarts = mapPosition ? (isNewlineOnly ? this.lineStarts : getNewlineStarts(code)) : undefined

    /** @type {Map<number, number>} */
    this.slotByKey = new Map()
    /** @type {Array<Slot & { probed: boolean }>} */
    this.slots = []
    /** @type {object[]} */
    this.points = []
    /** @type {object[]} */
    this.edits = []
    /** @type {Array<{ node: object, where: number }>} */
    this.expressionStatements = []
    this.syntheticNames = 0
    this.sequence = 0
    this.unprobed = 0

    // Whether positions being visited are initialiser code.
    this.init = true
    // Slot -> segment in which a probe for it has run on every path; `undo` restores it.
    /** @type {Map<number, number>} */
    this.done = new Map()
    /** @type {number[]} */
    this.undo = []
    this.segments = 0
    this.segment = 0
    // The segment an activation starts in; a probe point in any other segment follows a resumption.
    this.entrySegment = 0
    /** @type {WeakSet<object>} functions that run as a job of their own */
    this.jobFunctions = new WeakSet()
    // The open credit point: probes attached to it run at an instant that is control-equivalent to
    // the current one. `latent` realizes the instant right after the last expression that may throw.
    this.point = null
    this.latent = null
    /** @type {Array<{ slot: number, costly: object | null }>} */
    this.pending = []
    // Inside the spine of an optional chain: the first conditional snapshot, or null.
    this.chain = null
    this.inChain = false
    this.inWith = 0
  }

  run () {
    const { program, code } = this
    const body = program.body
    const directives = countDirectives(body, code)
    let headerOffset = code.startsWith('#!') ? (this.lineStarts[1] ?? code.length) : 0
    if (directives > 0) headerOffset = body[directives - 1].end
    this.headerOffset = headerOffset

    this.activation(() => {
      this.init = true
      const opener = { kind: 'prefix', at: headerOffset }
      this.scopeEntry(body, directives, opener)
      this.statements(body, directives, headerOffset)
    })

    if (this.points.length === 0) return
    this.emit()
    this.guardStatementStarts()
    const words = []
    for (let slot = 0; slot < this.slots.length; slot++) {
      const word = Math.floor(slot / SLOTS_PER_WORD)
      if (this.slots[slot].probed && words.at(-1) !== word) words.push(word)
    }
    this.edits.push({
      at: headerOffset,
      end: headerOffset,
      rank: -1,
      text: this.header(words),
      spanStart: 0,
      spanEnd: 0,
      sub: 0,
      sequence: -1,
    })
    return {
      code: applyEdits(code, this.edits),
      slots: this.slots.map(({ source, line, init }) => ({ source, line, init })),
      unprobed: this.unprobed,
    }
  }

  // --- Positions and credit points ---

  slotAt (offset) {
    const init = this.init
    let source = 0
    let line
    if (this.mapLineStarts === undefined) {
      line = lineAt(this.lineStarts, offset)
    } else {
      const generatedLine = lineAt(this.mapLineStarts, offset)
      const mapped = this.mapPosition(generatedLine, offset - this.mapLineStarts[generatedLine - 1])
      if (mapped === undefined) return UNMAPPED
      source = mapped.source
      line = mapped.line
    }
    const key = (source * 4_194_304 + line) * 2 + (init ? 1 : 0)
    let slot = this.slotByKey.get(key)
    if (slot === undefined) {
      slot = this.slots.length
      this.slots.push({ source, line, init, probed: false })
      this.slotByKey.set(key, slot)
    }
    return slot
  }

  /**
   * Records the position of `node`, which begins now.
   *
   * @param {object} node
   * @param {object | null} [cheap] realizes the current instant
   * @param {object | null} [costly] realizes it, at a price: used only when nothing else does
   */
  position (node, cheap, costly) {
    const slot = this.slotAt(node.start)
    if (slot === UNMAPPED || this.isDone(slot)) return
    if (this.point === null) {
      const opener = cheap ?? this.latent
      if (opener === null || opener === undefined) {
        this.pending.push({ slot, costly: costly ?? null })
        return
      }
      this.open(opener)
    }
    this.attach(slot)
  }

  isDone (slot) {
    return this.done.get(slot) === this.segment
  }

  markDone (slot) {
    this.undo.push(slot, this.done.get(slot) ?? -1)
    this.done.set(slot, this.segment)
  }

  attach (slot) {
    if (this.isDone(slot)) return
    this.point.slots.push(slot)
    this.slots[slot].probed = true
    this.markDone(slot)
  }

  open (opener) {
    const point = { opener, slots: [], touch: 0 }
    this.points.push(point)
    this.point = point
    this.latent = null
    if (!this.isDone(TOUCHED)) {
      point.touch = this.segment === this.entrySegment ? TOUCH_IF_CLEAR : TOUCH_ALWAYS
      this.markDone(TOUCHED)
    }
    const pending = this.pending
    if (pending.length > 0) {
      this.pending = []
      for (const { slot } of pending) this.attach(slot)
    }
  }

  // Positions waiting for a place get one now, before control can leave the current instant.
  flush () {
    const pending = this.pending
    if (pending.length === 0) return
    for (const { costly } of pending) {
      if (costly !== null) {
        this.open(costly)
        return
      }
    }
    this.unprobed += pending.length
    this.pending = []
  }

  // Something that may throw just ran: later code is not control-equivalent to earlier code.
  unsafe () {
    this.flush()
    this.point = null
    this.latent = null
  }

  snapshot () {
    return { undo: this.undo.length, segment: this.segment }
  }

  restore (snapshot) {
    if (this.segment !== snapshot.segment) {
      // A resumption happened since: nothing is known to have run in the current window.
      this.segment = ++this.segments
      return
    }
    this.rollback(snapshot.undo)
  }

  rollback (length) {
    const { undo, done } = this
    while (undo.length > length) {
      const previous = undo.pop()
      const slot = undo.pop()
      if (previous === -1) done.delete(slot)
      else done.set(slot, previous)
    }
  }

  // Entry to code that runs only on some paths.
  branch () {
    this.unsafe()
    return this.snapshot()
  }

  merge (snapshot) {
    this.unsafe()
    this.restore(snapshot)
  }

  // Code after this point may run in a later window.
  suspend () {
    this.unsafe()
    this.segment = ++this.segments
  }

  /**
   * @param {() => void} walk
   * @param {boolean} [isJob] whether the activation starts a job of its own
   */
  activation (walk, isJob = false) {
    const saved = {
      init: this.init,
      segment: this.segment,
      entrySegment: this.entrySegment,
      point: this.point,
      latent: this.latent,
      pending: this.pending,
      undo: this.undo.length,
      chain: this.chain,
      inChain: this.inChain,
    }
    this.segment = ++this.segments
    this.entrySegment = isJob ? -1 : this.segment
    this.point = null
    this.latent = null
    this.pending = []
    this.chain = null
    this.inChain = false
    walk()
    this.flush()
    this.rollback(saved.undo)
    this.init = saved.init
    this.segment = saved.segment
    this.entrySegment = saved.entrySegment
    this.point = saved.point
    this.latent = saved.latent
    this.pending = saved.pending
    this.chain = saved.chain
    this.inChain = saved.inChain
  }

  // --- Statements ---

  // Function declarations, and directives, count when their scope is entered.
  scopeEntry (list, directives, opener) {
    for (let i = 0; i < list.length; i++) {
      const statement = list[i]
      if (i < directives) {
        this.position(statement, opener)
        this.position(statement.expression, opener)
      } else if (statement.type === 'FunctionDeclaration') {
        this.position(statement, opener)
        this.functionBody(statement)
      }
    }
  }

  statements (list, from, floor) {
    for (let i = from; i < list.length; i++) {
      const statement = list[i]
      if (statement.type !== 'FunctionDeclaration') {
        this.statement(statement, { kind: 'prefix', at: listInsertOffset(this.code, statement.start, floor) }, LIST)
      }
      floor = statement.end
    }
  }

  // A statement in a place that takes a single statement, like an if branch or a loop body.
  slotStatement (statement) {
    if (statement.type === 'BlockStatement') {
      this.block(statement)
    } else {
      this.statement(statement, { kind: 'slot', node: statement }, SLOT)
    }
  }

  block (node) {
    const opener = { kind: 'prefix', at: node.start + 1 }
    this.position(node, opener)
    this.scopeEntry(node.body, 0, opener)
    this.statements(node.body, 0, node.start + 1)
  }

  abrupt () {
    this.unsafe()
  }

  statement (node, opener, where) {
    switch (node.type) {
      case 'ExpressionStatement':
        this.expressionStatements.push({ node, where })
        this.position(node, opener)
        this.expression(node.expression, false, opener)
        return
      case 'VariableDeclaration':
        this.variableDeclaration(node, opener)
        return
      case 'FunctionDeclaration':
        // Only in a statement slot (sloppy-mode `if (a) function f () {}`).
        this.position(node, opener)
        this.functionBody(node)
        return
      case 'ClassDeclaration':
        this.position(node, opener)
        this.classBody(node)
        return
      case 'BlockStatement':
        this.block(node)
        return
      case 'EmptyStatement':
      case 'DebuggerStatement':
        this.position(node, opener)
        return
      case 'ReturnStatement':
      case 'ThrowStatement':
        this.position(node, opener)
        if (node.argument) this.expression(node.argument, true, opener)
        this.abrupt()
        return
      case 'BreakStatement':
      case 'ContinueStatement':
        this.position(node, opener)
        this.abrupt()
        return
      case 'IfStatement': {
        this.position(node, opener)
        this.expression(node.test, true, opener)
        let snapshot = this.branch()
        this.slotStatement(node.consequent)
        this.merge(snapshot)
        if (node.alternate) {
          snapshot = this.branch()
          this.slotStatement(node.alternate)
          this.merge(snapshot)
        }
        return
      }
      case 'WhileStatement': {
        this.position(node, opener)
        if (containsSuspension(node)) this.suspend()
        this.expression(node.test, true, null)
        const snapshot = this.branch()
        this.slotStatement(node.body)
        this.merge(snapshot)
        return
      }
      case 'DoWhileStatement': {
        this.position(node, opener)
        if (containsSuspension(node)) this.suspend()
        const snapshot = this.snapshot()
        this.slotStatement(node.body)
        this.unsafe()
        this.expression(node.test, true, null)
        this.merge(snapshot)
        return
      }
      case 'ForStatement': {
        this.position(node, opener)
        if (node.init) {
          if (node.init.type === 'VariableDeclaration') {
            this.variableDeclaration(node.init, opener)
          } else {
            this.expression(node.init, true, opener)
          }
        }
        if (containsSuspension(node.test) || containsSuspension(node.update) || containsSuspension(node.body)) {
          this.suspend()
        }
        if (node.test) this.expression(node.test, true, null)
        const snapshot = this.branch()
        this.slotStatement(node.body)
        if (node.update) {
          this.unsafe()
          this.expression(node.update, true, null)
        }
        this.merge(snapshot)
        return
      }
      case 'ForInStatement':
      case 'ForOfStatement': {
        this.position(node, opener)
        this.expression(node.right, true, opener)
        this.unsafe()
        if (node.await || containsSuspension(node.left) || containsSuspension(node.body)) this.suspend()
        const snapshot = this.branch()
        const left = node.left
        if (left.type === 'VariableDeclaration') {
          // Bound on each iteration, where no probe can go: it counts with the body when only a name
          // is bound, and through other positions on its line otherwise.
          this.position(left, null)
          for (const declarator of left.declarations) {
            this.pattern(declarator.id, false)
            if (declarator.init) this.expression(declarator.init, true, null)
          }
        } else {
          this.pattern(left, true)
        }
        this.slotStatement(node.body)
        this.merge(snapshot)
        return
      }
      case 'LabeledStatement': {
        this.position(node, opener)
        const snapshot = this.snapshot()
        this.statement(node.body, opener, LABEL)
        this.merge(snapshot)
        return
      }
      case 'SwitchStatement':
        this.switchStatement(node, opener)
        return
      case 'TryStatement': {
        this.position(node, opener)
        const snapshot = this.snapshot()
        this.block(node.block)
        if (node.handler) {
          this.unsafe()
          this.restore(snapshot)
          if (node.handler.param) this.pattern(node.handler.param, false)
          this.block(node.handler.body)
        }
        this.unsafe()
        this.restore(snapshot)
        if (node.finalizer) {
          this.block(node.finalizer)
          this.unsafe()
        }
        return
      }
      case 'WithStatement':
        this.position(node, opener)
        this.expression(node.object, true, opener)
        this.unsafe()
        this.inWith++
        this.slotStatement(node.body)
        this.inWith--
        return
      default:
        throw new Error(`Unsupported statement ${node.type}`)
    }
  }

  variableDeclaration (node, opener) {
    this.position(node, opener)
    const declarations = node.declarations
    for (let i = 0; i < declarations.length; i++) {
      const declarator = declarations[i]
      const init = declarator.init
      if (init) {
        const cheap = i === 0 ? opener : null
        if (declarator.id.type === 'Identifier' && isAnonymousFunctionDefinition(init)) {
          this.namedValue(init, cheap, { kind: 'declarator', node: declarator })
        } else {
          this.expression(init, true, cheap)
        }
      }
      this.pattern(declarator.id, false)
    }
  }

  switchStatement (node, opener) {
    this.position(node, opener)
    this.expression(node.discriminant, true, opener)
    // Function declarations of the case block count when it is entered, after the discriminant.
    for (const switchCase of node.cases) this.scopeEntry(switchCase.consequent, 0, null)
    const snapshot = this.snapshot()
    let first = true
    for (const switchCase of node.cases) {
      if (!switchCase.test) continue
      // A test runs only when no earlier one matched.
      if (!first) this.unsafe()
      first = false
      this.expression(switchCase.test, true, null)
    }
    for (const switchCase of node.cases) {
      this.unsafe()
      this.restore(snapshot)
      const colon = skipTrivia(this.code, switchCase.test ? switchCase.test.end : switchCase.start + 7)
      this.statements(switchCase.consequent, 0, colon + 1)
    }
    this.unsafe()
    this.restore(snapshot)
  }

  // --- Functions and classes ---

  // A function or arrow expression, a method value or a declaration's body: `node` counts when the
  // closure is created; its parameters and body run in an activation of their own.
  functionNode (node, cheap, costly) {
    this.position(node, cheap, costly)
    this.functionBody(node)
  }

  functionBody (node) {
    this.activation(() => {
      this.init = false
      for (const param of node.params) this.pattern(param, false)
      // A generator's body starts at the first next(), not when it is called.
      if (node.generator) this.suspend()
      const body = node.body
      if (body.type === 'BlockStatement') {
        const directives = countDirectives(body.body, this.code)
        const at = directives > 0 ? body.body[directives - 1].end : body.start + 1
        const opener = { kind: 'prefix', at }
        this.position(body, opener)
        this.scopeEntry(body.body, directives, opener)
        this.statements(body.body, directives, at)
      } else {
        this.expression(body, true, null)
      }
    }, this.jobFunctions.has(node))
  }

  // An anonymous function or class whose name comes from where it is defined: wrapping it would
  // change its name, so it counts through `cheap`, the open point, or `costly`.
  namedValue (node, cheap, costly) {
    if (node.type === 'ClassExpression') {
      this.position(node, cheap, costly)
      this.classBody(node)
    } else {
      this.functionNode(node, cheap, costly)
    }
  }

  // The class's own position has been recorded; this evaluates its definition.
  classBody (node) {
    const initialiser = this.init
    const elements = node.body.body
    if (node.superClass) {
      this.expression(node.superClass, true, null)
    }
    // A constructor or private method header has no key to probe in: it counts once `extends` has
    // been evaluated, or when the definition starts.
    for (const element of elements) {
      if (element.type === 'MethodDefinition' && hasHeaderWithoutKey(element)) this.position(element.value, null)
    }
    if (node.superClass) this.unsafe()

    for (const element of elements) {
      if (element.type === 'MethodDefinition') {
        if (hasHeaderWithoutKey(element)) {
          this.functionBody(element.value)
          continue
        }
        if (element.computed) {
          // The header counts when the definition reaches the element, before its key.
          const opener = { kind: 'wrap', node: element.key }
          this.position(element.value, opener)
          this.expression(element.key, true, opener)
        } else {
          this.position(element.value, null, { kind: 'methodKey', node: element.key })
        }
        this.functionBody(element.value)
      } else if (isField(element) && element.computed) {
        this.expression(element.key, true, null)
      }
    }

    // Static fields and blocks run in order once the class is defined.
    for (const element of elements) {
      if (element.type === 'StaticBlock') {
        this.init = initialiser
        const at = skipTrivia(this.code, element.start + 6) + 1
        const opener = { kind: 'prefix', at }
        this.scopeEntry(element.body, 0, opener)
        this.statements(element.body, 0, at)
      } else if (isField(element) && element.static && element.value) {
        this.init = initialiser
        this.fieldValue(element)
      }
    }
    this.init = initialiser

    // Instance fields run at construction.
    const fields = elements.filter(element => isField(element) && !element.static && element.value)
    if (fields.length > 0) {
      this.activation(() => {
        this.init = false
        for (const field of fields) this.fieldValue(field)
      })
    }
  }

  fieldValue (element) {
    const value = element.value
    if (isAnonymousFunctionDefinition(value)) {
      this.namedValue(value, null, { kind: 'field', node: element })
    } else {
      this.expression(value, true, null)
    }
  }

  // --- Expressions ---

  /**
   * Evaluates an expression.
   *
   * @param {object} node
   * @param {boolean} wrapOk whether the node may be wrapped in parentheses with probes, which also
   *   allows a probe right after it
   * @param {object | null} opener realizes the instant at which the node begins
   */
  expression (node, wrapOk, opener) {
    if (opener === null && wrapOk) opener = { kind: 'wrap', node }
    const inChain = this.inChain
    if (node.type !== 'MemberExpression' && node.type !== 'CallExpression') this.inChain = false
    this.evaluate(node, wrapOk, opener)
    this.inChain = inChain
    if (this.point === null) this.latent = wrapOk ? { kind: 'after', node } : null
  }

  evaluate (node, wrapOk, opener) {
    switch (node.type) {
      case 'Identifier':
      case 'ThisExpression':
      case 'Super':
        this.position(node, opener)
        this.unsafe()
        return
      case 'Literal':
        this.position(node, opener)
        return
      case 'TemplateLiteral':
        this.position(node, opener)
        for (const expression of node.expressions) {
          this.expression(expression, true, null)
          this.unsafe()
        }
        return
      case 'TaggedTemplateExpression':
        this.position(node, opener)
        // Wrapping a member tag would lose its `this`; inside `with`, so would wrapping a name.
        this.expression(node.tag, node.tag.type !== 'MemberExpression' && this.inWith === 0, opener)
        // The template counts once the tag has been evaluated; its first substitution follows at once.
        this.position(node.quasi, null)
        for (const expression of node.quasi.expressions) this.expression(expression, true, null)
        this.unsafe()
        return
      case 'ArrayExpression':
        this.position(node, opener)
        for (const element of node.elements) {
          if (element === null) continue
          if (element.type === 'SpreadElement') {
            this.expression(element.argument, true, null)
            this.unsafe()
          } else {
            this.expression(element, true, null)
          }
        }
        return
      case 'ObjectExpression':
        this.position(node, opener)
        this.objectProperties(node)
        return
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        this.functionNode(node, opener, null)
        return
      case 'ClassExpression':
        this.position(node, opener)
        this.classBody(node)
        return
      case 'MemberExpression':
        this.member(node, wrapOk, opener, true)
        return
      case 'ChainExpression': {
        this.position(node, opener)
        const chain = this.chain
        this.chain = null
        this.inChain = true
        this.expression(node.expression, false, opener)
        this.inChain = false
        if (this.chain !== null) this.merge(this.chain)
        this.chain = chain
        return
      }
      case 'CallExpression':
        this.call(node, opener)
        return
      case 'NewExpression':
        this.position(node, opener)
        this.expression(node.callee, true, opener)
        this.arguments(node.arguments)
        this.unsafe()
        return
      case 'ImportExpression':
        this.position(node, opener)
        this.expression(node.source, true, opener)
        if (node.options) this.expression(node.options, true, null)
        this.unsafe()
        return
      case 'UpdateExpression':
        this.position(node, opener)
        this.target(node.argument, opener, true)
        this.unsafe()
        return
      case 'UnaryExpression':
        this.unary(node, opener)
        return
      case 'BinaryExpression':
        this.position(node, opener)
        if (node.left.type === 'PrivateIdentifier') {
          this.position(node.left, opener)
        } else {
          this.expression(node.left, true, opener)
        }
        this.expression(node.right, true, null)
        if (node.operator !== '===' && node.operator !== '!==') this.unsafe()
        return
      case 'LogicalExpression': {
        this.position(node, opener)
        this.expression(node.left, true, opener)
        const snapshot = this.branch()
        this.expression(node.right, true, null)
        this.merge(snapshot)
        return
      }
      case 'ConditionalExpression': {
        this.position(node, opener)
        this.expression(node.test, true, opener)
        let snapshot = this.branch()
        this.expression(node.consequent, true, null)
        this.merge(snapshot)
        snapshot = this.branch()
        this.expression(node.alternate, true, null)
        this.merge(snapshot)
        return
      }
      case 'AssignmentExpression':
        this.assignment(node, opener)
        return
      case 'SequenceExpression': {
        this.position(node, opener)
        const expressions = node.expressions
        for (let i = 0; i < expressions.length; i++) this.expression(expressions[i], true, i === 0 ? opener : null)
        return
      }
      case 'YieldExpression':
      case 'AwaitExpression':
        this.position(node, opener)
        if (node.argument) this.expression(node.argument, true, opener)
        this.suspend()
        return
      case 'MetaProperty':
        return
      case 'ParenthesizedExpression':
        this.evaluate(node.expression, wrapOk, opener)
        return
      default:
        throw new Error(`Unsupported expression ${node.type}`)
    }
  }

  objectProperties (node) {
    for (const property of node.properties) {
      if (property.type === 'SpreadElement') {
        this.expression(property.argument, true, null)
        this.unsafe()
        continue
      }
      if (property.computed) this.expression(property.key, true, null)
      const value = property.value
      if (property.method || property.kind !== 'init') {
        this.functionNode(value, null, property.computed ? null : { kind: 'methodKey', node: property.key })
      } else if (property.shorthand) {
        this.position(value, { kind: 'shorthand', node: value })
        this.unsafe()
      } else if (isAnonymousFunctionDefinition(value) && !isProtoSetter(property)) {
        const opener = property.computed ? null : { kind: 'named', node: value, name: this.keyText(property.key) }
        this.namedValue(value, null, opener)
      } else {
        this.expression(value, true, null)
      }
    }
  }

  // The text of a non-computed key as an expression that evaluates to the property name.
  keyText (key) {
    if (key.type === 'Identifier') return JSON.stringify(key.name)
    return this.code.slice(key.start, key.end)
  }

  /**
   * @param {object} node a MemberExpression
   * @param {boolean} wrapOk
   * @param {object | null} opener
   * @param {boolean} read whether the property is read; false for an assignment target
   */
  member (node, wrapOk, opener, read) {
    this.position(node, opener)
    const object = node.object
    const inChain = this.inChain
    if (object.type === 'Super') {
      this.position(object, opener)
    } else {
      // Inside an optional chain, wrapping a part of the spine that holds an optional link would
      // stop the short-circuit from reaching the rest of the chain.
      const objectWrapOk = !(inChain && hasOptionalLink(object))
      this.inChain = inChain && (object.type === 'MemberExpression' || object.type === 'CallExpression')
      this.expression(object, objectWrapOk, opener)
      this.inChain = inChain
    }
    if (node.optional) this.optionalLink()
    const property = node.property
    if (node.computed) {
      this.inChain = false
      this.expression(property, true, null)
      this.inChain = inChain
    } else {
      this.position(property, this.propertyOpener(node, inChain))
    }
    if (read) this.unsafe()
  }

  // Realizes the instant right after a member's object is evaluated, before its property is read.
  propertyOpener (node, inChain) {
    if (node.property.type === 'Identifier') return { kind: 'keyed', node }
    const object = node.object
    if (node.optional || object.type === 'Super' || (inChain && hasOptionalLink(object))) return null
    return { kind: 'after', node: object }
  }

  // What follows an optional link runs only when it did not short-circuit, up to the chain's end.
  optionalLink () {
    if (this.chain === null) {
      this.chain = this.branch()
    } else {
      this.unsafe()
    }
  }

  call (node, opener) {
    this.position(node, opener)
    const callee = node.callee
    const inChain = this.inChain
    if (callee.type === 'Super') {
      this.position(callee, opener)
    } else if (callee.type === 'MemberExpression') {
      this.inChain = inChain
      this.member(callee, false, opener, true)
    } else {
      this.inChain = inChain && callee.type === 'CallExpression'
      this.expression(callee, false, opener)
    }
    this.inChain = false
    if (node.optional) this.optionalLink()
    if (startsJobs(callee)) {
      for (const argument of node.arguments) {
        if (argument.type === 'FunctionExpression' || argument.type === 'ArrowFunctionExpression') {
          this.jobFunctions.add(argument)
        }
      }
    }
    this.arguments(node.arguments)
    this.inChain = inChain
    this.unsafe()
  }

  arguments (list) {
    for (const argument of list) {
      if (argument.type === 'SpreadElement') {
        this.expression(argument.argument, true, null)
        this.unsafe()
      } else {
        this.expression(argument, true, null)
      }
    }
  }

  unary (node, opener) {
    this.position(node, opener)
    const argument = node.argument
    const operator = node.operator
    if (operator === 'delete' && argument.type === 'MemberExpression') {
      this.member(argument, false, opener, false)
    } else if ((operator === 'delete' || operator === 'typeof') && argument.type === 'Identifier') {
      this.position(argument, opener)
    } else {
      // `delete (probes, a?.b)` would delete nothing.
      this.expression(argument, !(operator === 'delete' && argument.type === 'ChainExpression'), opener)
    }
    if (operator !== '!' && operator !== 'void') this.unsafe()
  }

  // The target of an update or a compound assignment: its reference is evaluated, then read. An
  // identifier is a position only as the operand of an update.
  target (node, opener, update) {
    if (node.type === 'MemberExpression') {
      this.member(node, false, opener, false)
    } else if (update && node.type === 'Identifier') {
      this.position(node, opener)
    }
    this.unsafe()
  }

  assignment (node, opener) {
    this.position(node, opener)
    const { left, right, operator } = node
    if (left.type === 'ObjectPattern' || left.type === 'ArrayPattern') {
      // The value is evaluated before the pattern.
      this.expression(right, true, opener)
      this.unsafe()
      this.pattern(left, true)
      return
    }
    if (operator === '=') {
      if (left.type === 'MemberExpression') {
        this.member(left, false, opener, false)
        this.expression(right, true, null)
      } else if (isAnonymousFunctionDefinition(right)) {
        this.namedValue(right, opener, null)
      } else {
        this.expression(right, true, opener)
      }
      this.unsafe()
      return
    }
    this.target(left, opener, false)
    if (operator === '&&=' || operator === '||=' || operator === '??=') {
      const snapshot = this.branch()
      if (left.type === 'Identifier' && isAnonymousFunctionDefinition(right)) {
        this.namedValue(right, null, { kind: 'named', node: right, name: JSON.stringify(left.name) })
      } else {
        this.expression(right, true, null)
      }
      this.unsafe()
      this.merge(snapshot)
      return
    }
    this.expression(right, true, null)
    this.unsafe()
  }

  /**
   * A binding or assignment pattern, once its value is known.
   *
   * @param {object} node
   * @param {boolean} assign whether targets are assigned (true) or bound (false)
   */
  pattern (node, assign) {
    switch (node.type) {
      case 'Identifier':
        if (assign || this.inWith > 0) this.unsafe()
        return
      case 'MemberExpression':
        this.member(node, false, null, false)
        this.unsafe()
        return
      case 'ObjectPattern':
        this.unsafe()
        for (const property of node.properties) {
          if (property.type === 'RestElement') {
            this.pattern(property.argument, assign)
            continue
          }
          if (property.computed) this.expression(property.key, true, null)
          this.unsafe()
          this.pattern(property.value, assign)
        }
        return
      case 'ArrayPattern':
        this.unsafe()
        for (const element of node.elements) {
          if (element !== null) this.pattern(element, assign)
          this.unsafe()
        }
        return
      case 'RestElement':
        this.unsafe()
        this.pattern(node.argument, assign)
        return
      case 'AssignmentPattern': {
        const { left, right } = node
        if (left.type === 'MemberExpression') {
          this.member(left, false, null, false)
        }
        this.unsafe()
        const snapshot = this.branch()
        if (left.type === 'Identifier' && isAnonymousFunctionDefinition(right)) {
          this.namedValue(right, null, { kind: 'named', node: right, name: JSON.stringify(left.name) })
        } else {
          this.expression(right, true, null)
        }
        this.merge(snapshot)
        if (left.type === 'MemberExpression') this.unsafe()
        else this.pattern(left, assign)
        return
      }
      default:
        throw new Error(`Unsupported pattern ${node.type}`)
    }
  }

  // --- Output ---

  probeText (point) {
    const p = this.prefix
    let text = ''
    if (point.touch === TOUCH_IF_CLEAR) text = `${p}t||${p}r()`
    else if (point.touch === TOUCH_ALWAYS) text = `${p}r()`
    const masks = new Map()
    for (const slot of point.slots) {
      const word = Math.floor(slot / SLOTS_PER_WORD)
      masks.set(word, (masks.get(word) ?? 0) | (1 << (slot % SLOTS_PER_WORD)))
    }
    for (const [word, mask] of masks) text += `${text ? ',' : ''}${p}${word}|=${mask}`
    return text
  }

  insert (at, rank, text, node, sub = 0) {
    const spanStart = node ? node.start : at
    const spanEnd = node ? node.end : at
    this.edits.push({ at, end: at, rank, text, spanStart, spanEnd, sub, sequence: this.sequence++ })
  }

  replace (start, end, text) {
    const sequence = this.sequence++
    this.edits.push({ at: start, end, rank: RANK_REPLACE, text, spanStart: start, spanEnd: end, sub: 0, sequence })
  }

  emit () {
    const p = this.prefix
    for (const point of this.points) {
      if (point.slots.length === 0 && !point.touch) continue
      const probes = this.probeText(point)
      const { opener } = point
      const node = opener.node
      switch (opener.kind) {
        case 'prefix':
          this.insert(opener.at, RANK_PREFIX, `;${probes};`)
          break
        case 'slot':
          // Outside every edit on the statement's own expression.
          this.insert(node.start, RANK_OPENER, `{${probes};`, node, -1)
          this.insert(node.end, RANK_CLOSER, '}', node, 2)
          break
        case 'wrap':
          this.insert(node.start, RANK_OPENER, `(${probes},`, node)
          this.insert(node.end, RANK_CLOSER, ')', node, 1)
          break
        case 'after':
          this.insert(node.start, RANK_OPENER, `(${p}a(`, node, 1)
          this.insert(node.end, RANK_CLOSER, `,${probes}))`, node)
          break
        case 'keyed': {
          const property = node.property
          if (!node.optional) {
            const dot = this.dotBefore(node)
            this.replace(dot, dot + 1, ' ')
          }
          this.replace(property.start, property.end, `[(${probes},${JSON.stringify(property.name)})]`)
          break
        }
        case 'methodKey':
          this.replace(node.start, node.end, `[(${probes},${this.keyText(node)})]`)
          break
        case 'shorthand': {
          const key = node.name === '__proto__' ? '["__proto__"]' : node.name
          this.replace(node.start, node.end, `${key}:(${probes},${node.name})`)
          break
        }
        case 'declarator':
          this.insert(node.start, RANK_PREFIX, `${p}d${this.syntheticNames++}=(${probes},void 0),`)
          break
        case 'field': {
          const name = `${node.static ? 'static ' : ''}#${p}f${this.syntheticNames++}`
          this.insert(node.start, RANK_PREFIX, `;${name}=(${probes},void 0);`)
          break
        }
        case 'named':
          this.insert(node.start, RANK_OPENER, `(${probes},{[${opener.name}]:`, node)
          this.insert(node.end, RANK_CLOSER, `}[${opener.name}])`, node, 1)
          break
        default:
          throw new Error(`Unknown opener ${opener.kind}`)
      }
    }
  }

  // The `.` between a member's object and its property.
  dotBefore (node) {
    const code = this.code
    let i = node.object.end
    for (;;) {
      i = skipTrivia(code, i)
      if (code.charCodeAt(i) === 41) { // `)` closing a parenthesized object
        i++
        continue
      }
      return i
    }
  }

  // A statement that starts with an inserted `(` would continue the previous line's expression.
  guardStatementStarts () {
    const first = new Map()
    for (const edit of this.edits) {
      if (edit.at !== edit.end) continue
      const current = first.get(edit.at)
      if (current === undefined || compareEdits(edit, current) < 0) first.set(edit.at, edit)
    }
    for (const { node, where } of this.expressionStatements) {
      const edit = first.get(node.start)
      if (edit === undefined || edit.rank !== RANK_OPENER || edit.text[0] !== '(') continue
      if (where === LIST) {
        this.insert(node.start, RANK_PREFIX, ';')
      } else if (where === SLOT) {
        this.insert(node.start, RANK_OPENER, '{', { start: node.start, end: Infinity })
        this.insert(node.end, RANK_CLOSER, '}', { start: -Infinity, end: node.end })
      }
    }
  }

  // Declares the slot words, the touch function and the reader. The functions are hoisted, so code
  // that runs before the header (hoisted functions called through a circular require) works. The
  // first touch gives the collector the module's key and slot table, and keeps the id it returns:
  // the code does not depend on the process that instrumented it, so it can be cached. The reader
  // writes the module id into `o`, then a word index and its bits for each word with slots that
  // ran, clears them, and returns the number of entries it wrote. It returns 0 when it already ran
  // for boundary `g`. Given null for `o`, it only clears the touched flag, and returns the module id.
  header (words) {
    const p = this.prefix
    let reader = `function ${p}x(o,g){if(o===null){${p}t=0;return ${p}m}` +
      `if(${p}g===g)return 0;${p}g=g;o[0]=${p}m;var n=1;`
    // The id has no initialiser, so the header keeps one that a touch before it set.
    let names = `${p}t=0,${p}g=0,${p}c,${p}m`
    for (const word of words) {
      reader += `if(${p}${word}){o[n++]=${word};o[n++]=${p}${word};${p}${word}=0}`
      // Starting at 0 keeps `|=` on small integers.
      names += `,${p}${word}=0`
    }
    reader += `${p}t=0;return n}`
    const touch = `function ${p}r(){var c=${p}c||(${p}c=globalThis[Symbol.for('dd-trace.line-coverage')]);` +
      `if(c){if(${p}m===void 0)${p}m=${p}d(c);${p}t=c.touch(${p}m,${p}x)}else ${p}t=1}`
    const define = `function ${p}d(c){return c.define(${this.describe()})}`
    // Passes a value on, so probes can run right after the expression that computes it.
    const identity = `function ${p}a(v){return v}`
    return `;var ${names};${touch}${define}${reader}${identity}`
  }

  // The arguments of the collector's `define`: the module key, the sources as JSON, the line of each
  // slot, negated for initialiser lines, and, when slots come from more than one source, the source
  // of each slot. The tables are strings, one token for the compiler and nothing to allocate for each
  // copy of the module; the collector parses them once per module key.
  describe () {
    let lines = ''
    let sources = ''
    let several = false
    for (let i = 0; i < this.slots.length; i++) {
      const { source, line, init } = this.slots[i]
      const separator = i === 0 ? '' : ','
      lines += separator + (init ? -line : line)
      sources += separator + source
      if (source !== 0) several = true
    }
    let text = `${JSON.stringify(this.moduleKey)},${JSON.stringify(JSON.stringify(this.sources))},"${lines}"`
    if (several) text += `,"${sources}"`
    return text
  }
}

/**
 * Whether functions passed to a call of `callee` run as a job of their own.
 *
 * @param {object} callee
 */
function startsJobs (callee) {
  if (callee.type === 'MemberExpression') {
    return !callee.computed && callee.property.type === 'Identifier' && JOB_METHODS.has(callee.property.name)
  }
  return callee.type === 'Identifier' && callee.name === 'queueMicrotask'
}

function compareEdits (a, b) {
  return a.at - b.at ||
    a.rank - b.rank ||
    (a.rank === RANK_CLOSER
      ? b.spanStart - a.spanStart || a.sub - b.sub
      : a.rank === RANK_OPENER ? b.spanEnd - a.spanEnd || a.sub - b.sub : 0) ||
    a.sequence - b.sequence
}

function applyEdits (code, edits) {
  edits.sort(compareEdits)
  let out = ''
  let last = 0
  for (const edit of edits) {
    if (edit.at < last) throw new Error('Overlapping edits')
    out += code.slice(last, edit.at) + edit.text
    last = edit.end
  }
  return out + code.slice(last)
}

function isField (element) {
  return element.type === 'PropertyDefinition' || element.type === 'AccessorProperty'
}

// A constructor or private method has no key to probe in.
function hasHeaderWithoutKey (method) {
  return method.kind === 'constructor' || method.key.type === 'PrivateIdentifier'
}

function isAnonymousFunctionDefinition (node) {
  const type = node.type
  return type === 'ArrowFunctionExpression' ||
    ((type === 'FunctionExpression' || type === 'ClassExpression') && !node.id)
}

// `__proto__: value` sets the prototype and does not name the value.
function isProtoSetter (property) {
  const key = property.key
  return !property.computed && !property.shorthand &&
    ((key.type === 'Identifier' && key.name === '__proto__') || (key.type === 'Literal' && key.value === '__proto__'))
}

// Whether the spine of a chain part holds an optional link (`?.`).
function hasOptionalLink (node) {
  for (;;) {
    if (node.type === 'MemberExpression') {
      if (node.optional) return true
      node = node.object
    } else if (node.type === 'CallExpression') {
      if (node.optional) return true
      node = node.callee
    } else {
      return false
    }
  }
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

// A probe for a list statement goes right after the previous token when only whitespace sits
// between them, which keeps the statement's own columns, and right before the statement otherwise.
function listInsertOffset (code, start, floor) {
  for (let i = floor; i < start; i++) {
    const c = code.charCodeAt(i)
    if (c !== 32 && c !== 9 && c !== 10 && c !== 13) return start
  }
  return floor
}

// Offset of the first character after whitespace and comments.
function skipTrivia (code, offset) {
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

function isLineBreak (c) {
  return c === 10 || c === 13 || c === 0x20_28 || c === 0x20_29
}

function choosePrefix (code) {
  let prefix = '$dd$'
  let n = 0
  while (code.includes(prefix)) prefix = `$dd${++n}$`
  return prefix
}

// 1-based line of `offset`, given the offsets at which lines start.
function lineAt (starts, offset) {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if (starts[middle] <= offset) low = middle
    else high = middle - 1
  }
  return low + 1
}

function getNewlineStarts (code) {
  const starts = [0]
  let index = code.indexOf('\n')
  while (index !== -1) {
    starts.push(index + 1)
    index = code.indexOf('\n', index + 1)
  }
  return starts
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
    if (key === 'type' || key === 'start' || key === 'end' || key === 'range' || key === 'loc') continue
    const value = node[key]
    if (value && typeof value === 'object' && containsSuspension(value)) return true
  }
  return false
}

module.exports = { instrument }
