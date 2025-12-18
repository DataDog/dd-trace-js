'use strict'

const fs = require('node:fs')
const path = require('node:path')

const meriyah = require('../vendor/dist/meriyah')

const NODE_ASSERT_COMPATIBLE_METHODS = new Set([
  'strictEqual',
  'deepStrictEqual',
  'notStrictEqual',
  'notDeepStrictEqual',
  'ok',
  'fail',
  'match',
  'doesNotMatch',
  'throws',
  'doesNotThrow',
  'rejects',
  'doesNotReject',
  'ifError'
])

/**
 * @typedef {{ start: number, end: number, replacement: string }} Replacement
 */

/**
 * @typedef {{ unsupported: boolean, keepChaiImport: boolean, requiredHelpers: Set<string> }} TransformState
 */

const argv = process.argv.slice(2)
const flags = new Set(argv.filter(a => a.startsWith('--')))
const positional = argv.filter(a => !a.startsWith('--'))

const shouldWrite = flags.has('--write')
const shouldCheck = flags.has('--check')
const shouldListRemaining = flags.has('--list-remaining')

if (flags.has('--help') || flags.has('-h')) {
  printUsage()
  process.exit(0)
}

/** @type {string} */
const repoRoot = path.join(__dirname, '..')

const files = positional.length > 0
  ? positional.map(p => path.resolve(process.cwd(), p))
  : findCandidateFiles(repoRoot)

const results = {
  filesVisited: 0,
  filesWithChai: 0,
  filesModified: 0,
  filesUnchanged: 0,
  filesFailed: 0,
  chaiRequiresRemaining: 0,
  warnings: 0
}

/** @type {{ file: string, message: string }[]} */
const warnings = []
/** @type {{ file: string, error: unknown }[]} */
const failures = []
/** @type {string[]} */
const remaining = []

/**
 * Best-effort detection for actual `require('chai')` calls, avoiding false-positives like
 * `"require('chai')"` in strings.
 * @param {string} src
 * @returns {boolean}
 */
