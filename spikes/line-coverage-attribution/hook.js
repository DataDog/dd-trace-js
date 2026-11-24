'use strict'
// Preload for the attribution spike. Inserts a context check at every function entry and every
// await/yield resumption of repo code that runs through vm.Script (Jest), then either only checks
// (SPIKE_MODE=b, the cost of design B) or also simulates design A's check points and counts the
// entries where A would credit a different test than B sees (SPIKE_MODE=gap).
// Load after dd-trace: NODE_OPTIONS="-r <dd-trace>/ci/init -r <this file>".

const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const dc = require('node:diagnostics_channel')

const DD = process.env.SPIKE_DD_ROOT
const ROOT = fs.realpathSync(process.env.SPIKE_REPO_ROOT || process.cwd()) + path.sep
const MODE = process.env.SPIKE_MODE || 'b'
const OUT = process.env.SPIKE_OUT
const { storage } = require(path.join(DD, 'packages/datadog-core/src/storage.js'))
const { parseSync } = require(path.join(DD, 'node_modules/oxc-parser'))
const legacy = storage('legacy')

const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'])
const fnModule = [] // function id -> module id
const fnInfo = [] // function id -> "file:line" and its line span
const moduleNames = []
let parseFailures = 0

function lineOf (starts, offset) {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= offset) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

function instrument (code, filename) {
  let program
  try {
    const result = parseSync(filename + '.js', code, { sourceType: 'script', preserveParens: true })
    if (result.errors.length) { parseFailures++; return code }
    program = result.program
  } catch { parseFailures++; return code }
  const moduleId = moduleNames.push(path.relative(ROOT, filename)) - 1
  const starts = [0]
  for (let i = 0; i < code.length; i++) if (code.charCodeAt(i) === 10) starts.push(i + 1)
  const inserts = []
  const visit = (node, inGenerator) => {
    if (!node || typeof node.type !== 'string') return
    if (FUNCTIONS.has(node.type) && node.body) {
      const id = fnModule.push(moduleId) - 1
      const first = lineOf(starts, node.start)
      fnInfo.push([`${moduleNames[moduleId]}:${first}`, lineOf(starts, node.end) - first + 1])
      const body = node.body
      if (body.type === 'BlockStatement' || body.type === 'FunctionBody') {
        let at = body.start + 1
        for (const s of body.body ?? body.statements ?? []) {
          if (s.type === 'ExpressionStatement' && s.directive !== undefined && s.directive !== null) at = s.end
          else break
        }
        // The outermost function (Jest's module wrapper) binds the checks once per module, so each
        // check is a closure-slot load rather than a global lookup through the vm context.
        const bind = outermost ? 'var __ddckL=__ddck,__ddrsL=__ddrs;' : ''
        outermost = false
        inserts.push([at, `${bind}__ddckL(${id});`])
      } else {
        inserts.push([body.start, `(__ddckL(${id}),`], [body.end, ')'])
      }
      for (const p of node.params ?? []) visit(p, node.generator)
      visitChildren(body, node.generator, id)
      return
    }
    if (node.type === 'AwaitExpression' || node.type === 'YieldExpression') {
      inserts.push([node.start, '__ddrsL('], [node.end, `,${currentFn})`])
    }
    visitChildren(node, inGenerator, currentFn)
  }
  let currentFn = -1
  let outermost = true
  const visitChildren = (node, inGenerator, fnId) => {
    const saved = currentFn
    currentFn = fnId
    for (const key in node) {
      if (key === 'type' || key === 'start' || key === 'end') continue
      const value = node[key]
      if (Array.isArray(value)) { for (const v of value) if (v && typeof v === 'object') visit(v, inGenerator) } else if (value && typeof value === 'object') visit(value, inGenerator)
    }
    currentFn = saved
  }
  visitChildren(program, false, -1)
  // Stable descending order; at equal offsets a closing ')' goes before a new opening text.
  inserts.sort((a, b) => b[0] - a[0] || (a[1] === ')' ? 1 : 0) - (b[1] === ')' ? 1 : 0))
  let out = code
  for (const [at, text] of inserts) out = out.slice(0, at) + text + out.slice(at)
  return out
}

function shouldInstrument (filename) {
  return typeof filename === 'string' && filename.startsWith(ROOT) && !filename.includes('/node_modules/')
}

// --- checks -------------------------------------------------------------------------------------
let last = {}
let lastTest = null
let entries = 0
let resumptions = 0
let switches = 0
let testSwitches = 0
function testOf (store) {
  const span = store?.span
  return span ? span.context()._trace : null
}
function observe () {
  const s = legacy.getHandle()
  if (s !== last) {
    last = s
    switches++
    const t = testOf(s)
    if (t !== lastTest) { lastTest = t; testSwitches++ }
  }
  return lastTest
}

