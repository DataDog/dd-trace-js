'use strict'

/**
 * Chai → node:assert/strict codemod
 * - Rewrites common expect/assert patterns to Node's assert
 * - Rewrites sinon-chai to sinon.assert
 * - Inserts `const assert = require('node:assert/strict')` when needed
 * - Skips Cypress browser e2e directories
 *
 * Usage:
 *   node scripts/codemods/chai-to-assert.js
 */

const fs = require('fs')
const path = require('path')
const glob = require('glob')

const ROOT = path.resolve(__dirname, '..', '..')

/** @param {string} file */
function read (file) {
  return fs.readFileSync(file, 'utf8')
}

/** @param {string} file @param {string} content */
function write (file, content) {
  fs.writeFileSync(file, content)
}

/** @param {string} code */
function ensureAssertImport (code) {
  const hasStrict = /\bconst\s+assert\s*=\s*require\(['"](node:)?assert\/strict['"]\)/.test(code)
  const hasAssert = /\bconst\s+assert\s*=\s*require\(['"](node:)?assert['"]\)/.test(code)
  const hasESMStrict = /^\s*import\s+(?:\*\s+as\s+)?assert\s+from\s*['"](node:)?assert\/strict['"]/m.test(code) ||
    /^\s*import\s*\{\s*strict\s+as\s+assert\s*\}\s*from\s*['"](node:)?assert['"]/m.test(code)
  const hasESMAssert = /^\s*import\s+(?:\*\s+as\s+)?assert\s+from\s*['"](node:)?assert['"]/m.test(code)
  if (hasStrict || hasAssert || hasESMStrict || hasESMAssert) return code

  const useStrictMatch = code.match(/^(\s*'use strict'\s*;?\s*\n)/)
  if (useStrictMatch) {
    const idx = useStrictMatch[0].length
    return code.slice(0, idx) + "const assert = require('node:assert/strict')\n\n" + code.slice(idx)
  }
  return "const assert = require('node:assert/strict')\n\n" + code
}

// Import utilities
function getTopImportBlockRange (code) {
  let idx = 0
  const useStrict = code.match(/^(\s*'use strict'\s*;?\s*\n)/)
  if (useStrict) idx = useStrict[0].length

  const reFirst = /^(?:\s*(?:import\b|(?:const|let|var)\s+[^=]+?=\s*require\(['"][^'"]+['"]\))\s*(?:\n|$))/m
  const m = code.slice(idx).match(reFirst)
  if (!m || typeof m.index !== 'number') return null
  const start = idx + m.index

  const lines = code.slice(start).split('\n')
  let consumed = 0
  for (const line of lines) {
    const isImport = /^\s*import\b/.test(line)
    const isRequire = /^\s*(?:const|let|var)\s+[^=]+?=\s*require\(['"][^'"]+['"]\)\s*;?\s*$/.test(line)
    const isBlank = /^\s*$/.test(line)
    const isComment = /^\s*\/{2}/.test(line)
    if (!(isImport || isRequire || isBlank || isComment)) break
    consumed++
  }
  const end = start + lines.slice(0, consumed).join('\n').length
  return [start, end]
}

function extractImportSpec (line) {
  let m = line.match(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/)
  if (m) return m[1]
  m = line.match(/\bfrom\s*['"]([^'"]+)['"]/)
  if (m) return m[1]
  m = line.match(/^\s*import\s*['"]([^'"]+)['"]/)
  if (m) return m[1]
  return null
}

function isRelativeSpec (spec) {
  return spec.startsWith('.') || spec.startsWith('/')
}

function isNodeSpec (spec, builtinSet) {
  if (spec.startsWith('node:')) return true
  return builtinSet.has(spec)
}

function rebuildImportsSortedByType (code) {
  const range = getTopImportBlockRange(code)
  if (!range) return code
  const [start, end] = range
  const block = code.slice(start, end)
  const lines = block.split('\n')
  const { builtinModules } = require('module')
  const allBuiltins = new Set(builtinModules.concat(builtinModules.map(m => m.replace(/^node:/, ''))))

  const node = []
  const npm = []
  const rel = []
  for (const line of lines) {
    const spec = extractImportSpec(line)
    if (!spec) continue
    if (isRelativeSpec(spec)) rel.push({ spec, line })
    else if (isNodeSpec(spec, allBuiltins)) node.push({ spec, line })
    else npm.push({ spec, line })
  }
  node.sort((a, b) => a.spec.localeCompare(b.spec))
  npm.sort((a, b) => a.spec.localeCompare(b.spec))
  rel.sort((a, b) => a.spec.localeCompare(b.spec))

  const pieces = []
  if (node.length) pieces.push(node.map(x => x.line).join('\n'))
  if (npm.length) pieces.push(npm.map(x => x.line).join('\n'))
  if (rel.length) pieces.push(rel.map(x => x.line).join('\n'))
  const rebuilt = pieces.join('\n\n')
  return code.slice(0, start) + rebuilt + code.slice(end)
}

// Mocha helpers
function findMochaImports (code) {
  const lines = code.split('\n')
  const idxs = []
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (/^\s*(?:const|let|var)\s*\{[^}]*\}\s*=\s*require\(\s*['"]mocha['"]\s*\)\s*;?\s*$/.test(l)) idxs.push(i)
    else if (/^\s*import\s*\{[^}]*\}\s*from\s*['"]mocha['"]\s*;?\s*$/.test(l)) idxs.push(i)
  }
  return idxs
}

function getMochaSpecifiersFromLine (line) {
  const m = line.match(/\{\s*([^}]*)\s*\}/)
  if (!m) return []
  return m[1].split(',').map(s => s.trim()).filter(Boolean)
}

function setMochaSpecifiersOnLine (line, names) {
  const sorted = Array.from(new Set(names)).sort()
  const replaced = line.replace(/\{\s*([^}]*)\s*\}/, '{ __PLACEHOLDER__ }')
  return replaced.replace('__PLACEHOLDER__', sorted.join(', '))
}

function ensureMochaImportsIfNeeded (code) {
  const idxs = findMochaImports(code)
  if (idxs.length !== 1) return code
  const usedNames = ['describe', 'context', 'it', 'specify', 'before', 'beforeEach', 'after', 'afterEach']
  const used = new Set()
  for (const n of usedNames) {
    const re = new RegExp('\\s' + n + '(?:\\.(?:only|skip))?\\(')
    if (re.test(code)) used.add(n)
  }
  if (!used.size) return code
  const lines = code.split('\n')
  const i = idxs[0]
  const current = getMochaSpecifiersFromLine(lines[i])
  const merged = Array.from(new Set([...current, ...used]))
  lines[i] = setMochaSpecifiersOnLine(lines[i], merged)
  return lines.join('\n')
}

function removeChaiImportsWhenReplaced (code, { dropAssert, dropExpect }) {
  let out = code
  if (dropAssert) {
    out = out.replace(/^\s*const\s+assert\s*=\s*require\(\s*['"]chai['"]\s*\)\.assert\s*;?\s*\n/mg, '')
    out = out.replace(/^\s*const\s+{\s+assert\s+}\s*=\s*require\(\s*['"]chai['"]\s*\)\s*;?\s*\n/mg, '')
    out = out.replace(/^\s*import\s*\{\s*assert\s*\}\s*from\s*['"]chai['"]\s*;?\s*\n/mg, '')
  }
  if (dropExpect) {
    out = out.replace(/^\s*const\s+expect\s*=\s*require\(\s*['"]chai['"]\s*\)\.expect\s*;?\s*\n/mg, '')
    out = out.replace(/^\s*const\s+{\s+expect\s+}\s*=\s*require\(\s*['"]chai['"]\s*\)\s*;?\s*\n/mg, '')
    out = out.replace(/^\s*import\s*\{\s*expect\s*\}\s*from\s*['"]chai['"]\s*;?\s*\n/mg, '')
  }
  // const { expect, assert } = require('chai')
  out = out.replace(/^(\s*const\s*\{)([^}]*)\}(\s*=\s*require\(\s*['"]chai['"]\s*\)\s*;?\s*\n)/mg, (m, a, inner, b) => {
    const names = inner.split(',').map(s => s.trim()).filter(Boolean)
    const filtered = names.filter(n => !(dropAssert && n === 'assert') && !(dropExpect && n === 'expect'))
    if (!filtered.length) return ''
    if (filtered.length === names.length) return m
    return a + ' ' + filtered.join(', ') + ' }' + b
  })
  // import { expect, assert } from 'chai'
  out = out.replace(/^(\s*import\s*\{)([^}]*)\}(\s*from\s*['"]chai['"]\s*;?\s*\n)/mg, (m, a, inner, b) => {
    const names = inner.split(',').map(s => s.trim()).filter(Boolean)
    const filtered = names.filter(n => !(dropAssert && n === 'assert') && !(dropExpect && n === 'expect'))
    if (!filtered.length) return ''
    if (filtered.length === names.length) return m
    return a + ' ' + filtered.join(', ') + ' }' + b
  })
  return out
}

function posixify (p) {
  return p.replace(/\\/g, '/')
}

function ensureAssertObjectContainsImport (code, file) {
  if (!/\bassertObjectContains\(/.test(code)) return code
  // If already imported somewhere from a helpers module, skip
  const already = /^(?:\s*(?:const|let|var)\s*\{[^}]*\bassertObjectContains\b[^}]*\}\s*=\s*require\([^)]*helpers[^)]*\)|\s*import\s*\{[^}]*\bassertObjectContains\b[^}]*\}\s*from\s*['"][^'"]*helpers[^'"]*['"])\s*;?\s*$/m
  if (already.test(code)) return code

  const helpersDir = path.join(ROOT, 'integration-tests', 'helpers')
  const helpersIndexJs = path.join(helpersDir, 'index.js')
  const helpersIndexTs = path.join(helpersDir, 'index.ts')
  if (!fs.existsSync(helpersDir) && !fs.existsSync(helpersIndexJs) && !fs.existsSync(helpersIndexTs)) return code

  const fromDir = path.dirname(file)
  let rel = posixify(path.relative(fromDir, helpersDir))
  if (!rel.startsWith('.')) rel = './' + rel

  const importLine = `const { assertObjectContains } = require('${rel}')\n`
  const range = getTopImportBlockRange(code)
  if (range) {
    const [start, end] = range
    const block = code.slice(start, end)
    let newBlock = block
    if (!block.endsWith('\n')) newBlock += '\n'
    newBlock += importLine
    return code.slice(0, start) + newBlock + code.slice(end)
  }
  const useStrictMatch = code.match(/^(\s*'use strict'\s*;?\s*\n)/)
  if (useStrictMatch) {
    const idx = useStrictMatch[0].length
    return code.slice(0, idx) + importLine + code.slice(idx)
  }
  return importLine + code
}

/**
 * Escape a JS expression to a regex at runtime.
 * Produces: new RegExp((EXPR).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
 */
function wrapAsEscapedRegex (expr) {
  return 'new RegExp((' + expr + ')' +
    ".replace(/[.*+?^${}()|[\\]\\]/g, '\\$&'))"
}

// -------- Helpers to format long assert lines (wrap args if >120 chars) --------
function splitTopLevelArgs (s) {
  const out = []
  let buf = ''
  let p = 0; let b = 0; let c = 0
  let inS = false; let inD = false; let inT = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    const prev = i > 0 ? s[i - 1] : ''
    if (inS) { buf += ch; if (ch === '\'' && prev !== '\\') inS = false; continue }
    if (inD) { buf += ch; if (ch === '"' && prev !== '\\') inD = false; continue }
    if (inT) {
      buf += ch
      if (ch === '`' && prev !== '\\') inT = false
      else if (ch === '{' && prev === '$') c++
      else if (ch === '}' && c > 0) c--
      continue
    }
    if (ch === '\'') { inS = true; buf += ch; continue }
    if (ch === '"') { inD = true; buf += ch; continue }
    if (ch === '`') { inT = true; buf += ch; continue }
    if (ch === '(') { p++; buf += ch; continue }
    if (ch === ')') { p--; buf += ch; continue }
    if (ch === '[') { b++; buf += ch; continue }
    if (ch === ']') { b--; buf += ch; continue }
    if (ch === '{') { c++; buf += ch; continue }
    if (ch === '}') { c--; buf += ch; continue }
    if (ch === ',' && p === 0 && b === 0 && c === 0) { out.push(buf.trim()); buf = ''; continue }
    buf += ch
  }
  if (buf.trim()) out.push(buf.trim())
  return out
}

function formatLongAssertCalls (code) {
  const lines = code.split('\n')
  // keep indexable form for potential future use
  const out = []
  for (const line of lines) {
    if (line.length <= 120) { out.push(line); continue }
    const m = line.match(/^(\s*)(assert\.\w+)\((.*)\)\s*;?\s*$/)
    if (!m) { out.push(line); continue }
    const indent = m[1] || ''
    const head = m[2]
    const inner = m[3] || ''
    const args = splitTopLevelArgs(inner)
    if (args.length === 0) { out.push(line); continue }
    if (args.length === 1) {
      out.push(`${indent}${head}(\n${indent}  ${args[0]}\n${indent})`)
    } else {
      const formatted = args.map(a => `${indent}  ${a}`).join(',\n')
      out.push(`${indent}${head}(\n${formatted}\n${indent})`)
    }
  }
  return out.join('\n')
}

// Build a safe accessor using dot notation for identifier keys, or bracket for others.
// keyLiteral includes quotes (e.g., 'name' or "name"). For non-literals, fallback to bracket.
function buildAccessor (objExpr, keyLiteral) {
  const k = (keyLiteral || '').trim()
  if ((k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'"))) {
    const key = k.slice(1, -1)
    const isIdentifier = /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
    return isIdentifier ? `${objExpr}.${key}` : `${objExpr}[${k}]`
  }
  return `${objExpr}[${k}]`
}

// Detect files using expect from Playwright and skip transforming them
function usesPlaywrightExpect (code) {
  // import { expect } from '@playwright/test'
  if (/^\s*import\s*\{[^}]*\bexpect\b[^}]*\}\s*from\s*["']@playwright\/test["']\s*;?\s*$/m.test(code)) return true
  // const { expect } = require('@playwright/test') or let/var
  if (/^\s*(?:const|let|var)\s*\{[^}]*\bexpect\b[^}]*\}\s*=\s*require\(\s*["']@playwright\/test["']\s*\)\s*;?\s*$/m.test(code)) return true
  return false
}

function hasChaiImport (code) {
  if (/\brequire\(\s*["']chai["']\s*\)/.test(code)) return true
  if (/\bfrom\s*["']chai["']/.test(code)) return true
  if (/^\s*import\s*["']chai["']\s*;?\s*$/m.test(code)) return true
  return false
}

// Skip files that import/require an 'expect' symbol from a non-chai module
function usesNonChaiExpect (code) {
  // import { expect } from 'x'
  const reNamed = /^\s*import\s*\{([^}]*\bexpect\b[^}]*)\}\s*from\s*['"]([^'"]+)['"]\s*;?/mg
  let m
  while ((m = reNamed.exec(code)) !== null) {
    const mod = m[2]
    if (!/^chai(?:\/|$)?/.test(mod)) return true
  }
  // import expect from 'x'
  const reDef = /^\s*import\s+(\w+)\s+from\s*['"]([^'"]+)['"]\s*;?/mg
  while ((m = reDef.exec(code)) !== null) {
    const name = m[1]; const mod = m[2]
    if (name === 'expect' && !/^chai(?:\/|$)?/.test(mod)) return true
  }
  // import * as expect from 'x'
  const reNs = /^\s*import\s+\*\s+as\s+(\w+)\s+from\s*['"]([^'"]+)['"]\s*;?/mg
  while ((m = reNs.exec(code)) !== null) {
    const name = m[1]; const mod = m[2]
    if (name === 'expect' && !/^chai(?:\/|$)?/.test(mod)) return true
  }
  // const { expect } = require('x')
  const reReqNamed = /^\s*(?:const|let|var)\s*\{([^}]*\bexpect\b[^}]*)\}\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)\s*;?/mg
  while ((m = reReqNamed.exec(code)) !== null) {
    const mod = m[2]
    if (!/^chai(?:\/|$)?/.test(mod)) return true
  }
  // const expect = require('x')
  const reReqDef = /^\s*(?:const|let|var)\s*(\w+)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)\s*;?/mg
  while ((m = reReqDef.exec(code)) !== null) {
    const name = m[1]; const mod = m[2]
    if (name === 'expect' && !/^chai(?:\/|$)?/.test(mod)) return true
  }
  // const expect = require('x').something  (non-chai)
  const reReqProp = /^\s*(?:const|let|var)\s*(\w+)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)\.\s*([A-Za-z_$][\w$]*)/mg
  while ((m = reReqProp.exec(code)) !== null) {
    const name = m[1]; const mod = m[2]; const prop = m[3]
    if (name === 'expect' && !(/^chai(?:\/|$)?/.test(mod) && prop === 'expect')) return true
  }
  return false
}

// isCiVisibilityPath removed – not needed after chai-only guard

function pruneUnusedChaiNamedImports (code) {
  // Build a version without any chai import/require lines to check identifier usage
  const body = code
    .replace(/^\s*(?:const|let|var)\s+chai\s*=\s*require\(\s*["']chai["']\s*\)\s*;?\s*\n/mg, '')
    .replace(/^\s*import\s+chai\s+from\s*["']chai["']\s*;?\s*\n/mg, '')
    .replace(/^\s*import\s+chai\s*,\s*\{[^}]*\}\s*from\s*["']chai["']\s*;?\s*\n/mg, '')
    .replace(/^\s*(?:const|let|var)\s*\{[^}]*\}\s*=\s*require\(\s*["']chai["']\s*\)\s*;?\s*\n/mg, '')
    .replace(/^\s*import\s*\{[^}]*\}\s*from\s*["']chai["']\s*;?\s*\n/mg, '')

  function filterTokens (inner, isImport) {
    const tokens = inner.split(',').map(s => s.trim()).filter(Boolean)
    const kept = []
    for (const tok of tokens) {
      let local = tok
      if (isImport) {
        const m = tok.match(/^(\w+)\s+as\s+(\w+)$/)
        if (m) local = m[2]
      } else {
        const m = tok.match(/^(\w+)\s*:\s*(\w+)$/)
        if (m) local = m[2]
      }
      if (new RegExp('\\b' + local + '\\b').test(body)) kept.push(tok)
    }
    return kept
  }

  // Require destructuring
  code = code.replace(/^(\s*(?:const|let|var)\s*\{)([^}]*)\}(\s*=\s*require\(\s*["']chai["']\s*\)\s*;?\s*\n)/mg, (m, a, inner, b) => {
    const kept = filterTokens(inner, false)
    if (!kept.length) return ''
    return a + ' ' + kept.join(', ') + ' }' + b
  })
  // Import destructuring
  code = code.replace(/^(\s*import\s*\{)([^}]*)\}(\s*from\s*["']chai["']\s*;?\s*\n)/mg, (m, a, inner, b) => {
    const kept = filterTokens(inner, true)
    if (!kept.length) return ''
    return a + ' ' + kept.join(', ') + ' }' + b
  })

  return code
}

/** @param {string} code */
function transform (code, file) {
  let out = code

  // Skip files that import expect from Playwright
  if (usesPlaywrightExpect(code)) return code
  // Skip files that import/require an 'expect' symbol from a non-chai module
  if (usesNonChaiExpect(code)) return code
  // Only process files that import/require chai, OR that contain assert.* helpers we can convert, OR expect() usage
  const hasAssertHelpers = /\bassert\.(?:exists|notExists|hasAllKeys|isTrue|isFalse|isUndefined|isDefined|isNull|isNotNull|isArray|isObject|isString|isNumber|isBoolean|isBigInt|isFunction|isBelow|isAbove|isAtLeast|isAtMost|instanceOf|notInstanceOf|istanceOf|lengthOf|notLengthOf|property|notProperty|propertyVal|notPropertyVal|include|notInclude|deepInclude|match|notMatch|sameMembers|sameDeepMembers|isEmpty|isNotEmpty)\(/.test(code)
  const hasExpect = /(?:^|[^\w$])expect\s*(\(|\.)/.test(code)
  if (!hasChaiImport(code) && !hasAssertHelpers && !hasExpect) return code

  // Track assert usage/import state before transformation
  const beforeNonChaiAssertCount = (code.match(/(^|[^.\w$])assert\./g) || []).length
  const hasNodeAssertImportBefore = /\bconst\s+assert\s*=\s*require\(['"](node:)?assert(?:\/strict)?['"]\)/.test(code) ||
    /^\s*import\s+(?:\*\s+as\s+)?assert\s+from\s*['"](node:)?assert(?:\/strict)?['"]/m.test(code) ||
    /^\s*import\s*\{\s*strict\s+as\s+assert\s*\}\s*from\s*['"](node:)?assert['"]/m.test(code)
  const hasAssertVariableBefore = /\b(?:const|let|var)\s+assert\s*=/.test(code) || /\bconst\s*\{[^}]*\bassert\b[^}]*\}\s*=\s*require\(\s*['"]chai['"]\s*\)/.test(code) || /\bimport\s*\{[^}]*\bassert\b[^}]*\}\s*from\s*['"]chai['"]/.test(code)

  // 0) Do not alter chai/sinon-chai imports or chai.use lines here; we only add assert when used.

  // 1) expect(...).to.be.fulfilled → await p (handled only when 'await expect(...)')
  out = out.replace(/await\s+expect\(([^)]+)\)\.to\.be\.fulfilled/g, 'await $1')

  // 2) await expect(p).to.be.rejected[With(...)]
  out = out.replace(/await\s+expect\(([^)]+)\)\.to\.be\.rejectedWith\(([^)]+)\)/g,
    'await assert.rejects($1, $2)')
  out = out.replace(/await\s+expect\(([^)]+)\)\.to\.be\.rejected(?!With)/g,
    'await assert.rejects($1)')

  // 3) NaN
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\.to\.be\.NaN/g, 'assert.strictEqual($1, NaN)')

  // 6) Basic equality
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\.to\.deep\.(?:equal|eql)\(([^)]+)\)/g, 'assert.deepStrictEqual($1, $2)')
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\.to\.be\.deep\.(?:equal|eql)\(([^)]+)\)/g, 'assert.deepStrictEqual($1, $2)')
  // eq/eql aliases
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\.to\.eq\(([^)]+)\)/g, 'assert.strictEqual($1, $2)')
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\.to\.eql\(([^)]+)\)/g, 'assert.deepStrictEqual($1, $2)')
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\.to\.(?:be\.)?(?:equal|equals)\(([^)]+)\)/g, 'assert.strictEqual($1, $2)')
  // function-call aware equal/equals (balanced one-level parentheses)
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\.to\.not\.(?:be\.)?(?:equal|equals)\(([^)]+)\)/g, 'assert.notStrictEqual($1, $2)')
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\.(?:to\.not|not\.to)\.(?:be\.)?(?:equal|equals)\(([^)]+)\)/g, 'assert.notStrictEqual($1, $2)')
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\.(?:to\.not|not\.to)\.deep\.(?:equal|eql)\(([^)]+)\)/g, 'assert.notDeepStrictEqual($1, $2)')
  // toBe / not.toBe (used in some chai setups too)
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\.toBe\(([^)]+)\)/g, 'assert.strictEqual($1, $2)')
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\.not\.toBe\(([^)]+)\)/g, 'assert.notStrictEqual($1, $2)')
  // Jest toEqual / not.toEqual
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\.toEqual\(([^)]+)\)/g, 'assert.deepStrictEqual($1, $2)')
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\.not\.toEqual\(([^)]+)\)/g, 'assert.notDeepStrictEqual($1, $2)')

  // 4) Truthiness & types
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\.to\.be\.true/g, 'assert.strictEqual($1, true)')
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\.to\.be\.false/g, 'assert.strictEqual($1, false)')
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\.to\.be\.ok/g, 'assert.ok($1)')
  // .to.not.undefined (property form)
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\.to\.not\.undefined\b/g, 'assert.notStrictEqual($1, undefined)')
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\.to\.be\.undefined/g, 'assert.strictEqual($1, undefined)')
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\.to\.be\.null/g, 'assert.strictEqual($1, null)')
  // negatives: to.not / not.to
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\.(?:to\.not|not\.to)\.be\.undefined/g, 'assert.notStrictEqual($1, undefined)')
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\.(?:to\.not|not\.to)\.be\.null/g, 'assert.notStrictEqual($1, null)')
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\.to\.exist/g, 'assert.ok($1 != null)')
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\.to\.not\.exist/g, 'assert.ok($1 == null)')
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\.to\.be\.(?:an|a)\(['"]array['"]\)/g, 'assert.ok(Array.isArray($1))')
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\.to\.be\.(?:an|a)\(['"]object['"]\)/g, "assert.ok(typeof $1 === 'object' && $1 !== null)")
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\.to\.be\.(?:an|a)\(['"]string['"]\)/g, "assert.strictEqual(typeof $1, 'string')")
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\.to\.be\.(?:an|a)\(['"]number['"]\)/g, "assert.strictEqual(typeof $1, 'number')")
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\.to\.be\.(?:an|a)\(['"]boolean['"]\)/g, "assert.strictEqual(typeof $1, 'boolean')")
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\.to\.be\.(?:an|a)\(['"]bigint['"]\)/g, "assert.strictEqual(typeof $1, 'bigint')")
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\.to\.be\.(?:an|a)\(['"]function['"]\)/g, "assert.strictEqual(typeof $1, 'function')")
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\.to\.be\.(?:an|a)\(['"]array['"]\)\.and\.have\.length\(([^)]+)\)/g,
    '(assert.ok(Array.isArray($1)), assert.strictEqual($1.length, $2))')
  // instanceOf (Array special case first)
  out = out.replace(/expect\(([^)]+)\)\.to\.be\.(?:instanceOf|instanceof)\(\s*Array\s*\)/g, 'assert.ok(Array.isArray($1))')
  out = out.replace(/expect\(([^)]+)\)\.to\.not\.be\.(?:instanceOf|instanceof)\(\s*Array\s*\)/g, 'assert.ok(!Array.isArray($1))')
  out = out.replace(/expect\(([^)]+)\)\.to\.be\.(?:instanceOf|instanceof)\(([^)]+)\)/g, 'assert.ok($1 instanceof $2)')
  out = out.replace(/expect\(([^)]+)\)\.to\.not\.be\.(?:instanceOf|instanceof)\(([^)]+)\)/g, 'assert.ok(!($1 instanceof $2))')

  // 8) Regex
  out = out.replace(/expect\(([^)]+)\)\.to\.match\(([^)]+)\)/g, 'assert.match($1, $2)')
  out = out.replace(/expect\(([^)]+)\)\.to\.not\.match\(([^)]+)\)/g, 'assert.doesNotMatch($1, $2)')
  // function-call aware regex
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\.to\.match\(([^)]+)\)/g, 'assert.match($1, $2)')
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\.to\.not\.match\(([^)]+)\)/g, 'assert.doesNotMatch($1, $2)')

  // 8.1) contain/include string literal or .contain alias → assert.match(haystack, escaped(needle))
  out = out.replace(/expect\(([^)]+)\)\.to\.(?:contain|include)\(\s*(['"][^'"]+['"])\s*\)/g,
    (m, haystack, lit) => `assert.match(${haystack}, ${wrapAsEscapedRegex(lit)})`)
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\.to\.(?:contain|include)\(\s*(['"][^'"]+['"])\s*\)/g,
    (m, haystack, lit) => `assert.match(${haystack}, ${wrapAsEscapedRegex(lit)})`)
  out = out.replace(/expect\(([^)]+)\)\.to\.contain\(\s*(['"][^'"]+['"])\s*\)/g,
    (m, haystack, lit) => `assert.match(${haystack}, ${wrapAsEscapedRegex(lit)})`)
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\.to\.contain\(\s*(['"][^'"]+['"])\s*\)/g,
    (m, haystack, lit) => `assert.match(${haystack}, ${wrapAsEscapedRegex(lit)})`)

  // 8.2) include/contain with object literal → assertObjectContains (allowed everywhere)
  out = out.replace(/expect\(([^)]+)\)\.to\.(?:contain|include)\(\s*(\{[^}]*\})\s*\)/g, 'assertObjectContains($1, $2)')
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\.to\.(?:contain|include)\(\s*(\{[^}]*\})\s*\)/g, 'assertObjectContains($1, $2)')
  // 8.21) include(objectLiteral) without chain
  out = out.replace(/expect\(([^)]+)\)\.to\.include\(\s*(\{[^}]*\})\s*\)/g, 'assertObjectContains($1, $2)')
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\.to\.include\(\s*(\{[^}]*\})\s*\)/g, 'assertObjectContains($1, $2)')
  // 8.3) deep.include with object literal → assertObjectContains
  out = out.replace(/expect\(([^)]+)\)\.to\.deep\.include\(\s*(\{[^}]*\})\s*\)/g, 'assertObjectContains($1, $2)')
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\.to\.deep\.include\(\s*(\{[^}]*\})\s*\)/g, 'assertObjectContains($1, $2)')
  // Skip generic include/contain for safety otherwise

  // 10) property
  // expect(obj).to.have.property('k').that.deep.equal(v) → deepStrictEqual(accessor, v)
  out = out.replace(/expect\(([^)]+)\)\.to\.have\.property\((['"][^'"]+['"])\)\.that\.deep\.equal\(([^)]+)\)/g,
    (m, obj, key, val) => `assert.deepStrictEqual(${buildAccessor(obj, key)}, ${val})`)
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\.to\.have\.property\((['"][^'"]+['"])\)\.that\.deep\.equal\(([^)]+)\)/g,
    (m, obj, key, val) => `assert.deepStrictEqual(${buildAccessor(obj, key)}, ${val})`)
  // expect(obj).to.have.property('k').that.equal(v) → strictEqual(accessor, v)
  out = out.replace(/expect\(([^)]+)\)\.to\.have\.property\((['"][^'"]+['"])\)\.that\.equal\(([^)]+)\)/g,
    (m, obj, key, val) => `assert.strictEqual(${buildAccessor(obj, key)}, ${val})`)
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\.to\.have\.property\((['"][^'"]+['"])\)\.that\.equal\(([^)]+)\)/g,
    (m, obj, key, val) => `assert.strictEqual(${buildAccessor(obj, key)}, ${val})`)
  // expect(obj).to.have.property('k').that.match(/re/) → match(accessor, /re/)
  out = out.replace(/expect\(([^)]+)\)\.to\.have\.property\((['"][^'"]+['"])\)\.that\.match\(([^)]+)\)/g,
    (m, obj, key, re) => `assert.match(${buildAccessor(obj, key)}, ${re})`)
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\.to\.have\.property\((['"][^'"]+['"])\)\.that\.match\(([^)]+)\)/g,
    (m, obj, key, re) => `assert.match(${buildAccessor(obj, key)}, ${re})`)
  // // Handle leftover chains after hasOwn conversion
  // out = out.replace(/assert\.ok\(Object\.hasOwn\(([^,]+),\s*(['"][^'"]+['"])\)\)\.that\.deep\.equal\(([^)]+)\)/g,
  //   (m, obj, key, val) => `assert.deepStrictEqual(${buildAccessor(obj, key)}, ${val})`)
  // out = out.replace(/assert\.ok\(Object\.hasOwn\(([^,]+),\s*(['"][^'"]+['"])\)\)\.that\.equal\(([^)]+)\)/g,
  //   (m, obj, key, val) => `assert.strictEqual(${buildAccessor(obj, key)}, ${val})`)
  // out = out.replace(/assert\.ok\(Object\.hasOwn\(([^,]+),\s*(['"][^'"]+['"])\)\)\.that\.match\(([^)]+)\)/g,
  //   (m, obj, key, re) => `assert.match(${buildAccessor(obj, key)}, ${re})`)
  // expect(obj).to.have.property('k', v) → assert.strictEqual(accessor, v)
  out = out.replace(/expect\(([^)]+)\)\.to\.have\.property\((['"][^'"]+['"]),\s*([^)]+)\)/g,
    (m, obj, key, val) => `assert.strictEqual(${buildAccessor(obj, key)}, ${val})`)
  // variable key: expect(obj).to.have.property(KEY, v)
  out = out.replace(/expect\(([^)]+)\)\.to\.have\.property\(([^,'")]+),\s*([^)]+)\)/g, 'assert.strictEqual($1[$2], $3)')
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\.to\.have\.property\(([^,'")]+),\s*([^)]+)\)/g, 'assert.strictEqual($1[$2], $3)')
  // expect(obj).to.have.property('k') → assert.ok(Object.hasOwn(obj, 'k')) (preserve key quoting rules)
  out = out.replace(/expect\(([^)]+)\)\.to\.have\.property\(([^,)]+)\)/g,
    'assert.ok(Object.hasOwn($1, $2))')
  // variable key presence: expect(obj).to.have.property(KEY)
  out = out.replace(/expect\(([^)]+)\)\.to\.have\.property\(([^,)]+)\)/g, 'assert.ok(Object.hasOwn($1, $2))')
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\.to\.have\.property\(([^,)]+)\)/g, 'assert.ok(Object.hasOwn($1, $2))')
  // not.have.property literal keys
  out = out.replace(/expect\(([^)]+)\)\.to\.not\.have\.property\(([^,)]+)\)/g,
    'assert.ok(!Object.hasOwn($1, $2))')
  out = out.replace(/expect\(([^)]+)\)\.not\.to\.have\.property\(([^,)]+)\)/g,
    'assert.ok(!Object.hasOwn($1, $2))')
  // ownProperty alias (literal keys)
  out = out.replace(/expect\(([^)]+)\)\.to\.have\.ownProperty\(([^,)]+)\)/g,
    'assert.ok(Object.hasOwn($1, $2))')
  out = out.replace(/expect\(([^)]+)\)\.to\.not\.have\.ownProperty\(([^,)]+)\)/g,
    'assert.ok(!Object.hasOwn($1, $2))')
  out = out.replace(/expect\(([^)]+)\)\.not\.to\.have\.ownProperty\(([^,)]+)\)/g,
    'assert.ok(!Object.hasOwn($1, $2))')

  // 11) lengthOf
  out = out.replace(/expect\(([^)]+)\)\.to\.(?:have\.)?lengthOf\(([^)]+)\)/g,
    'assert.strictEqual($1.length, $2)')
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\.to\.(?:have\.)?lengthOf\(([^)]+)\)/g,
    'assert.strictEqual($1.length, $2)')
  // length alias (chai): .length(n)
  out = out.replace(/expect\(([^)]+)\)\.to\.(?:have\.)?length\(([^)]+)\)/g,
    'assert.strictEqual($1.length, $2)')
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\.to\.(?:have\.)?length\(([^)]+)\)/g,
    'assert.strictEqual($1.length, $2)')
  // have.length.at.least/at.most
  out = out.replace(/expect\(([^)]+)\)\.to\.have\.length\.at\.least\(([^)]+)\)/g, 'assert.ok($1.length >= $2)')
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\.to\.have\.length\.at\.least\(([^)]+)\)/g, 'assert.ok($1.length >= $2)')
  out = out.replace(/expect\(([^)]+)\)\.to\.have\.length\.at\.most\(([^)]+)\)/g, 'assert.ok($1.length <= $2)')
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\.to\.have\.length\.at\.most\(([^)]+)\)/g, 'assert.ok($1.length <= $2)')
  // have.lengthOf.at.least/at.most
  out = out.replace(/expect\(([^)]+)\)\.to\.have\.lengthOf\.at\.least\(([^)]+)\)/g, 'assert.ok($1.length >= $2)')
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\.to\.have\.lengthOf\.at\.least\(([^)]+)\)/g, 'assert.ok($1.length >= $2)')
  out = out.replace(/expect\(([^)]+)\)\.to\.have\.lengthOf\.at\.most\(([^)]+)\)/g, 'assert.ok($1.length <= $2)')
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\.to\.have\.lengthOf\.at\.most\(([^)]+)\)/g, 'assert.ok($1.length <= $2)')
  // property(...).that.length(Of)?(n)
  out = out.replace(/expect\(([^)]+)\)\.to\.have\.property\((['"][^'"]+['"])\)\.that\.(?:have\.)?length(?:Of)?\(([^)]+)\)/g,
    (m, obj, key, val) => `assert.strictEqual(${buildAccessor(obj, key)}.length, ${val})`)

  // 12) Comparisons
  out = out.replace(/expect\(([^)]+)\)\.to\.be\.above\(([^)]+)\)/g, 'assert.ok($1 > $2)')
  out = out.replace(/expect\(([^)]+)\)\.to\.be\.at\.least\(([^)]+)\)/g, 'assert.ok($1 >= $2)')
  out = out.replace(/expect\(([^)]+)\)\.to\.be\.below\(([^)]+)\)/g, 'assert.ok($1 < $2)')
  out = out.replace(/expect\(([^)]+)\)\.to\.be\.at\.most\(([^)]+)\)/g, 'assert.ok($1 <= $2)')
  out = out.replace(/expect\(([^)]+)\)\.to\.be\.(?:lessThan|lt)\(([^)]+)\)/g, 'assert.ok($1 < $2)')
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\.to\.be\.(?:lessThan|lt)\(([^)]+)\)/g, 'assert.ok($1 < $2)')
  out = out.replace(/expect\(([^)]+)\)\.to\.be\.(?:greaterThan|gt)\(([^)]+)\)/g, 'assert.ok($1 > $2)')
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\.to\.be\.(?:greaterThan|gt)\(([^)]+)\)/g, 'assert.ok($1 > $2)')
  out = out.replace(/expect\(([^)]+)\)\.to\.be\.(?:gte)\(([^)]+)\)/g, 'assert.ok($1 >= $2)')
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\.to\.be\.(?:gte)\(([^)]+)\)/g, 'assert.ok($1 >= $2)')
  out = out.replace(/expect\(([^)]+)\)\.to\.be\.(?:lte)\(([^)]+)\)/g, 'assert.ok($1 <= $2)')
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\.to\.be\.(?:lte)\(([^)]+)\)/g, 'assert.ok($1 <= $2)')
  out = out.replace(/expect\(([^)]+)\)\.to\.be\.closeTo\(([^,]+),\s*([^)]+)\)/g,
    'assert.ok(Math.abs(($1) - ($2)) <= ($3))')

  // 12) Throws
  out = out.replace(/expect\(([^)]+)\)\.to\.throw\(\s*\)/g, 'assert.throws($1)')
  out = out.replace(/expect\(([^)]+)\)\.to\.throw\(([^)]+)\)/g, 'assert.throws($1, $2)')
  out = out.replace(/expect\(([^)]+)\)\.to\.not\.throw\(\s*\)/g, 'assert.doesNotThrow($1)')
  // function-call aware subject for throw
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\.to\.throw\(\s*\)/g, 'assert.throws($1)')
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\.to\.throw\(([^)]+)\)/g, 'assert.throws($1, $2)')
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\.to\.not\.throw\(\s*\)/g, 'assert.doesNotThrow($1)')

  // Bare hasOwnProperty truthiness: expect(obj.hasOwnProperty('k')) → assert.ok(obj.hasOwnProperty('k'))
  out = out.replace(/expect\(([^)]+?\.hasOwnProperty\([^)]*\))\)\s*(?!\.)/g, 'assert.ok($1)')

  // 13) Leave custom chai profile assertions as-is

  // 14) sinon-chai → sinon.assert
  out = out.replace(/expect\(([^)]+)\)\.to\.have\.been\.calledOnce\b/g, 'sinon.assert.calledOnce($1)')
  out = out.replace(/expect\(([^)]+)\)\.to\.be\.calledOnce\b/g, 'sinon.assert.calledOnce($1)')
  out = out.replace(/expect\(([^)]+)\)\.to\.have\.been\.calledTwice\b/g, 'sinon.assert.calledTwice($1)')
  out = out.replace(/expect\(([^)]+)\)\.to\.have\.been\.calledThrice\b/g, 'sinon.assert.calledThrice($1)')
  out = out.replace(/expect\(([^)]+)\)\.to\.have\.been\.called\b/g, 'sinon.assert.called($1)')
  out = out.replace(/expect\(([^)]+)\)\.to\.have\.been\.notCalled\b/g, 'sinon.assert.notCalled($1)')
  out = out.replace(/expect\(([^)]+)\)\.(?:to\.not|not\.to)\.have\.been\.called\b/g, 'sinon.assert.notCalled($1)')
  // also support: to.be.called
  out = out.replace(/expect\(([^)]+)\)\.to\.be\.called\b/g, 'sinon.assert.called($1)')
  out = out.replace(/expect\(([^)]+)\)\.to\.have\.been\.calledWithExactly\(([^)]+)\)/g,
    'sinon.assert.calledWithExactly($1, $2)')
  out = out.replace(/expect\(([^)]+)\)\.to\.have\.been\.calledWithMatch\(([^)]+)\)/g,
    'sinon.assert.calledWithMatch($1, $2)')
  out = out.replace(/expect\(([^)]+)\)\.to\.have\.been\.calledWith\(([^)]+)\)/g,
    'sinon.assert.calledWith($1, $2)')
  out = out.replace(/expect\(([^)]+)\)\.to\.have\.been\.calledOnceWithExactly\(\s*\)/g,
    'sinon.assert.calledOnce($1)')
  // calledOnceWith(Exactly) with args
  out = out.replace(/expect\(([^)]+)\)\.to\.have\.been\.calledOnceWithExactly\(([^)]*)\)/g,
    'sinon.assert.calledOnceWithExactly($1, $2)')
  out = out.replace(/expect\(([^)]+)\)\.to\.have\.been\.calledOnceWith\(([^)]*)\)/g,
    'sinon.assert.calledOnceWithExactly($1, $2)')
  // negative calledWith variants
  out = out.replace(/expect\(([^)]+)\)\.to\.not\.have\.been\.calledWith\(([^)]+)\)/g, 'sinon.assert.neverCalledWith($1, $2)')
  out = out.replace(/expect\(([^)]+)\)\.not\.to\.have\.been\.calledWith\(([^)]+)\)/g, 'sinon.assert.neverCalledWith($1, $2)')
  out = out.replace(/expect\(([^)]+)\)\.to\.not\.have\.been\.calledWithMatch\(([^)]+)\)/g, 'sinon.assert.neverCalledWithMatch($1, $2)')
  out = out.replace(/expect\(([^)]+)\)\.not\.to\.have\.been\.calledWithMatch\(([^)]+)\)/g, 'sinon.assert.neverCalledWithMatch($1, $2)')

  // 15) chai.assert style minimal mapping
  out = out.replace(/chai\.assert\.deepEqual\(([^)]+)\)/g, 'assert.deepStrictEqual($1)')
  out = out.replace(/chai\.assert\.equal\(([^)]+)\)/g, 'assert.strictEqual($1)')

  // 16) Insert Node assert only when safe. Otherwise, skip touching this file.
  const afterNonChaiAssertCount = (out.match(/(^|[^.\w$])assert\./g) || []).length
  const didReplaceAssert = afterNonChaiAssertCount > beforeNonChaiAssertCount
  const hasNodeAssertImportAfter = /\bconst\s+assert\s*=\s*require\(['"](node:)?assert(?:\/strict)?['"]\)/.test(out) ||
    /^\s*import\s+(?:\*\s+as\s+)?assert\s+from\s*['"](node:)?assert(?:\/strict)?['"]/m.test(out) ||
    /^\s*import\s*\{\s*strict\s+as\s+assert\s*\}\s*from\s*['"](node:)?assert['"]/m.test(out)
  const needsNodeAssertImport = /(^|[^.\w$])assert\./.test(out) && !hasNodeAssertImportAfter

  let insertedNodeAssert = false
  if (needsNodeAssertImport) {
    if (hasAssertVariableBefore && !hasNodeAssertImportBefore) {
      if (beforeNonChaiAssertCount > 0 && !didReplaceAssert) {
        return code
      }
      if (beforeNonChaiAssertCount > 0) {
        return code
      }
    }
    out = ensureAssertImport(out)
    insertedNodeAssert = true
  }

  // 17) deepEqualWithMockValues direct assertion mapping (keep plugin wiring lines)
  out = out.replace(/expect\(([^)]+)\)\.to\.deep(?:\.deep)?EqualWithMockValues\(([^)]+)\)/g, 'deepEqualWithMockValues($1, $2)')

  // 18) Fix concatenations caused by missing newline after assert import
  out = out.replace(/(const\s+assert\s*=\s*require\(['"]node:assert\/strict['"]\))([^\n])/g, '$1\n$2')

  // 19) Prefer strict assert if both imported; remove non-strict when strict present
  if (/require\(['"]node:assert\/strict['"]\)/.test(out)) {
    out = out.replace(/^\s*const\s+assert\s*=\s*require\(['"]node:assert['"]\)\s*;?\s*\n/mg, '')
  }

  // 19.5) Multi-line tolerant variants for common patterns (allow whitespace/newlines around dots)
  // Await rejected
  out = out.replace(/await\s+expect\(((?:[^()]|\([^()]*\))+?)\)\s*\.\s*to\s*\.\s*be\s*\.\s*rejectedWith\(([^)]+)\)/gs,
    'await assert.rejects($1, $2)')
  out = out.replace(/await\s+expect\(((?:[^()]|\([^()]*\))+?)\)\s*\.\s*to\s*\.\s*be\s*\.\s*rejected(?!With)/gs,
    'await assert.rejects($1)')
  // Equality
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\s*\.\s*to\s*\.\s*deep\s*\.\s*(?:equal|eql)\(([^)]+)\)/gs, 'assert.deepStrictEqual($1, $2)')
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\s*\.\s*to\s*\.\s*(?:be\s*\.\s*)?(?:equal|equals)\(([^)]+)\)/gs, 'assert.strictEqual($1, $2)')
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\s*\.\s*(?:to\s*\.\s*not|not\s*\.\s*to)\s*\.\s*(?:be\s*\.\s*)?(?:equal|equals)\(([^)]+)\)/gs, 'assert.notStrictEqual($1, $2)')
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\s*\.\s*(?:to\s*\.\s*not|not\s*\.\s*to)\s*\.\s*deep\s*\.\s*(?:equal|eql)\(([^)]+)\)/gs, 'assert.notDeepStrictEqual($1, $2)')
  // Truthiness
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\s*\.\s*to\s*\.\s*be\s*\.\s*true\b/gs, 'assert.strictEqual($1, true)')
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\s*\.\s*to\s*\.\s*be\s*\.\s*false\b/gs, 'assert.strictEqual($1, false)')
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\s*\.\s*to\s*\.\s*be\s*\.\s*ok\b/gs, 'assert.ok($1)')
  // Existence and types
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\s*\.\s*to\s*\.\s*exist\b/gs, 'assert.ok($1 != null)')
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\s*\.\s*to\s*\.\s*not\s*\.\s*exist\b/gs, 'assert.ok($1 == null)')
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\s*\.\s*to\s*\.\s*be\s*\.\s*(?:an|a)\(\s*['"]array['"]\s*\)/gs, 'assert.ok(Array.isArray($1))')
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\s*\.\s*to\s*\.\s*be\s*\.\s*(?:an|a)\(\s*['"]object['"]\s*\)/gs, "(assert.strictEqual(typeof $1, 'object'), assert.notStrictEqual($1, null))")
  // Regex matching
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\s*\.\s*to\s*\.\s*match\(([^)]+)\)/gs, 'assert.match($1, $2)')
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\s*\.\s*to\s*\.\s*not\s*\.\s*match\(([^)]+)\)/gs, 'assert.doesNotMatch($1, $2)')
  // Include/contain object literal
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\s*\.\s*to\s*\.\s*(?:contain|include)\(\s*(\{[^}]*\})\s*\)/gs, 'assertObjectContains($1, $2)')
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\s*\.\s*to\s*\.\s*deep\s*\.\s*include\(\s*(\{[^}]*\})\s*\)/gs, 'assertObjectContains($1, $2)')
  // Throws
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\s*\.\s*to\s*\.\s*throw\(\s*\)/gs, 'assert.throws($1)')
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\s*\.\s*to\s*\.\s*throw\(([^)]+)\)/gs, 'assert.throws($1, $2)')
  out = out.replace(/expect\(((?:[^()]|\([^()]*\))+?)\)\s*\.\s*to\s*\.\s*not\s*\.\s*throw\(\s*\)/gs, 'assert.doesNotThrow($1)')

  // 20) On full replacement, remove chai assert import and chai expect if unused
  const expectStillUsed = /(?:^|[^\w$])expect\s*(\(|\.)/.test(out)
  const chaiAssertCallsRemain = /\bchai\.assert\./.test(out)
  if (!expectStillUsed || !chaiAssertCallsRemain) {
    out = removeChaiImportsWhenReplaced(out, { dropAssert: !chaiAssertCallsRemain, dropExpect: !expectStillUsed })
  }

  // 21) If we introduced Node assert calls, fix mocha imports and sort imports by type
  if (didReplaceAssert && (insertedNodeAssert || hasNodeAssertImportBefore)) {
    out = ensureMochaImportsIfNeeded(out)
    out = rebuildImportsSortedByType(out)
  }

  // 22) If we inserted node:assert but no assert usages remain, remove the import we added
  if (insertedNodeAssert && !/\bassert\./.test(out)) {
    out = out.replace(/^[\t ]*const\s+assert\s*=\s*require\(['"]node:assert\/strict['"]\)\s*\n?\n?/m, '')
  }

  // 23) Remove unused default chai import/require if chai.* is no longer used
  {
    // Build a version without any chai import/require lines to check for real usage
    const outNoChaiImports = out
      .replace(/^\s*(?:const|let|var)\s+chai\s*=\s*require\(\s*['"]chai['"]\s*\)\s*;?\s*\n/mg, '')
      .replace(/^\s*import\s+chai\s+from\s*['"]chai['"]\s*;?\s*\n/mg, '')
      .replace(/^\s*import\s+chai\s*,\s*\{([^}]*)\}\s*from\s*(['"]chai['"])\s*;?\s*\n/mg,
        (m, names, from) => {
          const inner = names.split(',').map(s => s.trim()).filter(Boolean)
          if (!inner.length) return ''
          return `import { ${inner.join(', ')} } from ${from}\n`
        })
      .replace(/^\s*import\s*\{\s*\}\s*from\s*['"]chai['"]\s*;?\s*\n/mg, '')
      .replace(/^\s*(?:const|let|var)\s*\{\s*\}\s*=\s*require\(\s*['"]chai['"]\s*\)\s*;?\s*\n/mg, '')
    const chaiUsed = /\bchai\s*(?:[.[(])/.test(outNoChaiImports)
    if (!chaiUsed) {
      // Drop const/let/var chai = require('chai')
      out = out.replace(/^\s*(?:const|let|var)\s+chai\s*=\s*require\(\s*['"]chai['"]\s*\)\s*;?\s*\n/mg, '')
      // Drop import chai from 'chai'
      out = out.replace(/^\s*import\s+chai\s+from\s*['"]chai['"]\s*;?\s*\n/mg, '')
      // Convert 'import chai, { names } from' → 'import { names } from'
      out = out.replace(/^\s*import\s+chai\s*,\s*\{([^}]*)\}\s*from\s*(['"]chai['"])\s*;?\s*\n/mg,
        (m, names, from) => {
          const inner = names.split(',').map(s => s.trim()).filter(Boolean)
          if (!inner.length) return ''
          return `import { ${inner.join(', ')} } from ${from}\n`
        })
      // Remove empty named-only chai imports if any
      out = out.replace(/^\s*import\s*\{\s*\}\s*from\s*['"]chai['"]\s*;?\s*\n/mg, '')
      // Remove empty named-only chai requires if any
      out = out.replace(/^\s*(?:const|let|var)\s*\{\s*\}\s*=\s*require\(\s*['"]chai['"]\s*\)\s*;?\s*\n/mg, '')
    }
  }

  // 24) Prune unused named chai imports/requires (destructuring)
  out = pruneUnusedChaiNamedImports(out)

  // Format long assert lines to multiple lines when > 120 chars
  out = formatLongAssertCalls(out)
  return out
}

function isBrowserCypress (file) {
  const p = file.replace(/\\/g, '/')
  return p.includes('/integration-tests/cypress/e2e/') || p.endsWith('.cy.js') || p.endsWith('.cy.ts')
}

function main () {
  const patterns = [
    'packages/**/test/**/*.js',
    'integration-tests/**/*.js'
  ]
  const files = patterns.flatMap((pat) => glob.sync(path.join(ROOT, pat), { nodir: true }))
  let changed = 0
  const reverted = []
  const ignored = []
  for (const file of files) {
    if (isBrowserCypress(file)) continue
    const before = read(file)
    // Early skip if the file imports an 'expect' symbol from a non-chai module
    if (usesNonChaiExpect(before)) {
      ignored.push(file)
      continue
    }
    let after = transform(before, file)

    // If assertObjectContains is used, inject proper import path
    if (/\bassertObjectContains\(/.test(after)) {
      after = ensureAssertObjectContainsImport(after, file)
    }

    if (after !== before) {
      // Attempt to repair any broken destructured chai imports due to edge spacing
      after = after.replace(/^(\s*(?:const|let|var)\s*\{[^}]*)(=\s*require\(\s*["']chai["']\s*\))/mg,
        (m, head, tail) => head.trimEnd() + ' } ' + tail)
      after = after.replace(/^(\s*import\s*\{[^}]*)(\s*from\s*["']chai["'][^\n]*\n)/mg,
        (m, head, tail) => head.trimEnd() + ' } ' + tail)

      // Syntax validation: revert on failure; skip for ESM
      const isLikelyESM = /^\s*(?:import|export)\s/m.test(after)
      if (!isLikelyESM) {
        try {
          // eslint-disable-next-line no-new-func
          Function(after)
        } catch (e) {
          reverted.push(file)
          continue
        }
      }
      write(file, after)
      changed++
    }
  }
  // eslint-disable-next-line no-console
  console.log('chai-to-assert: updated', changed, 'files')
  if (ignored.length) {
    // eslint-disable-next-line no-console
    console.log('chai-to-assert: ignored files due to non-chai expect imports:')
    // eslint-disable-next-line no-console
    for (const f of ignored) console.log(' - ' + f)
  }
  if (reverted.length) {
    // eslint-disable-next-line no-console
    console.log('chai-to-assert: reverted due to syntax errors in:')
    // eslint-disable-next-line no-console
    for (const f of reverted) console.log(' - ' + f)
  }
}

if (require.main === module) {
  main()
}