function hasRealChaiRequire (src) {
  const re = /require\s*\(\s*(['"])chai\1\s*\)/g
  let m
  while ((m = re.exec(src)) !== null) {
    const idx = m.index
    const prev = idx > 0 ? src[idx - 1] : ''
    if (prev === '"' || prev === "'" || prev === '`') continue
    return true
  }
  return false
}

for (const file of files) {
  results.filesVisited++
  let src
  try {
    src = fs.readFileSync(file, 'utf8')
  } catch (e) {
    failures.push({ file, error: e })
    results.filesFailed++
    continue
  }

  if (!hasRealChaiRequire(src)) {
    results.filesUnchanged++
    continue
  }

  const out = transformFile(src, file)

  for (const w of out.warnings) warnings.push({ file, message: w })

  if (out.failed) {
    failures.push({ file, error: out.failed })
    results.filesFailed++
    continue
  }

  // Some files include `require('chai')` inside generated-code strings; only count real Chai assertion imports.
  if (!out.usesChaiAssertions) {
    results.filesUnchanged++
    continue
  }

  results.filesWithChai++

  if (out.changed) {
    results.filesModified++
    if (shouldWrite) {
      fs.writeFileSync(file, out.code, 'utf8')
    }
  } else {
    results.filesUnchanged++
  }

  if (hasRealChaiRequire(out.code)) {
    results.chaiRequiresRemaining++
    if (shouldListRemaining) remaining.push(path.relative(repoRoot, file))
  }
}

results.warnings = warnings.length

if (warnings.length > 0) {
  for (const w of warnings) {
    // eslint-disable-next-line no-console
    console.warn(`[chai-to-assert][warn] ${path.relative(repoRoot, w.file)}: ${w.message}`)
  }
}

if (failures.length > 0) {
  for (const f of failures) {
    const err = f.error
    const errText = err instanceof Error ? String(err.stack || err.message) : String(err)
    // eslint-disable-next-line no-console
    console.error(`[chai-to-assert][error] ${path.relative(repoRoot, f.file)}: ${errText}`)
  }
}

// eslint-disable-next-line no-console
console.log(JSON.stringify({
  ...results,
  mode: shouldWrite ? 'write' : shouldCheck ? 'check' : 'dry-run'
}, null, 2))

if (shouldListRemaining && remaining.length > 0) {
  for (const f of remaining) {
    // eslint-disable-next-line no-console
    console.log(`[chai-to-assert][remaining] ${f}`)
  }
}

if (shouldCheck) {
  process.exitCode = results.chaiRequiresRemaining === 0 && results.filesFailed === 0 ? 0 : 1
} else if (!shouldWrite) {
  // In dry-run mode, exit non-zero if we would leave chai requires behind (useful for CI checks).
  process.exitCode = results.chaiRequiresRemaining === 0 && results.filesFailed === 0 ? 0 : 1
}

/**
 * @returns {void}
 */
function printUsage () {
  // eslint-disable-next-line no-console
  console.log(`
Usage:
  node scripts/chai-to-assert.js [--write|--check] [fileOrDir...]

Modes:
  --write   Apply edits in-place
  --check   Exit non-zero if any \`require('chai')\` remains (no writes)
  --list-remaining  Print files that would still contain a real \`require('chai')\` after the transform

Notes:
  - Only rewrites Chai-based assertions (files that explicitly \`require('chai')\`).
  - Uses range-based edits via meriyah AST parsing to keep formatting stable.
`.trim())
}

/**
 * @param {string} root
 * @returns {string[]}
 */
function findCandidateFiles (root) {
  /** @type {string[]} */
  const out = []

  /** @param {string} dir */
  function walk (dir) {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name)

      if (entry.isDirectory()) {
        // Skip hidden directories (caches, tooling, etc).
        if (entry.name.startsWith('.')) continue

        if (entry.name === '.git' ||
          entry.name === 'node_modules' ||
          (entry.name === 'packages' && dir === root) // avoid descending twice; we will include packages explicitly
        ) {
          // Still traverse packages itself, but skip root node_modules.
          if (entry.name === 'packages' && dir === root) {
            walk(full)
          }
          continue
        }

        // Skip vendored dependencies; we never want to rewrite them.
        if (entry.name === 'node_modules' && dir.endsWith(path.join('packages'))) continue
        if (full.includes(path.join('packages', 'node_modules'))) continue

        walk(full)
        continue
      }

      if (!entry.isFile()) continue
      if (!full.endsWith('.js')) continue

      out.push(full)
    }
  }

  walk(root)
  return out
}

/**
 * @param {string} code
 * @param {string} filename
 * @returns {{ usesChaiAssertions: boolean, changed: boolean, code: string, warnings: string[], failed?: unknown }}
 */
function transformFile (code, filename) {
  /** @type {string[]} */
  const warnings = []

  // Special-case: this file only exists to configure Chai/sinon-chai for tests.
  // Once we migrate off Chai assertions, we keep the env var behavior and drop chai setup.
  if (filename.endsWith(path.join('packages', 'dd-trace', 'test', 'setup', 'core.js'))) {
    const out = transformDdTraceSetupCore(code)
    return { usesChaiAssertions: true, changed: out !== code, code: out, warnings }
  }

  /** @type {ReturnType<typeof meriyah.parseScript> | null} */
  let ast = null
  try {
    ast = meriyah.parseScript(code, {
      ranges: true,
      loc: true,
      next: true,
      lexical: true,
      webcompat: true
    })
  } catch (e) {
    return { usesChaiAssertions: false, changed: false, code, warnings, failed: e }
  }

  const ctx = buildFileContext(code, ast)
  const usesChaiAssertions = ctx.expectNames.size > 0 ||
    ctx.chaiAssertNames.size > 0 ||
    ctx.chaiImportStatements.length > 0

  const state = {
    unsupported: false,
    keepChaiImport: false,
    requiredHelpers: new Set()
  }

  /** @type {Replacement[]} */
  const replacements = []

  // 1) Rewrite chai assertions (expect + chai assert)
  processNode(ast, ctx, state, replacements, warnings)

  if (state.unsupported) {
    // Fail-safe: do not partially migrate a file and accidentally remove the Chai require.
    return { usesChaiAssertions, changed: false, code, warnings }
  }

  // 2) Remove chai requires if now unused (we only remove known chai import forms)
  if (!state.keepChaiImport && ctx.chaiImportStatements.length > 0) {
    for (const stmt of ctx.chaiImportStatements) {
      replacements.push({
        start: stmt.start,
        end: stmt.end,
        replacement: ''
      })
    }
  }

  // 3) Ensure node:assert/strict import exists if we emitted any assert usage
  const HELPERS_THAT_NEED_ASSERT = new Set([
    'assertIsProfile'
  ])

  const needsAssert = [...state.requiredHelpers].some(h => HELPERS_THAT_NEED_ASSERT.has(h)) ||
    replacements.some(r => hasBareAssertUsage(r.replacement))

  let out = applyReplacements(code, replacements, warnings)

  if (needsAssert && !ctx.hasNodeAssertStrict) {
    out = ensureNodeAssertStrict(out)
  }

  out = ensureHelpers(out, state.requiredHelpers)

  return { usesChaiAssertions, changed: out !== code, code: out, warnings }
}

/**
 * Whether the string contains a usage of `assert.*` or `assert(...)` that is not
 * a member access like `sinon.assert.*` or `foo.assert(...)`.
 * @param {string} s
 * @returns {boolean}
 */
function hasBareAssertUsage (s) {
  if (!s) return false

  // Require a non-identifier/dot prefix so we don't match `sinon.assert.*`.
  const dot = /(^|[^.\w$])assert\./
  const call = /(^|[^.\w$])assert\s*\(/
  return dot.test(s) || call.test(s)
}

/**
 * Drop Chai/sinon-chai setup from `packages/dd-trace/test/setup/core.js` while keeping env var behavior.
 * @param {string} code
 * @returns {string}
 */
function transformDdTraceSetupCore (code) {
  const lines = code.split('\n')
  const out = []
  for (const line of lines) {
    if (line.includes("require('chai')") || line.includes('require("chai")')) continue
    if (line.includes("require('sinon-chai')") || line.includes('require("sinon-chai")')) continue
    if (/^\s*chai\.use\(/.test(line)) continue
    out.push(line)
  }

  // Keep whitespace as-is; only remove the specific lines above.
  return out.join('\n')
}

/**
 * @param {string} code
 * @param {Replacement[]} replacements
 * @param {string[]} warnings
 * @returns {string}
 */
function applyReplacements (code, replacements, warnings) {
  if (replacements.length === 0) return code

  // Ensure no overlaps (defensive)
  const sortedAsc = [...replacements].sort((a, b) => a.start - b.start || a.end - b.end)
  for (let i = 1; i < sortedAsc.length; i++) {
    const prev = sortedAsc[i - 1]
    const cur = sortedAsc[i]
    if (cur.start < prev.end) {
      warnings.push(
        `overlapping replacements detected at ${cur.start}-${cur.end} ` +
          `(prev ${prev.start}-${prev.end}), skipping file`
      )
      return code
    }
  }

  // Apply from end → start so indices stay valid
  const sorted = [...replacements].sort((a, b) => b.start - a.start || b.end - a.end)
  let out = code
  for (const r of sorted) {
    out = out.slice(0, r.start) + r.replacement + out.slice(r.end)
  }
  return out
}

/**
 * @param {string} code
 * @returns {string}
 */
function ensureNodeAssertStrict (code) {
  if (code.includes("require('node:assert/strict')") || code.includes('require("node:assert/strict")')) return code

  // Insert after 'use strict' if present; else insert at top.
  const strictRe = /^(['"])use strict\1\s*\n/
  const m = code.match(strictRe)
  if (m) {
    const insertAt = m[0].length
    const afterStrict = code.slice(insertAt)
    const prefix = code.slice(0, insertAt)
    const insertion = '\nconst assert = require(\'node:assert/strict\')\n'
    return prefix + insertion + afterStrict
  }

  return 'const assert = require(\'node:assert/strict\')\n\n' + code
}

/**
 * @param {string} code
 * @param {Set<string>} requiredHelpers
 * @returns {string}
 */
function ensureHelpers (code, requiredHelpers) {
  if (!requiredHelpers || requiredHelpers.size === 0) return code

  const needed = new Set(requiredHelpers)
  if (needed.has('getNestedProperty')) needed.add('hasNestedProperty')

  const blocks = []

  if (needed.has('escapeRegExp') && !/function\s+escapeRegExp\b/.test(code)) {
    blocks.push(`
function escapeRegExp (s) {
  return String(s).replace(/[.*+?^$(){}|[\\]\\\\]/g, '\\\\$&')
}`.trim())
  }

  if (needed.has('hasNestedProperty') && !/function\s+hasNestedProperty\b/.test(code)) {
    blocks.push(`
function hasNestedProperty (obj, path) {
  if (obj == null) return false
  if (typeof path !== 'string') return false

  const parts = path.split('.')
  let cur = obj
  for (const part of parts) {
    if (cur == null || !Object.hasOwn(cur, part)) return false
    cur = cur[part]
  }

  return true
}`.trim())
  }

  if (needed.has('getNestedProperty') && !/function\s+getNestedProperty\b/.test(code)) {
    blocks.push(`
function getNestedProperty (obj, path) {
  if (obj == null) return undefined
  if (typeof path !== 'string') return undefined

  const parts = path.split('.')
  let cur = obj
  for (const part of parts) {
    if (cur == null || !Object.hasOwn(cur, part)) return undefined
    cur = cur[part]
  }

  return cur
}`.trim())
  }

  if (needed.has('assertIsProfile') && !/function\s+assertIsProfile\b/.test(code)) {
    blocks.push(`
function assertIsProfile (obj, msg) {
  assert.ok(typeof obj === 'object' && obj !== null, msg)
  assert.strictEqual(typeof obj.timeNanos, 'bigint', msg)
  assert.ok(typeof obj.period === 'number' || typeof obj.period === 'bigint', msg)

  assertIsValueType(obj.periodType, msg)

  assert.ok(Array.isArray(obj.sampleType), msg)
  assert.strictEqual(obj.sampleType.length, 2, msg)
  assert.ok(Array.isArray(obj.sample), msg)
  assert.ok(Array.isArray(obj.location), msg)
  assert.ok(Array.isArray(obj.function), msg)

  assert.ok(typeof obj.stringTable === 'object' && obj.stringTable !== null, msg)
  assert.ok(Array.isArray(obj.stringTable.strings), msg)
  assert.ok(obj.stringTable.strings.length >= 1, msg)
  assert.strictEqual(obj.stringTable.strings[0], '', msg)

  for (const sampleType of obj.sampleType) {
    assertIsValueType(sampleType, msg)
  }

  for (const fn of obj.function) {
    assert.strictEqual(typeof fn.filename, 'number', msg)
    assert.strictEqual(typeof fn.systemName, 'number', msg)
    assert.strictEqual(typeof fn.name, 'number', msg)
    assert.ok(Number.isSafeInteger(fn.id), msg)
  }

  for (const location of obj.location) {
    assert.ok(Number.isSafeInteger(location.id), msg)
    assert.ok(Array.isArray(location.line), msg)

    for (const line of location.line) {
      assert.ok(Number.isSafeInteger(line.functionId), msg)
      assert.strictEqual(typeof line.line, 'number', msg)
    }
  }

  for (const sample of obj.sample) {
    assert.ok(Array.isArray(sample.locationId), msg)
    assert.ok(sample.locationId.length >= 1, msg)
    assert.ok(Array.isArray(sample.value), msg)
    assert.strictEqual(sample.value.length, obj.sampleType.length, msg)
  }

  function assertIsValueType (valueType, msg) {
    assert.ok(typeof valueType === 'object' && valueType !== null, msg)
    assert.strictEqual(typeof valueType.type, 'number', msg)
    assert.strictEqual(typeof valueType.unit, 'number', msg)
  }
}`.trim())
  }

  if (blocks.length === 0) return code

  // Preserve any existing trailing whitespace exactly; insert helpers before it.
  const m = code.match(/\s*$/)
  const trailing = m ? m[0] : ''
  const base = code.slice(0, code.length - trailing.length)

  const sep = base.length === 0
    ? ''
    : base.endsWith('\n\n')
      ? ''
      : base.endsWith('\n')
        ? '\n'
        : '\n\n'

  return base + sep + blocks.join('\n\n') + trailing
}

/**
 * @typedef {{
 *   source: string,
 *   expectNames: Set<string>,
 *   chaiAssertNames: Set<string>,
 *   chaiImportStatements: any[],
 *   hasNodeAssertStrict: boolean,
 *   hasSinon: boolean,
 *   hasAssertObjectContains: boolean
 * }} FileContext
 */

/**
 * @param {string} source
 * @param {any} ast
 * @returns {FileContext}
 */
function buildFileContext (source, ast) {
  const expectNames = new Set()
  const chaiAssertNames = new Set()
  const chaiImportStatements = []

  let hasNodeAssertStrict = false
  let hasSinon = false
  let hasAssertObjectContains = false

  for (const stmt of ast.body) {
    if (stmt.type !== 'VariableDeclaration') continue
    for (const decl of stmt.declarations) {
      if (!decl || decl.type !== 'VariableDeclarator') continue
      const init = decl.init
      if (!init) continue

      if (isRequireCall(init, 'node:assert/strict')) {
        hasNodeAssertStrict = true
      }

      if (isRequireCall(init, 'sinon')) {
        if (decl.id && decl.id.type === 'Identifier') hasSinon = true
      }

      if (isRequireCall(init, 'chai')) {
        if (decl.id && decl.id.type === 'ObjectPattern') {
          let hasRelevant = false
          for (const prop of decl.id.properties) {
            if (!prop || prop.type !== 'Property') continue
            const key = prop.key
            const val = prop.value
            if (!key || key.type !== 'Identifier') continue
            if (!val) continue
            if (key.name === 'expect' && val.type === 'Identifier') {
              expectNames.add(val.name)
              hasRelevant = true
            }
            if (key.name === 'assert' && val.type === 'Identifier') {
              chaiAssertNames.add(val.name)
              hasRelevant = true
            }
          }

          // Only remove Chai imports that are purely for assertions.
          if (hasRelevant) chaiImportStatements.push(stmt)
        }
      }

      // Support `const expect = require('chai').expect` / `const chaiAssert = require('chai').assert`
      if (init && init.type === 'MemberExpression' && isRequireCall(init.object, 'chai')) {
        const propName = memberPropertyName(init)
        if (propName && decl.id && decl.id.type === 'Identifier') {
          if (propName === 'expect') {
            expectNames.add(decl.id.name)
            if (stmt.declarations.length === 1) chaiImportStatements.push(stmt)
          }
          if (propName === 'assert') {
            chaiAssertNames.add(decl.id.name)
            if (stmt.declarations.length === 1) chaiImportStatements.push(stmt)
          }
        }
      }

      // Detect assertObjectContains import from integration-tests/helpers (common in this repo)
      if (isRequireCall(init, '../../../integration-tests/helpers') ||
        isRequireCall(init, '../../integration-tests/helpers') ||
        isRequireCall(init, '../helpers') ||
        isRequireCall(init, '../../helpers') ||
        isRequireCall(init, './helpers') ||
        isRequireCall(init, '../..//helpers') // defensive typo
      ) {
        if (decl.id && decl.id.type === 'ObjectPattern') {
          for (const prop of decl.id.properties) {
            if (!prop || prop.type !== 'Property') continue
            const key = prop.key
            const val = prop.value
            if (!key || key.type !== 'Identifier') continue
            if (key.name !== 'assertObjectContains') continue
            if (val && val.type === 'Identifier') hasAssertObjectContains = true
          }
        }
      }
    }
  }

  // Fast path: file may already use sinon without require (rare); fall back to textual check.
  if (!hasSinon && /\bsinon\b/.test(source)) {
    hasSinon = /\brequire\(['"]sinon['"]\)/.test(source)
  }

  if (source.includes('assertObjectContains')) hasAssertObjectContains = true

  return {
    source,
    expectNames,
    chaiAssertNames,
    chaiImportStatements,
    hasNodeAssertStrict,
    hasSinon,
    hasAssertObjectContains
  }
}

/**
 * @param {any} node
 * @param {string} moduleName
 * @returns {boolean}
 */
function isRequireCall (node, moduleName) {
  return node &&
    node.type === 'CallExpression' &&
    node.callee &&
    node.callee.type === 'Identifier' &&
    node.callee.name === 'require' &&
    node.arguments &&
    node.arguments.length === 1 &&
    node.arguments[0] &&
    node.arguments[0].type === 'Literal' &&
    node.arguments[0].value === moduleName
}

/**
 * @param {any} node
 * @param {FileContext} ctx
 * @param {TransformState} state
 * @param {Replacement[]} replacements
 * @param {string[]} warnings
 */
function processNode (node, ctx, state, replacements, warnings) {
  if (!node || typeof node !== 'object') return

  switch (node.type) {
    case 'Program':
      processStatementList(node.body, ctx, state, replacements, warnings)
      return
    case 'BlockStatement':
      processStatementList(node.body, ctx, state, replacements, warnings)
      return
    case 'SwitchStatement':
      for (const c of node.cases) {
        if (c && Array.isArray(c.consequent)) processStatementList(c.consequent, ctx, state, replacements, warnings)
      }
      return
    case 'IfStatement':
      processNode(node.consequent, ctx, state, replacements, warnings)
      processNode(node.alternate, ctx, state, replacements, warnings)
      return
    case 'TryStatement':
      processNode(node.block, ctx, state, replacements, warnings)
      if (node.handler) processNode(node.handler.body, ctx, state, replacements, warnings)
      if (node.finalizer) processNode(node.finalizer, ctx, state, replacements, warnings)
      return
    case 'ForStatement':
    case 'ForInStatement':
    case 'ForOfStatement':
    case 'WhileStatement':
    case 'DoWhileStatement':
      processNode(node.body, ctx, state, replacements, warnings)
      return
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
      processNode(node.body, ctx, state, replacements, warnings)
      return
    default:
      // Generic traversal for nodes that may contain nested blocks.
      for (const val of Object.values(node)) {
        if (!val) continue
        if (Array.isArray(val)) {
          for (const v of val) processNode(v, ctx, state, replacements, warnings)
        } else if (val && typeof val === 'object' && typeof val.type === 'string') {
          processNode(val, ctx, state, replacements, warnings)
        }
      }
  }
}

/**
 * @param {any[]} statements
 * @param {FileContext} ctx
 * @param {TransformState} state
 * @param {Replacement[]} replacements
 * @param {string[]} warnings
 */
function processStatementList (statements, ctx, state, replacements, warnings) {
  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i]

    // Group consecutive primitive property assertions on the same base expression into assertObjectContains
    const group = tryConsumePropertyGroup(statements, i, ctx)
    if (group) {
      const { startIndex, endIndex, replacement } = group
      const startStmt = statements[startIndex]
      const endStmt = statements[endIndex]
      replacements.push({
        start: startStmt.start,
        end: endStmt.end,
        replacement
      })
      i = endIndex
      continue
    }

    const replaced = convertChaiStatement(stmt, ctx, state, warnings)
    if (replaced) replacements.push(replaced)

    processNode(stmt, ctx, state, replacements, warnings)
  }
}

/**
 * @param {any[]} statements
 * @param {number} startIndex
 * @param {FileContext} ctx
 * @returns {{ startIndex: number, endIndex: number, replacement: string } | null}
 */
function tryConsumePropertyGroup (statements, startIndex, ctx) {
  if (!ctx.hasAssertObjectContains) return null

  const first = statements[startIndex]
  const firstParsed = parseExpectAssertionStatement(first, ctx)
  if (!firstParsed) return null
  if (firstParsed.kind !== 'property' || firstParsed.negated || firstParsed.deep) return null
  if (!firstParsed.propertyPath || !firstParsed.expectedValue) return null
  if (!isLiteralish(firstParsed.expectedValue.node)) return null
  if (firstParsed.message) return null

  const base = firstParsed.actual
  const expectedRoot = new Map()

  addPath(expectedRoot, firstParsed.propertyPath, firstParsed.expectedValue.source)

  let endIndex = startIndex
  for (let i = startIndex + 1; i < statements.length; i++) {
    const s = statements[i]
    const p = parseExpectAssertionStatement(s, ctx)
    if (!p) break
    if (p.kind !== 'property' || p.negated || p.deep) break
    if (!p.propertyPath || !p.expectedValue) break
    if (p.message) break
    if (p.actual !== base) break
    if (!isLiteralish(p.expectedValue.node)) break

    addPath(expectedRoot, p.propertyPath, p.expectedValue.source)
    endIndex = i
  }

  if (endIndex === startIndex) return null

  const indent = getIndent(ctx.source, first.start)
  const objectLiteral = renderObjectLiteral(expectedRoot, indent + '  ')
  const replacement = renderCall(indent, 'assertObjectContains', [base, objectLiteral])
  return { startIndex, endIndex, replacement }
}

/**
 * @param {any} node
 * @returns {boolean}
 */
function isLiteralish (node) {
  if (!node) return false
  if (node.type === 'Literal') return true
  if (node.type === 'Identifier' && node.name === 'undefined') return true
  return false
}

/**
 * @param {Map<string, any>} root
 * @param {string[]} pathSegments
 * @param {string} valueSource
 */
function addPath (root, pathSegments, valueSource) {
  let cur = root
  for (let i = 0; i < pathSegments.length; i++) {
    const seg = pathSegments[i]
    const isLast = i === pathSegments.length - 1
    if (isLast) {
      cur.set(seg, valueSource)
      return
    }
    const next = cur.get(seg)
    if (next && typeof next === 'object' && next instanceof Map) {
      cur = next
      continue
    }
    const m = new Map()
    cur.set(seg, m)
    cur = m
  }
}

/**
 * @param {Map<string, any>} obj
 * @param {string} indent
 * @returns {string}
 */
function renderObjectLiteral (obj, indent) {
  const lines = ['{']
  for (const [k, v] of obj.entries()) {
    if (v instanceof Map) {
      const inner = renderObjectLiteral(v, indent + '  ')
      lines.push(`${indent}${renderObjectKey(k)}: ${inner},`)
    } else {
      lines.push(`${indent}${renderObjectKey(k)}: ${v},`)
    }
  }
  if (lines.length > 1) {
    // Remove trailing comma from last entry to match repo style.
    lines[lines.length - 1] = lines[lines.length - 1].replace(/,$/, '')
  }
  lines.push(indent.slice(0, -2) + '}')
  return lines.join('\n')
}

/**
 * @param {string} key
 * @returns {string}
 */
function renderObjectKey (key) {
  if (/^[$A-Z_][0-9A-Z_$]*$/i.test(key)) return key
  return `'${key.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

/**
 * @param {string} src
 * @param {number} start
 * @returns {string}
 */
function getIndent (src, start) {
  const lineStart = src.lastIndexOf('\n', start - 1) + 1
  const line = src.slice(lineStart, start)
  const m = line.match(/^[ \t]*/)
  return m ? m[0] : ''
}

/**
 * @param {any} stmt
 * @param {FileContext} ctx
 * @param {TransformState} state
 * @param {string[]} warnings
 * @returns {Replacement | null}
 */
function convertChaiStatement (stmt, ctx, state, warnings) {
  const expectFail = convertExpectFailStatement(stmt, ctx)
  if (expectFail) return expectFail

  const parsed = parseExpectAssertionStatement(stmt, ctx)
  if (parsed) {
    const replacement = convertParsedExpect(parsed, ctx, state, stmt, warnings)
    if (replacement) return replacement
    state.unsupported = true
    warnings.push(`unsupported chai expect: ${parsed.chain.map(l => l.name).join('.')}`)
  }

  const chaiAssert = parseChaiAssertStatement(stmt, ctx)
  if (chaiAssert) {
    const replacement = convertParsedChaiAssert(chaiAssert, ctx, state, stmt, warnings)
    if (replacement) return replacement
    // If we detected a chai assert usage but didn't convert it, keep chai imports intact.
    state.keepChaiImport = true
    warnings.push(`unsupported chai assert: assert.${chaiAssert.method}(...)`)
  }

  return null
}

/**
 * @param {any} stmt
 * @param {FileContext} ctx
 * @returns {Replacement | null}
 */
function convertExpectFailStatement (stmt, ctx) {
  if (!stmt || stmt.type !== 'ExpressionStatement') return null
  if (ctx.expectNames.size === 0) return null

  const expr = stmt.expression
  if (!expr || expr.type !== 'CallExpression') return null

  const callee = expr.callee
  if (!callee || callee.type !== 'MemberExpression') return null

  const method = memberPropertyName(callee)
  if (method !== 'fail') return null

  if (!callee.object || callee.object.type !== 'Identifier' || !ctx.expectNames.has(callee.object.name)) return null

  const indent = getIndent(ctx.source, stmt.start)
  const args = (expr.arguments || []).map(a => slice(ctx.source, a))
  return {
    start: stmt.start,
    end: stmt.end,
    replacement: renderCall(indent, 'assert.fail', args)
  }
}

/**
 * @typedef {{
 *   kind: string,
 *   actual: string,
 *   actualNode: any,
 *   message: string | null,
 *   negated: boolean,
 *   deep: boolean,
 *   chain: { kind: 'prop' | 'call', name: string, node: any }[],
 *   call?: { name: string, args: { node: any, source: string }[] },
 *   keysMode?: 'any' | 'all',
 *   propertyPath?: string[],
 *   expectedValue?: { node: any, source: string }
 * }} ParsedExpect
 */

/**
 * @param {any} stmt
 * @param {FileContext} ctx
 * @returns {ParsedExpect | null}
 */
function parseExpectAssertionStatement (stmt, ctx) {
  if (!stmt || stmt.type !== 'ExpressionStatement') return null
  if (ctx.expectNames.size === 0) return null

  const chain = extractChaiChain(stmt.expression, ctx.expectNames)
  if (!chain) return null

  const { expectCall, links } = chain
  if (!expectCall.arguments || expectCall.arguments.length < 1) return null

  const actualNode = expectCall.arguments[0]
  const actual = slice(ctx.source, actualNode)
  const message = expectCall.arguments[1] ? slice(ctx.source, expectCall.arguments[1]) : null

  const negated = links.some(l => l.kind === 'prop' && l.name === 'not')
  const deep = links.some(l => l.kind === 'prop' && l.name === 'deep')

  // Detect the "final" assertion call/property.
  const last = links[links.length - 1]
  if (!last) {
    return {
      kind: 'truthy',
      actual,
      actualNode,
      message,
      negated,
      deep,
      chain: links
    }
  }

  // include.members / deep.include.members
  if (last.kind === 'call' && last.name === 'members') {
    const args = last.node.arguments || []
    return {
      kind: 'includeMembers',
      actual,
      actualNode,
      message,
      negated,
      deep,
      chain: links,
      call: {
        name: 'members',
        args: args.map(a => ({ node: a, source: slice(ctx.source, a) }))
      }
    }
  }

  if (last.kind === 'call') {
    const args = last.node.arguments || []

    // property assertions
    if (last.name === 'property') {
      const pathArg = args[0]
      const valueArg = args[1]
      if (pathArg && pathArg.type === 'Literal' && typeof pathArg.value === 'string') {
        const propertyPath = pathArg.value.split('.')
        return {
          kind: 'property',
          actual,
          actualNode,
          message,
          negated,
          deep,
          chain: links,
          call: {
            name: 'property',
            args: args.map(a => ({ node: a, source: slice(ctx.source, a) }))
          },
          propertyPath,
          expectedValue: valueArg ? { node: valueArg, source: slice(ctx.source, valueArg) } : undefined
        }
      }

      // nested.property(<dynamicPath>) (path provided via identifier/const)
      const hasNested = links.some(l => l.kind === 'prop' && l.name === 'nested')
      if (hasNested && pathArg) {
        return {
          kind: 'nestedProperty',
          actual,
          actualNode,
          message,
          negated,
          deep,
          chain: links,
          call: {
            name: 'property',
            args: args.map(a => ({ node: a, source: slice(ctx.source, a) }))
          },
          expectedValue: valueArg ? { node: valueArg, source: slice(ctx.source, valueArg) } : undefined
        }
      }
    }

    // length assertions
    if (last.name === 'length' || last.name === 'lengthOf') {
      return {
        kind: 'length',
        actual,
        actualNode,
        message,
        negated,
        deep,
        chain: links,
        call: {
          name: last.name,
          args: args.map(a => ({ node: a, source: slice(ctx.source, a) }))
        }
      }
    }

    // equality
    if (last.name === 'equal' || last.name === 'eq' || last.name === 'equals') {
      return {
        kind: 'equal',
        actual,
        actualNode,
        message,
        negated,
        deep,
        chain: links,
        call: {
          name: last.name,
          args: args.map(a => ({ node: a, source: slice(ctx.source, a) }))
        }
      }
    }

    // include/match/greaterThan and similar
    if (last.name === 'include' || last.name === 'match' ||
      last.name === 'greaterThan' ||
      last.name === 'gte' ||
      last.name === 'lte' ||
      last.name === 'gt' ||
      last.name === 'lt'
    ) {
      return {
        kind: last.name,
        actual,
        actualNode,
        message,
        negated,
        deep,
        chain: links,
        call: {
          name: last.name,
          args: args.map(a => ({ node: a, source: slice(ctx.source, a) }))
        }
      }
    }

    // keys assertions: any.keys(...) / all.keys(...)
    if (last.name === 'keys') {
      const keysMode = links.some(l => l.kind === 'prop' && l.name === 'any') ? 'any' : 'all'
      return {
        kind: 'keys',
        actual,
        actualNode,
        message,
        negated,
        deep,
        keysMode,
        chain: links,
        call: {
          name: 'keys',
          args: args.map(a => ({ node: a, source: slice(ctx.source, a) }))
        }
      }
    }

    // type assertions: a/an('string')
    if ((last.name === 'a' || last.name === 'an') && args.length === 1 && args[0].type === 'Literal') {
      return {
        kind: 'type',
        actual,
        actualNode,
        message,
        negated,
        deep,
        chain: links,
        call: {
          name: last.name,
          args: args.map(a => ({ node: a, source: slice(ctx.source, a) }))
        }
      }
    }

    // sinon-chai call assertions (calledWith*, calledOnceWith*, calledWithMatch, callCount, ...)
    if (/^called/.test(last.name) || last.name === 'callCount') {
      return {
        kind: 'sinonCall',
        actual,
        actualNode,
        message,
        negated,
        deep,
        chain: links,
        call: {
          name: last.name,
          args: args.map(a => ({ node: a, source: slice(ctx.source, a) }))
        }
      }
    }
  } else if (last.kind === 'prop') {
    // property-based assertions: exist, empty, calledOnce, called, etc.
    if (last.name === 'exist') {
      return { kind: 'exist', actual, actualNode, message, negated, deep, chain: links }
    }
    if (last.name === 'empty') {
      return { kind: 'empty', actual, actualNode, message, negated, deep, chain: links }
    }
    if (last.name === 'profile') {
      return { kind: 'profile', actual, actualNode, message, negated, deep, chain: links }
    }
    if (last.name === 'true' || last.name === 'false' || last.name === 'null' || last.name === 'undefined') {
      return { kind: 'literalProp', actual, actualNode, message, negated, deep, chain: links }
    }
    if (/^called/.test(last.name)) {
      return { kind: 'sinonProp', actual, actualNode, message, negated, deep, chain: links }
    }
  }

  return {
    kind: 'unknown',
    actual,
    actualNode,
    message,
    negated,
    deep,
    chain: links
  }
}

/**
 * @param {any} expr
 * @param {Set<string>} expectNames
 * @returns {{ expectCall: any, links: { kind: 'prop'|'call', name: string, node: any }[] } | null}
 */
function extractChaiChain (expr, expectNames) {
  if (!expr) return null
  if (expr.type === 'ChainExpression') expr = expr.expression

  /** @type {{ kind: 'prop'|'call', name: string, node: any }[]} */
  const links = []

  let node = expr
  while (node) {
    if (node.type === 'ChainExpression') {
      node = node.expression
      continue
    }

    if (node.type === 'CallExpression') {
      const callee = node.callee
      if (callee && callee.type === 'Identifier' && expectNames.has(callee.name)) {
        return { expectCall: node, links: links.reverse() }
      }

      if (callee && callee.type === 'MemberExpression') {
        const name = memberPropertyName(callee)
        if (!name) return null
        links.push({ kind: 'call', name, node })
        node = callee.object
        continue
      }

      return null
    }

    if (node.type === 'MemberExpression') {
      const name = memberPropertyName(node)
      if (!name) return null
      links.push({ kind: 'prop', name, node })
      node = node.object
      continue
    }

    return null
  }

  return null
}

/**
 * @param {any} memberExpr
 * @returns {string | null}
 */
function memberPropertyName (memberExpr) {
  const prop = memberExpr.property
  if (!prop) return null
  if (!memberExpr.computed && prop.type === 'Identifier') return prop.name
  if (memberExpr.computed && prop.type === 'Literal' && typeof prop.value === 'string') return prop.value
  return null
}

/**
 * @param {string} src
 * @param {any} node
 * @returns {string}
 */
function slice (src, node) {
  return src.slice(node.start, node.end)
}

/**
 * @param {string} indent
 * @param {string} callee
 * @param {string[]} args
 * @returns {string}
 */
function renderCall (indent, callee, args) {
  const allArgs = args.filter(a => a != null && a !== '')

  const indentUnit = indent.includes('\t') ? '\t' : '  '
  const innerIndent = indent + indentUnit

  // Preserve multi-line arguments exactly as-is to avoid indentation churn in diffs.
  // Only wrap into a one-arg-per-line call when ALL args are single-line and we exceed 120 chars.
  const hasMultilineArg = allArgs.some(a => typeof a === 'string' && a.includes('\n'))
  const single = `${indent}${callee}(${allArgs.join(', ')})`

  if (hasMultilineArg || single.length <= 120) return single

  const lines = [`${indent}${callee}(`]
  for (let i = 0; i < allArgs.length; i++) {
    const isLast = i === allArgs.length - 1
    const suffix = isLast ? '' : ','
    lines.push(`${innerIndent}${allArgs[i]}${suffix}`)
  }
  lines.push(`${indent})`)
  return lines.join('\n')
}

/**
 * @param {string} indent
 * @param {string} cond
 * @param {string | null} msgArg
 * @returns {string}
 */
function renderAssertOk (indent, cond, msgArg) {
  return renderCall(indent, 'assert.ok', msgArg ? [cond, msgArg] : [cond])
}

/**
 * @param {string} indent
 * @param {string} fn
 * @param {string[]} args
 * @param {string | null} msgArg
 * @returns {string}
 */
function renderAssertCall (indent, fn, args, msgArg) {
  return renderCall(indent, `assert.${fn}`, msgArg ? [...args, msgArg] : args)
}

/**
 * Render `base.method(arg1, arg2, ...)` as an expression, using multi-line formatting if long.
 * @param {string} base
 * @param {string} method
 * @param {string[]} args
 * @returns {string}
 */
function renderMemberCallExpr (base, method, args) {
  const safeArgs = args.filter(a => a != null && a !== '')
  if (safeArgs.length === 0) return `${base}.${method}()`

  // Keep expressions single-line to avoid indentation churn inside enclosing calls.
  return `${base}.${method}(${safeArgs.join(', ')})`
}

/**
 * @param {any} node
 * @returns {boolean}
 */
function isRegExpLiteral (node) {
  return Boolean(node && node.type === 'Literal' && node.regex && typeof node.regex.pattern === 'string')
}

/**
 * Best-effort: whether an expression is *definitely* a string at runtime.
 * @param {any} node
 * @returns {boolean}
 */
function isDefinitelyStringExpression (node) {
  if (!node) return false
  if (node.type === 'ChainExpression') return isDefinitelyStringExpression(node.expression)

  if (node.type === 'Literal') return typeof node.value === 'string'
  if (node.type === 'TemplateLiteral') return true

  if (node.type === 'CallExpression' && node.callee && node.callee.type === 'Identifier') {
    // String(x) always returns a string.
    if (node.callee.name === 'String') return true
  }

  // If either operand is definitely a string, `+` produces a string.
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    return isDefinitelyStringExpression(node.left) || isDefinitelyStringExpression(node.right)
  }

  return false
}

/**
 * @param {any} node
 * @returns {boolean}
 */
function isStringArrayLiteral (node) {
  if (!node) return false
  if (node.type === 'ChainExpression') node = node.expression
  if (!node || node.type !== 'ArrayExpression') return false
  if (!Array.isArray(node.elements)) return false
  for (const el of node.elements) {
    if (!el || el.type !== 'Literal' || typeof el.value !== 'string') return false
  }
  return true
}

/**
 * @param {any} node
 * @returns {{ objectNode: any } | null}
 */
function parseObjectKeysCall (node) {
  if (!node) return null
  if (node.type === 'ChainExpression') node = node.expression
  if (!node || node.type !== 'CallExpression') return null

  const callee = node.callee
  if (!callee || callee.type !== 'MemberExpression' || callee.computed) return null
  if (!callee.object || callee.object.type !== 'Identifier' || callee.object.name !== 'Object') return null
  if (!callee.property || callee.property.type !== 'Identifier' || callee.property.name !== 'keys') return null

  const args = node.arguments || []
  if (args.length !== 1) return null
  return { objectNode: args[0] }
}

/**
 * @param {ParsedExpect} parsed
 * @param {FileContext} ctx
 * @param {TransformState} state
 * @param {any} stmt
 * @param {string[]} warnings
 * @returns {Replacement | null}
 */
function convertParsedExpect (parsed, ctx, state, stmt, warnings) {
  const indent = getIndent(ctx.source, stmt.start)
  const msgArg = parsed.message || null

  switch (parsed.kind) {
    case 'equal': {
      if (!parsed.call) return null
      const expected = parsed.call.args[0]?.source
      if (!expected) return null
      const fn = parsed.deep
        ? (parsed.negated ? 'notDeepStrictEqual' : 'deepStrictEqual')
        : (parsed.negated ? 'notStrictEqual' : 'strictEqual')
      return {
        start: stmt.start,
        end: stmt.end,
        replacement: renderAssertCall(indent, fn, [parsed.actual, expected], msgArg)
      }
    }

    case 'include': {
      if (!parsed.call) return null
      const expected = parsed.call.args[0]?.source
      const expectedNode = parsed.call.args[0]?.node
      if (!expected) return null
      if (!parsed.negated && ctx.hasAssertObjectContains && parsed.call.args[0]?.node?.type === 'ObjectExpression') {
        return {
          start: stmt.start,
          end: stmt.end,
          replacement: renderCall(
            indent,
            'assertObjectContains',
            msgArg ? [parsed.actual, expected, msgArg] : [parsed.actual, expected]
          )
        }
      }
      if (isDefinitelyStringExpression(parsed.actualNode)) {
        state.requiredHelpers.add('escapeRegExp')

        const re = isRegExpLiteral(expectedNode)
          ? expected
          : `new RegExp(escapeRegExp(String(${expected})))`

        const fn = parsed.negated ? 'doesNotMatch' : 'match'
        return {
          start: stmt.start,
          end: stmt.end,
          replacement: renderAssertCall(indent, fn, [parsed.actual, re], msgArg)
        }
      }

      const cond = parsed.negated
        ? `!(${parsed.actual}).includes(${expected})`
        : `(${parsed.actual}).includes(${expected})`
      return {
        start: stmt.start,
        end: stmt.end,
        replacement: renderAssertOk(indent, cond, msgArg)
      }
    }

    case 'keys': {
      if (!parsed.call) return null
      const keysArgSources = parsed.call.args.map(a => a.source)
      if (keysArgSources.length === 0) return null

      const keysMode = parsed.keysMode || 'all'
      const keysExpr = keysArgSources.length === 1 ? keysArgSources[0] : `[${keysArgSources.join(', ')}]`
      const pred = keysMode === 'any' ? 'some' : 'every'
      const expr = `(${keysExpr}).${pred}(k => Object.hasOwn((${parsed.actual}), k))`
      const cond = parsed.negated ? `!(${expr})` : expr
      return {
        start: stmt.start,
        end: stmt.end,
        replacement: renderAssertOk(indent, cond, msgArg)
      }
    }

    case 'match': {
      if (!parsed.call) return null
      const re = parsed.call.args[0]?.source
      if (!re) return null
      const fn = parsed.negated ? 'doesNotMatch' : 'match'
      return {
        start: stmt.start,
        end: stmt.end,
        replacement: renderAssertCall(indent, fn, [parsed.actual, re], msgArg)
      }
    }

    case 'greaterThan':
    case 'gte':
    case 'lte':
    case 'gt':
    case 'lt': {
      if (!parsed.call) return null
      const rhs = parsed.call.args[0]?.source
      if (!rhs) return null
      const op = parsed.kind === 'greaterThan' || parsed.kind === 'gt'
        ? '>'
        : parsed.kind === 'gte'
          ? '>='
          : parsed.kind === 'lt' ? '<' : '<='
      const expr = `${parsed.actual} ${op} ${rhs}`
      const cond = parsed.negated ? `!(${expr})` : expr
      return {
        start: stmt.start,
        end: stmt.end,
        replacement: renderAssertOk(indent, cond, msgArg)
      }
    }

    case 'exist': {
      const cond = parsed.negated ? `${parsed.actual} == null` : `${parsed.actual} != null`
      return {
        start: stmt.start,
        end: stmt.end,
        replacement: renderAssertOk(indent, cond, msgArg)
      }
    }

    case 'truthy': {
      const cond = parsed.negated ? `!(${parsed.actual})` : parsed.actual
      return {
        start: stmt.start,
        end: stmt.end,
        replacement: renderAssertOk(indent, cond, msgArg)
      }
    }

    case 'literalProp': {
      const last = parsed.chain[parsed.chain.length - 1]
      const literalName = last.name
      const expected = literalName === 'undefined' ? 'undefined' : literalName
      const fn = parsed.negated ? 'notStrictEqual' : 'strictEqual'
      return {
        start: stmt.start,
        end: stmt.end,
        replacement: renderAssertCall(indent, fn, [parsed.actual, expected], msgArg)
      }
    }

    case 'type': {
      if (!parsed.call) return null
      const typeLit = parsed.call.args[0]?.node
      if (!typeLit || typeLit.type !== 'Literal' || typeof typeLit.value !== 'string') return null
      const typeStr = typeLit.value

      const assertion = buildTypeAssertion(indent, parsed.actual, typeStr, parsed.negated, msgArg)
      if (!assertion) return null
      return { start: stmt.start, end: stmt.end, replacement: assertion }
    }

    case 'empty': {
      // Common in this repo: expect(x).to.be.an('array').that.is.empty
      const hasArrayType = parsed.chain.some(l => l.kind === 'call' && (l.name === 'a' || l.name === 'an') &&
        l.node.arguments && l.node.arguments[0] && l.node.arguments[0].type === 'Literal' &&
        l.node.arguments[0].value === 'array'
      )
      if (hasArrayType) {
        const fn = parsed.negated ? 'notDeepStrictEqual' : 'deepStrictEqual'
        return {
          start: stmt.start,
          end: stmt.end,
          replacement: renderAssertCall(indent, fn, [parsed.actual, '[]'], msgArg)
        }
      }
      // Fallback: length === 0 check (handles strings/arrays)
      const fn = parsed.negated ? 'notStrictEqual' : 'strictEqual'
      return {
        start: stmt.start,
        end: stmt.end,
        replacement: renderAssertCall(indent, fn, [`${parsed.actual}?.length`, '0'], msgArg)
      }
    }

    case 'length': {
      if (!parsed.call) return null
      const n = parsed.call.args[0]?.source
      if (!n) return null
      const propertyPath = findPropertyPathInChain(parsed.chain)
      const target = propertyPath ? buildOptionalChainedAccess(parsed.actual, propertyPath) : parsed.actual
      const fn = parsed.negated ? 'notStrictEqual' : 'strictEqual'
      return {
        start: stmt.start,
        end: stmt.end,
        replacement: renderAssertCall(indent, fn, [`${target}?.length`, n], msgArg)
      }
    }

    case 'property': {
      if (!parsed.expectedValue) {
        // Existence only
        if (!parsed.propertyPath) return null
        const accessOwner = buildOptionalChainedAccess(parsed.actual, parsed.propertyPath.slice(0, -1))
        const key = parsed.propertyPath[parsed.propertyPath.length - 1]
        const cond = `Object.hasOwn(${accessOwner}, ${renderJsString(key)})`
        const finalCond = parsed.negated ? `!(${cond})` : cond
        return {
          start: stmt.start,
          end: stmt.end,
          replacement: renderAssertOk(indent, finalCond, msgArg)
        }
      }

      // Value check (strict vs deep)
      if (!parsed.propertyPath) return null
      const access = buildOptionalChainedAccess(parsed.actual, parsed.propertyPath)
      const expected = parsed.expectedValue.source
      if (parsed.deep) {
        const fn = parsed.negated ? 'notDeepStrictEqual' : 'deepStrictEqual'
        return {
          start: stmt.start,
          end: stmt.end,
          replacement: renderAssertCall(indent, fn, [access, expected], msgArg)
        }
      }
      const fn = parsed.negated ? 'notStrictEqual' : 'strictEqual'
      return {
        start: stmt.start,
        end: stmt.end,
        replacement: renderAssertCall(indent, fn, [access, expected], msgArg)
      }
    }

    case 'nestedProperty': {
      if (!parsed.call) return null
      const path = parsed.call.args[0]?.source
      if (!path) return null

      if (!parsed.expectedValue) {
        state.requiredHelpers.add('hasNestedProperty')
        const cond = `${parsed.negated ? '!' : ''}hasNestedProperty(${parsed.actual}, ${path})`
        return {
          start: stmt.start,
          end: stmt.end,
          replacement: renderAssertOk(indent, cond, msgArg)
        }
      }

      state.requiredHelpers.add('getNestedProperty')
      const expected = parsed.expectedValue.source
      const actualValue = `getNestedProperty(${parsed.actual}, ${path})`
      const fn = parsed.deep
        ? (parsed.negated ? 'notDeepStrictEqual' : 'deepStrictEqual')
        : (parsed.negated ? 'notStrictEqual' : 'strictEqual')
      return {
        start: stmt.start,
        end: stmt.end,
        replacement: renderAssertCall(indent, fn, [actualValue, expected], msgArg)
      }
    }

    case 'includeMembers': {
      if (!parsed.call) return null
      const expected = parsed.call.args[0]?.source
      if (!expected) return null
      if (parsed.negated) {
        return {
          start: stmt.start,
          end: stmt.end,
          replacement: renderCall(
            indent,
            'assert.throws',
            msgArg
              ? [`() => assertObjectContains(${parsed.actual}, ${expected})`, msgArg]
              : [`() => assertObjectContains(${parsed.actual}, ${expected})`]
          )
        }
      }

      return {
        start: stmt.start,
        end: stmt.end,
        replacement: renderCall(
          indent,
          'assertObjectContains',
          msgArg ? [parsed.actual, expected, msgArg] : [parsed.actual, expected]
        )
      }
    }

    case 'profile': {
      if (parsed.negated) return null // no equivalent in this repo; keep safe
      state.requiredHelpers.add('assertIsProfile')
      return {
        start: stmt.start,
        end: stmt.end,
        replacement: renderCall(indent, 'assertIsProfile', msgArg ? [parsed.actual, msgArg] : [parsed.actual])
      }
    }

    case 'sinonProp':
    case 'sinonCall': {
      const out = convertSinonChai(parsed, ctx, indent, msgArg)
      if (!out) {
        warnings.push(`unsupported sinon-chai assertion: ${parsed.chain.map(l => l.name).join('.')}`)
        return null
      }
      return {
        start: stmt.start,
        end: stmt.end,
        replacement: out
      }
    }

    case 'unknown':
    default:
      return null
  }
}

/**
 * @param {string} indent
 * @param {string} actual
 * @param {string} typeStr
 * @param {boolean} negated
 * @param {string | null} msgArg
 * @returns {string | null}
 */
function buildTypeAssertion (indent, actual, typeStr, negated, msgArg) {
  const t = String(typeStr).toLowerCase()

  if (t === 'array') {
    const cond = negated ? `!Array.isArray(${actual})` : `Array.isArray(${actual})`
    return renderAssertOk(indent, cond, msgArg)
  }

  if (t === 'object') {
    const cond = `(${actual}) !== null && typeof (${actual}) === 'object' && !Array.isArray(${actual})`
    return renderAssertOk(indent, negated ? `!(${cond})` : cond, msgArg)
  }

  // Chai's a/an() also accepts object-ish type strings like 'date'/'regexp' that do not map to `typeof`.
  // For those, prefer instanceof checks.
  const instanceofMap = new Map([
    ['date', 'Date'],
    ['regexp', 'RegExp'],
    ['error', 'Error'],
    ['map', 'Map'],
    ['set', 'Set'],
    ['weakmap', 'WeakMap'],
    ['weakset', 'WeakSet'],
    ['promise', 'Promise'],
    ['arraybuffer', 'ArrayBuffer'],
    ['sharedarraybuffer', 'SharedArrayBuffer'],
    ['dataview', 'DataView'],
    ['uint8array', 'Uint8Array'],
    ['uint16array', 'Uint16Array'],
    ['uint32array', 'Uint32Array'],
    ['int8array', 'Int8Array'],
    ['int16array', 'Int16Array'],
    ['int32array', 'Int32Array'],
    ['float32array', 'Float32Array'],
    ['float64array', 'Float64Array'],
    ['bigint64array', 'BigInt64Array'],
    ['biguint64array', 'BigUint64Array']
  ])

  const ctorName = instanceofMap.get(t)
  if (ctorName) {
    const cond = `(${actual}) instanceof ${ctorName}`
    return renderAssertOk(indent, negated ? `!(${cond})` : cond, msgArg)
  }

  const cond = `typeof (${actual}) === ${renderJsString(typeStr)}`
  return renderAssertOk(indent, negated ? `!(${cond})` : cond, msgArg)
}

/**
 * @param {string} s
 * @returns {string}
 */
function renderJsString (s) {
  return `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

/**
 * @param {{ kind: 'prop' | 'call', name: string, node: any }[]} chain
 * @returns {string | null}
 */
/**
 * @param {string} base
 * @param {string[]} pathSegments
 * @returns {string}
 */
function buildOptionalChainedAccess (base, pathSegments) {
  if (!pathSegments || pathSegments.length === 0) return base
  let out = base
  for (const seg of pathSegments) {
    if (/^[$A-Z_][0-9A-Z_$]*$/i.test(seg)) {
      out += `?.${seg}`
    } else {
      out += `?.[${renderJsString(seg)}]`
    }
  }
  return out
}

/**
 * @param {{ kind: 'prop' | 'call', name: string, node: any }[]} chain
 * @returns {string[] | null}
 */
function findPropertyPathInChain (chain) {
  for (const link of chain) {
    if (link.kind !== 'call' || link.name !== 'property') continue
    const arg0 = link.node.arguments && link.node.arguments[0]
    if (!arg0 || arg0.type !== 'Literal' || typeof arg0.value !== 'string') continue
    return arg0.value.split('.')
  }
  return null
}

/**
 * @param {ParsedExpect} parsed
 * @param {FileContext} ctx
 * @param {string} indent
 * @param {string | null} msgArg
 * @returns {string | null}
 */
function convertSinonChai (parsed, ctx, indent, msgArg) {
  const last = parsed.chain[parsed.chain.length - 1]
  const call = parsed.call
  let name
  if (last.kind === 'call') {
    if (!call) return null
    name = call.name
  } else {
    name = last.name
  }

  // If the target is a specific call (getCall(...)), prefer call-object predicates.
  const isCallObject = /\.getCall\s*\(/.test(parsed.actual) || /\.getCalls\s*\(/.test(parsed.actual)

  // sinon.assert does not support passing a custom message; prefer predicate-based checks when a message is present.
  const preferPredicates = Boolean(msgArg)

  const hasSinonMatchArg = call && Array.isArray(call.args) &&
    call.args.some(a => typeof a?.source === 'string' && /\bsinon\.match\b/.test(a.source))

  if (last.kind === 'prop') {
    if (name === 'called' || name === 'calledOnce' || name === 'calledTwice' || name === 'calledThrice') {
      if (isCallObject) return null

      if (ctx.hasSinon && !preferPredicates) {
        return renderCall(indent, `sinon.assert.${name}`, [parsed.actual])
      }

      return renderCall(
        indent,
        'assert.strictEqual',
        msgArg ? [`${parsed.actual}.${name}`, 'true', msgArg] : [`${parsed.actual}.${name}`, 'true']
      )
    }

    return null
  }

  if (last.kind === 'call') {
    if (!call) return null
    const args = call.args.map(a => a.source)

    if (name === 'calledAfter' || name === 'calledBefore') {
      if (args.length !== 1) return null
      const expected = parsed.negated ? 'false' : 'true'
      return renderCall(
        indent,
        'assert.strictEqual',
        msgArg
          ? [`${parsed.actual}.${name}(${args[0]})`, expected, msgArg]
          : [`${parsed.actual}.${name}(${args[0]})`, expected]
      )
    }

    if (name === 'callCount') {
      const count = args[0]
      if (!count) return null
      if (isCallObject) return null

      if (ctx.hasSinon && !preferPredicates) {
        return renderCall(indent, 'sinon.assert.callCount', [parsed.actual, count])
      }

      return renderCall(
        indent,
        'assert.strictEqual',
        msgArg ? [`${parsed.actual}.callCount`, count, msgArg] : [`${parsed.actual}.callCount`, count]
      )
    }

    // If asserting on a call object, use call predicate methods.
    if (isCallObject) {
      if (name === 'calledWith' || name === 'calledWithMatch' || name === 'calledWithExactly') {
        const callExpr = renderMemberCallExpr(parsed.actual, name, args)
        return renderCall(
          indent,
          'assert.strictEqual',
          msgArg
            ? [callExpr, 'true', msgArg]
            : [callExpr, 'true']
        )
      }
      return null
    }

    if (ctx.hasSinon && !preferPredicates) {
      // For stricter behavior, treat calledWith() (no args) as "called with exactly no args".
      if (name === 'calledWith' && args.length === 0) {
        return renderCall(indent, 'sinon.assert.calledWithExactly', [parsed.actual])
      }

      if (name === 'calledWith' || name === 'calledWithMatch' || name === 'calledWithExactly' ||
        name === 'calledOnceWith' || name === 'calledOnceWithMatch' || name === 'calledOnceWithExactly') {
        // sinon.assert.calledOnceWith does not exist; prefer more precise flavors.
        if (name === 'calledOnceWith') {
          name = hasSinonMatchArg ? 'calledOnceWithMatch' : 'calledOnceWithExactly'
        }

        return renderCall(indent, `sinon.assert.${name}`, [parsed.actual, ...args].filter(Boolean))
      }

      return null
    }

    // Predicate fallback (works for sinon spies/stubs).
    if (name === 'calledWith' && args.length === 0) {
      const renderedArgs = msgArg
        ? [`${parsed.actual}.calledWithExactly()`, 'true', msgArg]
        : [`${parsed.actual}.calledWithExactly()`, 'true']
      return renderCall(
        indent,
        'assert.strictEqual',
        renderedArgs
      )
    }
    if (name === 'calledWith' || name === 'calledWithMatch' || name === 'calledWithExactly' ||
      name === 'calledOnceWith' || name === 'calledOnceWithMatch' || name === 'calledOnceWithExactly') {
      // Prefer strict flavor when chai chain says calledOnceWith (no match/exactly suffix).
      // If the original args contain sinon.match, choose calledOnceWithMatch, else calledOnceWithExactly.
      if (name === 'calledOnceWith') {
        name = hasSinonMatchArg ? 'calledOnceWithMatch' : 'calledOnceWithExactly'
      }

      const callExpr = renderMemberCallExpr(parsed.actual, name, args)
      return renderCall(
        indent,
        'assert.strictEqual',
        msgArg
          ? [callExpr, 'true', msgArg]
          : [callExpr, 'true']
      )
    }

    return null
  }

  return null
}

/**
 * @typedef {{ kind: 'chaiAssert', method: string, args: { node: any, source: string }[] }} ParsedChaiAssert
 */

/**
 * @param {any} stmt
 * @param {FileContext} ctx
 * @returns {ParsedChaiAssert | null}
 */
function parseChaiAssertStatement (stmt, ctx) {
  if (!stmt || stmt.type !== 'ExpressionStatement') return null
  if (ctx.chaiAssertNames.size === 0) return null

  const expr = stmt.expression
  if (!expr || expr.type !== 'CallExpression') return null
  const callee = expr.callee
  if (!callee || callee.type !== 'MemberExpression') return null
  if (!callee.object || callee.object.type !== 'Identifier' || !ctx.chaiAssertNames.has(callee.object.name)) return null

  const method = memberPropertyName(callee)
  if (!method) return null
  const args = (expr.arguments || []).map(a => ({ node: a, source: slice(ctx.source, a) }))
  return { kind: 'chaiAssert', method, args }
}

/**
 * @param {ParsedChaiAssert} parsed
 * @param {FileContext} ctx
 * @param {TransformState} state
 * @param {any} stmt
 * @param {string[]} warnings
 * @returns {Replacement | null}
 */
function convertParsedChaiAssert (parsed, ctx, state, stmt, warnings) {
  const indent = getIndent(ctx.source, stmt.start)
  const args = parsed.args.map(a => a.source)

  // Some test files already use Node-assert-compatible method names via Chai's `assert` export.
  // In that case, migrating is as simple as switching the import to `node:assert/strict`.
  if (NODE_ASSERT_COMPATIBLE_METHODS.has(parsed.method)) {
    return {
      start: stmt.start,
      end: stmt.end,
      replacement: renderCall(indent, `assert.${parsed.method}`, args)
    }
  }

  switch (parsed.method) {
    case 'equal':
      return { start: stmt.start, end: stmt.end, replacement: renderCall(indent, 'assert.strictEqual', args) }
    case 'notEqual':
      return { start: stmt.start, end: stmt.end, replacement: renderCall(indent, 'assert.notStrictEqual', args) }
    case 'deepEqual':
      return { start: stmt.start, end: stmt.end, replacement: renderCall(indent, 'assert.deepStrictEqual', args) }
    case 'notDeepEqual':
      return { start: stmt.start, end: stmt.end, replacement: renderCall(indent, 'assert.notDeepStrictEqual', args) }
    case 'match':
      return { start: stmt.start, end: stmt.end, replacement: renderCall(indent, 'assert.match', args) }
    case 'notMatch':
      return { start: stmt.start, end: stmt.end, replacement: renderCall(indent, 'assert.doesNotMatch', args) }
    case 'ok':
      return { start: stmt.start, end: stmt.end, replacement: renderCall(indent, 'assert.ok', args) }
    case 'exists': {
      const value = args[0]
      const msgArg = args[1] || null
      return { start: stmt.start, end: stmt.end, replacement: renderAssertOk(indent, `${value} != null`, msgArg) }
    }
    case 'isArray': {
      const value = args[0]
      const msgArg = args[1] || null
      return {
        start: stmt.start,
        end: stmt.end,
        replacement: renderAssertOk(indent, `Array.isArray(${value})`, msgArg)
      }
    }
    case 'include': {
      const str = args[0]
      const needle = args[1]
      const msgArg = args[2]

      const strNode = parsed.args[0]?.node
      const needleNode = parsed.args[1]?.node

      if (isDefinitelyStringExpression(strNode)) {
        state.requiredHelpers.add('escapeRegExp')
        const re = isRegExpLiteral(needleNode)
          ? needle
          : `new RegExp(escapeRegExp(String(${needle})))`
        return {
          start: stmt.start,
          end: stmt.end,
          replacement: renderCall(indent, 'assert.match', msgArg ? [str, re, msgArg] : [str, re])
        }
      }

      return {
        start: stmt.start,
        end: stmt.end,
        replacement: renderAssertOk(indent, `(${str}).includes(${needle})`, msgArg || null)
      }
    }
    case 'notInclude': {
      const needle = args[1]
      const msgArg = args[2]

      const strNode = parsed.args[0]?.node
      const needleNode = parsed.args[1]?.node

      // Special-case:
      // assert.notInclude(Object.keys(obj), ['a', 'b', ...])
      //    assert.ok(!['a','b'].some((key) => Object.hasOwn(obj, key)))
      //
      // Only apply when we can statically prove the pattern; otherwise leave unchanged.
      const keysCall = parseObjectKeysCall(strNode)
      if (keysCall && isStringArrayLiteral(needleNode)) {
        const objectSrc = slice(ctx.source, keysCall.objectNode)
        const cond = `!${needle}.some((key) => Object.hasOwn(${objectSrc}, key))`
        const okLine = renderAssertOk(indent, cond, msgArg || null)
        return {
          start: stmt.start,
          end: stmt.end,
          replacement: `${okLine}`
        }
      }

      return null
    }
    case 'propertyVal': {
      const obj = args[0]
      const key = args[1]
      const value = args[2]
      const msgArg = args[3]
      return {
        start: stmt.start,
        end: stmt.end,
        replacement: renderCall(
          indent,
          'assert.strictEqual',
          msgArg ? [`${obj}[${key}]`, value, msgArg] : [`${obj}[${key}]`, value]
        )
      }
    }
    case 'sameMembers':
    case 'sameDeepMembers': {
      const msgArg = args[2]
      return {
        start: stmt.start,
        end: stmt.end,
        replacement: renderCall(
          indent,
          'assertObjectContains',
          msgArg ? [args[0], args[1], msgArg] : [args[0], args[1]]
        )
      }
    }
    default:
      warnings.push(`unsupported chai assert: assert.${parsed.method}(...)`)
      return null
  }
}