// Design A: per module, the test seen at the module's last check (its first entry in the window,
// or a resumption inside it). A gap is an unchecked entry whose real test differs from that one.
// A' is A with every module's flag also reset at each macrotask start.
let entered = new Map()
let enteredMacro = new Map()
let gapEntries = 0
let gapEntriesMacro = 0
let gapToShared = 0 // A believed a test, the code ran with no test
let gapFromShared = 0 // A believed no test, the code ran for a test
let gapTestToTest = 0
const gapFunctions = new Map() // function id -> count
const gapTests = new Set()
let windows = 0
let macrotasks = 0
// A'' marks a module only when its check sees the window's test, so entries from other contexts
// keep checking; A''M also resets at every macrotask start. checksH counts A'''s checks.
let enteredH = new Map()
let enteredHM = new Map()
let windowTest = null
let gapH = 0
let gapHM = 0
let checksH = 0
function boundary (message, name) {
  entered = new Map(); enteredMacro = new Map(); enteredH = new Map(); enteredHM = new Map(); windows++
  windowTest = name === 'ci:jest:test:start' ? (message?.currentStore?.span?.context()._trace ?? null) : null
}
function stepH (map, m, t) {
  if (!map.has(m)) { if (t === windowTest) map.set(m, t); return 1 }
  if (map.get(m) !== t) return -1
  return 0
}

function ckB (f) { observe() }
function rsB (value, f) { observe(); return value }
// Decision 16: a line belongs to T only inside T's window, in a context carrying T; else Shared.
function truth () {
  const t = observe()
  if (t === windowTest) return t
  if (t) outsideWindow++
  return null
}
let outsideWindow = 0 // entries whose context carries a test other than the window's (Shared)
function ckGap (f) {
  entries++
  const t = truth()
  const m = fnModule[f]
  const h = stepH(enteredH, m, t)
  if (h === 1) checksH++
  else if (h === -1) gapH++
  if (stepH(enteredHM, m, t) === -1) gapHM++
  if (!enteredMacro.has(m)) enteredMacro.set(m, t)
  else if (enteredMacro.get(m) !== t) gapEntriesMacro++
  if (!entered.has(m)) { entered.set(m, t); return }
  const believed = entered.get(m)
  if (t !== believed) {
    gapEntries++
    if (!t) gapToShared++
    else if (!believed) gapFromShared++
    else gapTestToTest++
    gapFunctions.set(f, (gapFunctions.get(f) || 0) + 1)
    if (believed) gapTests.add(believed)
    if (t) gapTests.add(t)
  }
}
function rsGap (value, f) {
  resumptions++
  const t = truth()
  if (f >= 0) {
    const m = fnModule[f]
    entered.set(m, t); enteredMacro.set(m, t)
    for (const map of [enteredH, enteredHM]) { if (t === windowTest) map.set(m, t); else map.delete(m) }
  }
  return value
}

if (MODE === 'gap') {
  // Macrotask starts: an async_hooks `before` for any resource that is not a promise.
  const asyncHooks = require('node:async_hooks')
  const macroIds = new Set()
  asyncHooks.createHook({
    init (id, type) { if (type !== 'PROMISE') macroIds.add(id) },
    before (id) { if (macroIds.has(id)) { macrotasks++; enteredMacro = new Map(); enteredHM = new Map() } },
    destroy (id) { macroIds.delete(id) },
  }).enable()
}

// C: the addon says whether V8's continuation-preserved embedder data changed identity since its
// last call; only then is the store read.
const cped = MODE === 'c' ? require(process.env.SPIKE_ADDON) : undefined
function ckC (f) { if (cped.changed() === 1) observe() }
function rsC (value, f) { if (cped.changed() === 1) observe(); return value }

const ck = MODE === 'gap' ? ckGap : MODE === 'c' ? ckC : ckB
const rs = MODE === 'gap' ? rsGap : MODE === 'c' ? rsC : rsB
globalThis.__ddck = ck
globalThis.__ddrs = rs

if (MODE === 'gap') {
  dc.subscribe('ci:jest:test:start', boundary)
  dc.subscribe('ci:jest:test:finish', boundary)
}

// --- vm.Script hook -----------------------------------------------------------------------------
const OriginalScript = vm.Script
class Script extends OriginalScript {
  constructor (code, options) {
    const filename = typeof options === 'string' ? options : options?.filename
    if (process.env.SPIKE_DEBUG) fs.appendFileSync(process.env.SPIKE_DEBUG, `${process.pid} ${filename}\n`)
    super(shouldInstrument(filename) ? instrument(code, filename) : code, options)
  }

  runInContext (context, options) {
    if (context && context.__ddck !== ck) { context.__ddck = ck; context.__ddrs = rs }
    return super.runInContext(context, options)
  }
}
vm.Script = Script

// Jest kills its workers with a signal, so the stats are also written after every test.
if (MODE === 'gap') dc.subscribe('ci:jest:test:finish', () => writeStats())
process.on('exit', writeStats)
function writeStats () {
  if (!OUT) return
  const top = [...gapFunctions].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([f, n]) => [fnInfo[f][0], n])
  let gapLineSpan = 0
  for (const f of gapFunctions.keys()) gapLineSpan += fnInfo[f][1]
  fs.writeFileSync(path.join(OUT, `${MODE}-${process.pid}.json`), JSON.stringify({
    pid: process.pid,
    mode: MODE,
    modules: moduleNames.length,
    functions: fnModule.length,
    parseFailures,
    entries,
    resumptions,
    switches,
    testSwitches,
    windows,
    macrotasks,
    gapEntries,
    gapEntriesMacro,
    outsideWindow,
    gapH,
    gapHM,
    checksH,
    gapToShared,
    gapFromShared,
    gapTestToTest,
    gapFunctions: gapFunctions.size,
    gapFunctionLineSpan: gapLineSpan,
    gapTests: gapTests.size,
    top,
  }))
}
