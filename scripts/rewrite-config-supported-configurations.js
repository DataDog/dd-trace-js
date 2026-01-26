'use strict'

/**
 * Rewrites `packages/dd-trace/src/config/supported-configurations.json` to the new schema:
 * - top-level: { version: string, supportedConfigurations: Record<string, Entry[]> }
 * - per env var: [{ implementation, type, description, default?, aliases?, deprecations? }]
 *
 * Notes:
 * - `type` is the user input type, but should match how the tracer parses the value.
 *   Mismatches are reported but not auto-fixed.
 * - `default` is optional and comes from `packages/dd-trace/src/config/defaults.js` when resolvable.
 * - Top-level aliases/deprecations from the old schema are migrated into entry objects.
 *
 * This script is intended as a one-time migration helper and a future regen tool.
 */

const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const REPO_ROOT = path.resolve(__dirname, '..')
const SUPPORTED_JSON_PATH = path.join(REPO_ROOT, 'packages/dd-trace/src/config/supported-configurations.json')
const SUPPORTED_OVERRIDES_JSON_PATH = path.join(
  REPO_ROOT,
  'packages/dd-trace/src/config/supported-configurations.overrides.json'
)
const CONFIG_INDEX_JS_PATH = path.join(REPO_ROOT, 'packages/dd-trace/src/config/index.js')
const DEFAULTS_JS_PATH = path.join(REPO_ROOT, 'packages/dd-trace/src/config/defaults.js')
const INDEX_D_TS_PATH = path.join(REPO_ROOT, 'index.d.ts')
const DOCS_REPORT_PATH = path.join(
  REPO_ROOT,
  'packages/dd-trace/src/config/supported-configurations.docs-report.json'
)
const ENRICH_REPORT_PATH = path.join(
  REPO_ROOT,
  'packages/dd-trace/src/config/supported-configurations.enrichment-report.json'
)

const ENV_VAR_NAME_RE = /^(?:DD|OTEL)_[A-Z0-9_]+$/

/**
 * @typedef {string | number | boolean | null} JSONPrimitive
 * @typedef {JSONPrimitive | Record<string, unknown> | unknown[]} JSONValue
 * @typedef {{ replacedBy: string }} Deprecations
 * @typedef {{
 *   implementation: string,
 *   type: string,
 *   description: string,
 *   programmaticConfig?: string,
 *   default?: JSONValue,
 *   aliases?: string[],
 *   deprecations?: Deprecations
 * }} SupportedConfigurationEntry
 *
 * @typedef {'high'|'medium'|'low'} Confidence
 * @typedef {string} CandidateSource
 * @typedef {{ file: string, line?: number, snippet?: string }} Evidence
 * @typedef {{
 *   field: 'type'|'description',
 *   value: string,
 *   source: CandidateSource,
 *   confidence: Confidence,
 *   evidence?: Evidence[],
 *   meta?: Record<string, unknown>
 * }} Candidate
 * @typedef {{
 *   value: string,
 *   source?: CandidateSource,
 *   confidence?: Confidence,
 *   keptExisting?: boolean
 * }} ChosenCandidate
 * @typedef {{ value: unknown, evidence: Evidence }} DefaultEvidence
 */

function read (file) {
  return fs.readFileSync(file, 'utf8')
}

function writeJSON (file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8')
}

function tryReadJSON (file) {
  try {
    return JSON.parse(read(file))
  } catch {
    return undefined
  }
}

function parseSimpleLiteral (src) {
  if (!src) return
  const s = String(src).trim()
  if (!s) return
  if (s === 'true') return true
  if (s === 'false') return false
  if (s === '[]') return []
  if (s === '{}') return {}
  if (/^['"`][\s\S]*['"`]$/.test(s)) return s.slice(1, -1)
  const n = s.replace(/_/g, '')
  if (/^-?\d+$/.test(n)) return Number.parseInt(n, 10)
  if (/^-?\d+\.\d+$/.test(n)) return Number.parseFloat(n)
}

function parseSimpleNumberExpression (src) {
  // Very small evaluator for patterns like "65 * 1000" or "60_000"
  const s = String(src).trim()
  const lit = parseSimpleLiteral(s)
  if (typeof lit === 'number') return lit
  const mul = s.match(/^\s*(\d[\d_]*)\s*\*\s*(\d[\d_]*)\s*$/)
  if (mul) {
    const a = Number.parseInt(mul[1].replace(/_/g, ''), 10)
    const b = Number.parseInt(mul[2].replace(/_/g, ''), 10)
    if (Number.isFinite(a) && Number.isFinite(b)) return a * b
  }
}

function scanCodeForEnvDefaultEvidence (roots) {
  /** @type {Record<string, { value: unknown, file: string, line: number, snippet: string }[]>} */
  const literalByEnv = {}
  /** @type {Record<string, { value: boolean | '$dynamic', file: string, line: number, snippet: string }[]>} */
  const booleanByEnv = {}

  const pushLiteral = (env, value, file, line, snippet) => {
    literalByEnv[env] ??= []
    literalByEnv[env].push({ value, file, line, snippet })
  }
  const pushBool = (env, value, file, line, snippet) => {
    booleanByEnv[env] ??= []
    booleanByEnv[env].push({ value, file, line, snippet })
  }

  const stack = roots.filter(p => fs.existsSync(p))
  while (stack.length) {
    const cur = stack.pop()
    let st
    try {
      st = fs.statSync(cur)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      const entries = fs.readdirSync(cur)
      for (const e of entries) {
        if (e === 'node_modules' || e === 'vendor' || e === 'dist') continue
        stack.push(path.join(cur, e))
      }
      continue
    }
    if (!st.isFile() || !cur.endsWith('.js')) continue

    let content
    try {
      content = fs.readFileSync(cur, 'utf8')
    } catch {
      continue
    }

    // Build a tiny const map for this file: const FOO = <literal/numberexpr>
    /** @type {Record<string, unknown>} */
    const constMap = {}
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const m = line.match(/^\s*const\s+([A-Z0-9_]+)\s*=\s*([^;]+);?\s*$/)
      if (!m) continue
      const name = m[1]
      const expr = m[2].trim()
      const val = parseSimpleLiteral(expr) ?? parseSimpleNumberExpression(expr)
      if (val !== undefined) constMap[name] = val
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]

      // --- literal fallbacks ---
      let m = line.match(/getValueFromEnvSources\(\s*['"]((?:DD|OTEL)_[A-Z0-9_]+)['"]\s*\)\s*(\?\?|\|\|)\s*([^;]+)$/)
      if (m) {
        const env = m[1]
        const fallbackSrc = m[3].trim()
        /** @type {unknown} */
        let value = parseSimpleLiteral(fallbackSrc) ?? parseSimpleNumberExpression(fallbackSrc)
        if (value === undefined && /^[A-Z0-9_]+$/.test(fallbackSrc) && Object.hasOwn(constMap, fallbackSrc)) {
          value = constMap[fallbackSrc]
        }
        if (value !== undefined) pushLiteral(env, value, cur, i + 1, line.trim())
        continue
      }

      m = line.match(/Number\.parseInt\(\s*getValueFromEnvSources\(\s*['"]((?:DD|OTEL)_[A-Z0-9_]+)['"]\s*\)[^)]*\)\s*(\?\?|\|\|)\s*([^;]+)$/)
      if (m) {
        const env = m[1]
        const fallbackSrc = m[3].trim()
        /** @type {unknown} */
        let value = parseSimpleNumberExpression(fallbackSrc)
        if (value === undefined && /^[A-Z0-9_]+$/.test(fallbackSrc) && Object.hasOwn(constMap, fallbackSrc)) {
          const v = constMap[fallbackSrc]
          value = typeof v === 'number' ? v : undefined
        }
        if (value !== undefined) pushLiteral(env, value, cur, i + 1, line.trim())
        continue
      }

      // --- boolean semantics ---
      m = line.match(/isTrue\(\s*getValueFromEnvSources\(\s*['"]((?:DD|OTEL)_[A-Z0-9_]+)['"]\s*\)\s*\)/)
      if (m) {
        pushBool(m[1], false, cur, i + 1, line.trim())
        continue
      }
      m = line.match(/!\s*isFalse\(\s*getValueFromEnvSources\(\s*['"]((?:DD|OTEL)_[A-Z0-9_]+)['"]\s*\)\s*\)/)
      if (m) {
        pushBool(m[1], true, cur, i + 1, line.trim())
        continue
      }
      m = line.match(/isTrue\(\s*((?:DD|OTEL)_[A-Z0-9_]+)\s*\?\?\s*(true|false)\s*\)/)
      if (m) {
        pushBool(m[1], m[2] === 'true', cur, i + 1, line.trim())
        continue
      }
      m = line.match(/isTrue\(\s*((?:DD|OTEL)_[A-Z0-9_]+)\s*\?\?\s*([^)]+)\)/)
      if (m) {
        const rhs = m[2].trim()
        if (rhs !== 'true' && rhs !== 'false') {
          pushBool(m[1], '$dynamic', cur, i + 1, line.trim())
        }
      }
    }
  }

  for (const envVar of Object.keys(booleanByEnv)) {
    // Prefer static boolean over '$dynamic' for the same env var (more precise).
    booleanByEnv[envVar].sort((a, b) => (a.value === '$dynamic' ? 1 : 0) - (b.value === '$dynamic' ? 1 : 0))
  }

  return { literalByEnv, booleanByEnv }
}

function confidenceRank (c) {
  switch (c) {
    case 'high': return 3
    case 'medium': return 2
    case 'low': return 1
    default: return 0
  }
}

function sourceRank (s) {
  switch (s) {
    case 'dts': return 100
    case 'code_parse': return 95
    case 'code_comment': return 90
    case 'docs_nodejs': return 85
    case 'docs_other': return 80
    case 'tests': return 70
    case 'inherited': return 60
    case 'heuristic': return 10
    default: return 0
  }
}

function chooseCandidate (existingValue, candidates, overwriteExisting = false) {
  if (!overwriteExisting && existingValue && existingValue !== '__UNKNOWN__') {
    return { value: existingValue, chosen: undefined, keptExisting: true }
  }
  const usable = candidates.filter(c => c && typeof c.value === 'string' && c.value.length > 0)
  if (usable.length === 0) return { value: '__UNKNOWN__', chosen: undefined, keptExisting: false }
  usable.sort((a, b) => {
    const c = confidenceRank(b.confidence) - confidenceRank(a.confidence)
    if (c !== 0) return c
    const s = sourceRank(b.source) - sourceRank(a.source)
    if (s !== 0) return s
    return a.value.localeCompare(b.value)
  })
  return { value: usable[0].value, chosen: usable[0], keptExisting: false }
}

function normalizeDescriptionCase (description) {
  if (!description || description === '__UNKNOWN__') return description
  const s = String(description)
  // Find first alphabetic character and uppercase if it is lowercase
  const idx = s.search(/[A-Za-z]/)
  if (idx === -1) return s
  const ch = s[idx]
  if (ch >= 'a' && ch <= 'z') {
    return s.slice(0, idx) + ch.toUpperCase() + s.slice(idx + 1)
  }
  return s
}

function sanitizeDescriptionArtifacts (description) {
  if (!description || description === '__UNKNOWN__') return description
  let s = String(description)
  // Normalize line endings and trim end.
  s = s.replace(/\r\n/g, '\n').replace(/[ \t]+$/g, '').replace(/\s+$/g, '')
  // Strip common comment artifacts that sometimes sneak into extracted text.
  // - a lone "/" on its own line at the end (e.g., "...\n/")  (seen in DD_PROFILING_ENABLED)
  // - a closing "*/" on its own line at the end
  s = s.replace(/\n\s*\/\s*$/g, '')
  s = s.replace(/\n\s*\*\/\s*$/g, '')
  // Some sources can still leave a trailing bare "*/" without the newline.
  s = s.replace(/\*\/\s*$/g, '')
  // Normalize newlines to <br> so markdown-ish descriptions are stable in JSON.
  // Keep multiple newlines as multiple <br> for paragraph separation.
  s = s.trimEnd().replace(/\n/g, '<br>')
  return s
}

function isTruncatedPrefix (prefix, full) {
  if (!prefix || !full) return false
  const normalize = (s) => String(s)
    .replace(/`/g, '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  const a = normalize(prefix)
  const b = normalize(full)
  if (!a || !b) return false
  if (b.length <= a.length) return false
  return b.startsWith(a)
}

function createJsSourceFile (filename, src) {
  return ts.createSourceFile(filename, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
}

function parseDefaultsJsMetadata (defaultsSrc) {
  const sf = createJsSourceFile(DEFAULTS_JS_PATH, defaultsSrc)
  const varInitMap = buildVarInitMap(sf)

  /** @type {Set<string>} */
  const importedConstIdents = new Set()

  /** @param {ts.Node} node */
  function collectImports (node) {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)) {
      const callee = node.initializer.expression
      if (ts.isIdentifier(callee) && callee.text === 'require') {
        if (ts.isObjectBindingPattern(node.name)) {
          for (const el of node.name.elements) {
            if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) importedConstIdents.add(el.name.text)
          }
        } else if (ts.isIdentifier(node.name)) {
          importedConstIdents.add(node.name.text)
        }
      }
    }
    ts.forEachChild(node, collectImports)
  }
  ts.forEachChild(sf, collectImports)

  /**
   * @param {ts.Expression} expr
   * @param {Set<string>} seen
   * @returns {JSONValue | '$dynamic' | '__UNSET__' | undefined}
   */
  function tryEval (expr, seen = new Set()) {
    if (!expr) return
    if (ts.isIdentifier(expr)) {
      if (expr.text === 'undefined') return '__UNSET__'
      // pkg.* values are version/name dependent, so treat as dynamic.
      if (expr.text === 'pkg') return '$dynamic'
      if (varInitMap.has(expr.text) && !seen.has(expr.text)) {
        seen.add(expr.text)
        return tryEval(/** @type {ts.Expression} */ (varInitMap.get(expr.text)), seen)
      }
      // Imported constants (like GRPC_CLIENT_ERROR_STATUSES) are stable within this version; treat as "unknown here".
      return importedConstIdents.has(expr.text) ? undefined : '$dynamic'
    }
    if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === 'pkg') {
      return '$dynamic'
    }
    if (ts.isCallExpression(expr)) {
      // env-based computation is dynamic
      if (ts.isIdentifier(expr.expression) && expr.expression.text === 'getEnv') return '$dynamic'
      return '$dynamic'
    }
    if (ts.isBinaryExpression(expr)) {
      // any branching on runtime values makes it dynamic
      const op = expr.operatorToken.kind
      if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
        return '$dynamic'
      }
      const left = tryEval(expr.left, seen)
      const right = tryEval(expr.right, seen)
      if (typeof left === 'number' && typeof right === 'number') {
        switch (expr.operatorToken.kind) {
          case ts.SyntaxKind.AsteriskToken: return left * right
          case ts.SyntaxKind.SlashToken: return left / right
          case ts.SyntaxKind.PlusToken: return left + right
          case ts.SyntaxKind.MinusToken: return left - right
        }
      }
      return '$dynamic'
    }
    if (ts.isNumericLiteral(expr)) return Number(expr.text.replace(/_/g, ''))
    if (expr.kind === ts.SyntaxKind.TrueKeyword) return true
    if (expr.kind === ts.SyntaxKind.FalseKeyword) return false
    if (ts.isStringLiteral(expr)) return expr.text
    if (ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text
    if (ts.isPrefixUnaryExpression(expr) && ts.isNumericLiteral(expr.operand)) {
      const n = Number(expr.operand.text.replace(/_/g, ''))
      if (expr.operator === ts.SyntaxKind.MinusToken) return -n
      if (expr.operator === ts.SyntaxKind.PlusToken) return n
    }
    if (ts.isTaggedTemplateExpression(expr)) {
      // Support String.raw`...` which is used for constant regex strings.
      if (ts.isPropertyAccessExpression(expr.tag) &&
          ts.isIdentifier(expr.tag.expression) &&
          expr.tag.expression.text === 'String' &&
          expr.tag.name.text === 'raw' &&
          ts.isNoSubstitutionTemplateLiteral(expr.template)) {
        return expr.template.rawText ?? expr.template.text
      }
      return '$dynamic'
    }
    if (ts.isArrayLiteralExpression(expr)) {
      const arr = []
      for (const el of expr.elements) {
        const v = tryEval(el, seen)
        if (v === '$dynamic' || v === undefined) return '$dynamic'
        if (v === '__UNSET__') return '$dynamic'
        arr.push(v)
      }
      return arr
    }
    if (ts.isObjectLiteralExpression(expr)) {
      /** @type {Record<string, unknown>} */
      const obj = {}
      for (const prop of expr.properties) {
        if (ts.isPropertyAssignment(prop)) {
          let key
          if (ts.isIdentifier(prop.name)) key = prop.name.text
          else if (ts.isStringLiteral(prop.name)) key = prop.name.text
          if (!key) return '$dynamic'
          const v = tryEval(prop.initializer, seen)
          if (v === '$dynamic' || v === undefined) return '$dynamic'
          if (v === '__UNSET__') return '$dynamic'
          obj[key] = v
        } else {
          return '$dynamic'
        }
      }
      return /** @type {JSONValue} */ (obj)
    }
  }

  /** @type {Record<string, { kind: 'dynamic'|'static'|'unset', value?: JSONValue }>} */
  const byKey = {}

  /** @param {ts.Node} node */
  function findExports (node) {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      if (ts.isPropertyAccessExpression(node.left) &&
          ts.isIdentifier(node.left.expression) &&
          node.left.expression.text === 'module' &&
          node.left.name.text === 'exports' &&
          ts.isObjectLiteralExpression(node.right)) {
        for (const prop of node.right.properties) {
          if (ts.isPropertyAssignment(prop)) {
            let key
            if (ts.isIdentifier(prop.name)) key = prop.name.text
            else if (ts.isStringLiteral(prop.name)) key = prop.name.text
            if (!key) continue
            const v = tryEval(prop.initializer)
            if (v === '$dynamic') byKey[key] = { kind: 'dynamic' }
            else if (v === '__UNSET__') byKey[key] = { kind: 'unset' }
            else if (v !== undefined) byKey[key] = { kind: 'static', value: /** @type {JSONValue} */ (v) }
          } else if (ts.isShorthandPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
            const key = prop.name.text
            const v = tryEval(prop.name)
            if (v === '$dynamic') byKey[key] = { kind: 'dynamic' }
            else if (v === '__UNSET__') byKey[key] = { kind: 'unset' }
            else if (v !== undefined) byKey[key] = { kind: 'static', value: /** @type {JSONValue} */ (v) }
          }
        }
      }
    }
    ts.forEachChild(node, findExports)
  }
  ts.forEachChild(sf, findExports)

  return byKey
}

function normalizeDescriptionCandidate (value) {
  if (!value) return
  let s = String(value).trim()
  if (!s) return
  if (/^\s*TODO\b/i.test(s)) return
  s = s.split('\n')[0].trim()
  if (!s) return
  const idx = s.search(/[.!?]\s/)
  if (idx !== -1) s = s.slice(0, idx + 1)
  if (s.length > 200) s = s.slice(0, 197) + '...'
  return s
}

function getLeadingCommentText (fullText, node) {
  const ranges = ts.getLeadingCommentRanges(fullText, node.getFullStart()) || []
  if (ranges.length === 0) return
  const last = ranges[ranges.length - 1]
  const raw = fullText.slice(last.pos, last.end)
  if (raw.startsWith('/*')) {
    const inner = raw.replace(/^\/\*\*?/, '').replace(/\*\/$/, '')
    const lines = inner.split('\n').map(l => l.replace(/^\s*\*?/, '').trim()).filter(Boolean)
    return normalizeDescriptionCandidate(lines[0])
  }
  if (raw.startsWith('//')) {
    return normalizeDescriptionCandidate(raw.replace(/^\/\/\s?/, ''))
  }
}

function findPrivateMethodBlock (sourceFile, methodName) {
  const cleanName = methodName.startsWith('#') ? methodName : `#${methodName}`
  /** @type {ts.Block | undefined} */
  let block

  /** @param {ts.Node} node */
  function visit (node) {
    if (block) return
    if (ts.isMethodDeclaration(node) && node.body && ts.isPrivateIdentifier(node.name)) {
      if (node.name.text === cleanName) {
        block = node.body
        return
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return block
}

function buildVarInitMap (root) {
  /** @type {Map<string, ts.Expression>} */
  const map = new Map()

  /** @param {ts.Node} node */
  function visit (node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      map.set(node.name.text, node.initializer)
    }
    ts.forEachChild(node, visit)
  }

  visit(root)
  return map
}

function collectEnvVarsFromNode (node, varInitMap, out, seenVars = new Set()) {
  /** @param {ts.Node} n */
  function visit (n) {
    if (ts.isIdentifier(n)) {
      if (ENV_VAR_NAME_RE.test(n.text)) {
        out.add(n.text)
      } else if (varInitMap.has(n.text) && !seenVars.has(n.text)) {
        seenVars.add(n.text)
        visit(varInitMap.get(n.text))
      }
    } else if (ts.isCallExpression(n)) {
      if (ts.isIdentifier(n.expression) && n.expression.text === 'getEnv') {
        const arg = n.arguments[0]
        if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
          if (ENV_VAR_NAME_RE.test(arg.text)) out.add(arg.text)
        }
      }
    }
    ts.forEachChild(n, visit)
  }

  if (node) visit(node)
}

function addToSetMap (map, key, value) {
  if (!key || !value) return
  if (!map[key]) map[key] = new Set()
  map[key].add(value)
}

function filterToDeepestPaths (paths) {
  const unique = Array.from(new Set(paths)).filter(Boolean)
  return unique.filter(p => !unique.some(other => other !== p && other.startsWith(`${p}.`)))
}

function inferInputTypeFromSetter (setterName) {
  switch (setterName) {
    case '#setBoolean': return 'boolean'
    case '#setString': return 'string'
    case '#setArray': return 'array'
    case '#setUnit': return 'float'
    case '#setIntegerRangeSet': return 'string'
    case '#setSamplingRule': return 'json'
    case '#setTags': return 'string'
    default: return undefined
  }
}

function inferInputTypeFromExpressionText (exprText) {
  if (!exprText) return undefined
  if (/\bmaybeInt\s*\(/.test(exprText) || /\bnonNegInt\s*\(/.test(exprText)) return 'int'
  if (/\bmaybeFloat\s*\(/.test(exprText)) return 'float'
  if (/\bsafeJsonParse\s*\(/.test(exprText) || /\bmaybeJsonFile\s*\(/.test(exprText)) return 'json'
  if (/\bsplitJSONPathRules\s*\(/.test(exprText)) return 'array'
  return undefined
}

function inferInternalTypeFromDefault (value) {
  if (value === undefined) return undefined
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  switch (typeof value) {
    case 'boolean': return 'boolean'
    case 'number': return Number.isInteger(value) ? 'int' : 'float'
    case 'string': return 'string'
    case 'object': return 'object'
    default: return undefined
  }
}

function extractCommentDescriptionsFromApplyConfigValues (configSrc) {
  const sf = createJsSourceFile(CONFIG_INDEX_JS_PATH, configSrc)
  const body = findPrivateMethodBlock(sf, '#applyConfigValues')
  if (!body) return { byInternalKey: {}, byEnvVar: {} }
  const varInitMap = buildVarInitMap(body)
  const fullText = sf.getFullText()

  /** @type {Record<string, string>} */
  const byInternalKey = {}
  /** @type {Record<string, string>} */
  const byEnvVar = {}

  function maybeAdd (internalKey, exprNode, commentText) {
    const normalized = normalizeDescriptionCandidate(commentText)
    if (!normalized) return

    if (internalKey && !byInternalKey[internalKey]) {
      byInternalKey[internalKey] = normalized
    }

    const envs = new Set()
    collectEnvVarsFromNode(exprNode, varInitMap, envs)
    for (const env of envs) {
      if (!byEnvVar[env]) byEnvVar[env] = normalized
    }
  }

  /** @param {ts.Node} node */
  function visit (node) {
    if (ts.isCallExpression(node) &&
        (ts.isPropertyAccessExpression(node.expression) || ts.isPropertyAccessChain(node.expression))) {
      const callee = node.expression
      if (callee.expression.kind === ts.SyntaxKind.ThisKeyword && ts.isPrivateIdentifier(callee.name)) {
        const [first, second, third] = node.arguments
        if (first && ts.isIdentifier(first) && first.text === 'target' && third) {
          if (second && (ts.isStringLiteral(second) || ts.isNoSubstitutionTemplateLiteral(second))) {
            const commentText = getLeadingCommentText(fullText, node)
            maybeAdd(second.text, third, commentText)
          }
        }
      }
    }

    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      if (ts.isPropertyAccessExpression(node.left) &&
          ts.isIdentifier(node.left.expression) &&
          node.left.expression.text === 'target') {
        const commentText = getLeadingCommentText(fullText, node)
        maybeAdd(node.left.name.text, node.right, commentText)
      }
      if (ts.isElementAccessExpression(node.left) &&
          ts.isIdentifier(node.left.expression) &&
          node.left.expression.text === 'target') {
        const arg = node.left.argumentExpression
        if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
          const commentText = getLeadingCommentText(fullText, node)
          maybeAdd(arg.text, node.right, commentText)
        }
      }
    }

    ts.forEachChild(node, visit)
  }

  ts.forEachChild(body, visit)
  return { byInternalKey, byEnvVar }
}

function normalizeTypeFromTs (tsTypeString) {
  if (!tsTypeString) return undefined
  const t = tsTypeString.replace(/\s+/g, ' ').trim()
  if (/\bstring\[\]\b/.test(t)) return 'array'
  if (t.includes('boolean')) return 'boolean'
  if (t.includes('string')) return 'string'
  if (t.includes('number')) return 'float'
  if (/\bRecord<\s*string/.test(t) || /\{\s*\[key:\s*string\]/.test(t)) return 'map'
  if (t.includes('SamplingRule') || t.includes('SpanSamplingRule') || t.includes('object')) return 'json'
  return undefined
}

function isLikelyEnglish (text) {
  if (!text) return false
  const s = String(text)
  // Strong signal for non-English in our current dataset: accented latin characters.
  if (/[àâäçéèêëîïôöùûüÿœ]/i.test(s)) return false

  // Common French/Portuguese/Spanish markers that show up in docs extracts.
  if (/\b(votre|clé|obligatoire|définit|valeur|permet|journalisation)\b/i.test(s)) return false
  if (/\b(definir|valor predeterminado|obrigat[óo]rio)\b/i.test(s)) return false
  return true
}

function translateToEnglishIfKnown (text) {
  if (!text) return
  const s = String(text).trim()
  // Keep translations short and stable (first sentence), since this is config documentation.
  if (/Cl[ée] d'API Datadog/i.test(s)) return 'Datadog API key - Required.'
  if (/Votre cl[ée] d'application Datadog/i.test(s)) {
    return 'Datadog application key. Store this key as a secret.'
  }
  if (/^\s*D[ée]finit le niveau de journalisation/i.test(s)) {
    return 'Sets the log level (trace, debug, info, warn, error, critical, or off).'
  }
  if (/Cette option vous permet d'activer l'envoi des donn[ée]es de t[ée]l[ée]m[ée]trie/i.test(s)) {
    return 'Enables sending telemetry data to Datadog.'
  }
  if (/Active la collecte de traces/i.test(s)) return 'Enables trace collection.'
  if (/D[ée]finissez cette option sur true pour g[ée]n[ée]rer/i.test(s)) {
    return 'Set to true to generate 128-bit trace IDs, or false to generate 64-bit trace IDs.'
  }
}

function inferTypeFromDefaultString (raw) {
  if (!raw) return
  const s = String(raw).trim().replace(/`/g, '')
  if (!s) return
  const lower = s.toLowerCase()
  if (lower === 'true' || lower === 'false') return 'boolean'
  if (/^-?\d+$/.test(s)) return 'int'
  if (/^-?\d+\.\d+$/.test(s)) return 'float'
  if (s.includes(',') && !s.includes('://')) return 'array'
}

function extractFullDescriptionFromJsDocText (text) {
  if (!text) return
  const lines = text.split('\n')
  /** @type {string[]} */
  const out = []
  for (const line of lines) {
    const cleaned = line.replace(/^\s*\/\*\*?/, '')
      .replace(/^\s*\*?/, '')
      .replace(/\*\/\s*$/, '')
      .trim()
    if (cleaned === '/') continue
    if (!cleaned) {
      // preserve paragraph breaks
      if (out.length && out[out.length - 1] !== '') out.push('')
      continue
    }
    if (cleaned.startsWith('@')) break
    out.push(cleaned)
  }
  // trim leading/trailing empty lines
  while (out.length && out[0] === '') out.shift()
  while (out.length && out[out.length - 1] === '') out.pop()
  const s = out.join('\n').trim()
    // If the closing "*/" was included on the same line, strip any trailing "/" line.
    .replace(/\n\s*\/\s*$/, '')
  return s || undefined
}

function extractDefaultFromJsDocText (text) {
  if (!text) return
  const m = text.match(/@default\s+([^\n\r*]+)/)
  if (!m) return
  const raw = m[1].trim()
  if (!raw) return

  const unquoted = raw.replace(/^['"`]/, '').replace(/['"`]$/, '')
  const s = unquoted.trim()

  const lower = s.toLowerCase()
  if (lower === 'true') return true
  if (lower === 'false') return false

  const numeric = s.replace(/_/g, '')
  if (/^-?\d+$/.test(numeric)) return Number.parseInt(numeric, 10)
  if (/^-?\d+\.\d+$/.test(numeric)) return Number.parseFloat(numeric)

  if (s === '[]') return []
  if (s === '{}') return {}

  return s
}

function extractAllowedStringLiteralsFromTsType (tsTypeString) {
  if (!tsTypeString) return
  // Best-effort: "'a' | 'b' | 'c'"
  const m = tsTypeString.match(/'([^']+)'/g)
  if (!m) return
  const values = m.map(x => x.slice(1, -1))
  return Array.from(new Set(values))
}

function buildTracerOptionsMetadata () {
  const program = ts.createProgram([INDEX_D_TS_PATH], { allowJs: false, checkJs: false, skipLibCheck: true })
  const checker = program.getTypeChecker()
  const sf = program.getSourceFile(INDEX_D_TS_PATH)
  if (!sf) throw new Error('Could not load index.d.ts')
  /** @type {ts.SourceFile} */
  const sourceFile = sf

  /** @type {ts.InterfaceDeclaration | undefined} */
  let tracerOptionsDecl
  /** @param {ts.Node} node */
  function visit (node) {
    if (tracerOptionsDecl) return
    if (ts.isInterfaceDeclaration(node) && node.name.text === 'TracerOptions') {
      tracerOptionsDecl = node
      return
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(sourceFile, visit)
  if (!tracerOptionsDecl) throw new Error('Could not find TracerOptions in index.d.ts')

  const rootType = checker.getTypeAtLocation(tracerOptionsDecl)

  /** @type {Map<string, string>} */
  const typeByPath = new Map()
  /** @type {Map<string, string>} */
  const jsDocByPath = new Map()
  /** @type {Set<string>} */
  const containerPaths = new Set()
  /** @type {Record<string, string[]>} envVar -> optionPaths */
  const envVarToOptionPaths = {}
  /** @type {Record<string, string[]>} optionPath -> envVars */
  const optionPathToEnvVars = {}

  function isFunctionLike (type) {
    return type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0
  }
  function isArrayLike (type) {
    return checker.isArrayType(type) || checker.isTupleType(type)
  }

  function getObjectLikeConstituents (type) {
    if (typeof type.isUnion === 'function' && type.isUnion()) {
      return type.types.flatMap(getObjectLikeConstituents)
    }
    if (typeof type.isIntersection === 'function' && type.isIntersection()) {
      return type.types.flatMap(getObjectLikeConstituents)
    }
    if (isArrayLike(type) || isFunctionLike(type)) return []
    if (type.flags & ts.TypeFlags.Object) return [type]
    return []
  }

  const visited = new WeakMap()
  function shouldRecurse (type) {
    if (isFunctionLike(type) || isArrayLike(type)) return false
    const objectLikes = getObjectLikeConstituents(type)
    return objectLikes.some(t => t.getProperties().length > 0)
  }

  function maybeStoreJsDoc (path, decl) {
    if (!decl) return

    const jsDocs = decl.jsDoc
    if (jsDocs && jsDocs.length > 0) {
      const jsDoc = jsDocs[jsDocs.length - 1]
      const text = jsDoc.getText(sourceFile)
      if (text) jsDocByPath.set(path, text)
    }

    // Parse @env tags for mapping between env var names and TracerOptions paths.
    // Prefer structured JSDoc tags over regex, because the file has some weird formatting.
    /** @type {readonly ts.JSDocTag[]} */
    const tags = ts.getJSDocTags(decl) || []
    for (const tag of tags) {
      if (!tag?.tagName || tag.tagName.text !== 'env') continue
      // tag.comment is string | NodeArray | undefined
      const raw = typeof tag.comment === 'string'
        ? tag.comment
        : (tag.comment ? String(tag.comment) : '')
      const firstLine = raw ? raw.split('\n')[0].trim() : ''
      if (!firstLine) continue
      const vars = firstLine.split(',').map(x => x.trim()).filter(Boolean)
      if (!vars.length) continue
      optionPathToEnvVars[path] = Array.from(new Set([...(optionPathToEnvVars[path] || []), ...vars])).sort()
      for (const v of vars) {
        if (!envVarToOptionPaths[v]) envVarToOptionPaths[v] = []
        envVarToOptionPaths[v].push(path)
      }
    }
  }

  function walk (type, prefix) {
    for (const objType of getObjectLikeConstituents(type)) {
      let seen = visited.get(objType)
      if (!seen) {
        seen = new Set()
        visited.set(objType, seen)
      }
      if (seen.has(prefix)) continue
      seen.add(prefix)

      for (const prop of objType.getProperties()) {
        const name = prop.getName()
        const fullPath = prefix ? `${prefix}.${name}` : name
        const propType = checker.getTypeOfSymbolAtLocation(prop, sourceFile)
        const typeStr = checker.typeToString(propType, sourceFile, ts.TypeFormatFlags.NoTruncation)
        if (typeStr) typeByPath.set(fullPath, typeStr)
        maybeStoreJsDoc(fullPath, prop.valueDeclaration || prop.declarations?.[0])
        if (shouldRecurse(propType)) {
          containerPaths.add(fullPath)
          walk(propType, fullPath)
        }
      }
    }
  }

  for (const prop of rootType.getProperties()) {
    const name = prop.getName()
    const propType = checker.getTypeOfSymbolAtLocation(prop, sourceFile)
    const typeStr = checker.typeToString(propType, sourceFile, ts.TypeFormatFlags.NoTruncation)
    if (typeStr) typeByPath.set(name, typeStr)
    maybeStoreJsDoc(name, prop.valueDeclaration || prop.declarations?.[0])
    if (shouldRecurse(propType)) {
      containerPaths.add(name)
      walk(propType, name)
    }
  }

  // Normalize envVarToOptionPaths to unique/sorted lists
  for (const [env, paths] of Object.entries(envVarToOptionPaths)) {
    envVarToOptionPaths[env] = Array.from(new Set(paths)).sort()
  }

  return { typeByPath, jsDocByPath, envVarToOptionPaths, optionPathToEnvVars, containerPaths }
}

function scanTestsForEnvDescriptions (envVars) {
  const envSet = new Set(envVars)
  const roots = [
    path.join(REPO_ROOT, 'packages/dd-trace/test'),
    path.join(REPO_ROOT, 'integration-tests')
  ]

  /** @type {Record<string, Candidate[]>} */
  const candidatesByEnv = {}
  for (const env of envVars) candidatesByEnv[env] = []

  const stack = roots.filter(p => fs.existsSync(p))
  const matchRe = /\b((?:DD|OTEL)_[A-Z0-9_]+)\b/g
  const itRe = /\bit\s*\(\s*(['"`])([^'"`]+)\1/
  const describeRe = /\bdescribe\s*\(\s*(['"`])([^'"`]+)\1/

  while (stack.length) {
    const cur = stack.pop()
    if (!cur) continue
    const entries = fs.readdirSync(cur, { withFileTypes: true })
    for (const ent of entries) {
      if (ent.name === 'node_modules') continue
      const p = path.join(cur, ent.name)
      if (ent.isDirectory()) {
        stack.push(p)
        continue
      }
      if (!ent.isFile()) continue
      const ext = path.extname(ent.name)
      if (ext !== '.js' && ext !== '.mjs' && ext !== '.ts') continue
      const stat = fs.statSync(p)
      if (stat.size > 2 * 1024 * 1024) continue

      const rel = path.relative(REPO_ROOT, p)
      const contents = fs.readFileSync(p, 'utf8')
      const lines = contents.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (!line.includes('DD_') && !line.includes('OTEL_')) continue

        const seen = new Set()
        let m
        while ((m = matchRe.exec(line)) !== null) {
          if (envSet.has(m[1])) seen.add(m[1])
        }
        if (seen.size === 0) continue

        // Find nearest describe/it above
        let title
        for (let j = i; j >= 0 && j >= i - 30; j--) {
          const l = lines[j]
          const it = l.match(itRe)
          if (it) { title = it[2]; break }
          const d = l.match(describeRe)
          if (d) { title = d[2]; break }
        }
        if (!title) continue
        title = title.trim()
        title = title.replace(/^\s*should\s+/i, '')
        if (!title) continue

        for (const env of seen) {
          const bucket = candidatesByEnv[env]
          if (!bucket) continue
          if (bucket.length >= 5) continue
          bucket.push({
            field: 'description',
            value: title,
            source: 'tests',
            confidence: 'medium',
            evidence: [{ file: rel, line: i + 1, snippet: line.trim().slice(0, 240) }]
          })
        }
      }
    }
  }
  return candidatesByEnv
}

function heuristicDescription (envVar) {
  const name = envVar.replace(/^(DD|OTEL)_/, '')
  const words = name.toLowerCase().split('_').filter(Boolean)

  const pretty = (w) => w.join(' ')

  if (/_ENABLED$/.test(name)) {
    const base = words.slice(0, -1)
    return `Enable/disable ${pretty(base)}.`
  }
  if (/_PORT$/.test(name)) {
    return `Port for ${pretty(words.slice(0, -1))}.`
  }
  if (/_TIMEOUT$/.test(name) || /_TIMEOUT_MS$/.test(name)) {
    return `Timeout for ${pretty(words.filter(w => !w.startsWith('timeout')))}.`
  }
  if (/_INTERVAL$/.test(name) || /_INTERVAL_SECONDS$/.test(name)) {
    return `Interval for ${pretty(words.filter(w => !w.startsWith('interval')))}.`
  }
  if (/_RATE$/.test(name) || /_SAMPLE_RATE$/.test(name)) {
    return `Rate for ${pretty(words.filter(w => w !== 'rate' && w !== 'sample'))}.`
  }
  if (/_URL$/.test(name) || /_ENDPOINT$/.test(name)) {
    return `URL for ${pretty(words)}.`
  }
  if (/_PATH$/.test(name) || /_FILE$/.test(name)) {
    return `Path for ${pretty(words)}.`
  }
}

function parseInternalToOptionMap (configSrc) {
  const sf = createJsSourceFile(CONFIG_INDEX_JS_PATH, configSrc)
  const body = findPrivateMethodBlock(sf, '#applyOptions')
  if (!body) return {}
  const varInitMap = buildVarInitMap(body)

  /** @type {Record<string, Set<string>>} */
  const internalToOptions = {}

  function addMapping (internalKey, exprNode) {
    const opts = new Set()
    // Reuse env collector machinery pattern but for options.*
    const all = new Set()
    const seenVars = new Set()

    /** @param {ts.Node} n */
    function visit (n) {
      const chain = (function accessChainFromRoot (node, rootName) {
        if (!node) return null
        if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) {
          return accessChainFromRoot(node.expression, rootName)
        }
        if (ts.isIdentifier(node)) return node.text === rootName ? [] : null
        if (ts.isPropertyAccessExpression(node) || ts.isPropertyAccessChain(node)) {
          const base = accessChainFromRoot(node.expression, rootName)
          if (!base) return null
          return base.concat(node.name.text)
        }
        if (ts.isElementAccessExpression(node) || ts.isElementAccessChain(node)) {
          const base = accessChainFromRoot(node.expression, rootName)
          if (!base) return null
          const arg = node.argumentExpression
          if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
            return base.concat(arg.text)
          }
        }
        return null
      })(n, 'options')
      if (chain && chain.length > 0) all.add(chain.join('.'))

      if (ts.isIdentifier(n) && varInitMap.has(n.text) && !seenVars.has(n.text)) {
        // allow following local vars (options may be assigned to locals earlier)
        seenVars.add(n.text)
        const init = varInitMap.get(n.text)
        if (init) visit(init)
      }

      ts.forEachChild(n, visit)
    }

    visit(exprNode)
    for (const p of filterToDeepestPaths(all)) opts.add(p)
    for (const opt of opts) addToSetMap(internalToOptions, internalKey, opt)
  }

  /** @param {ts.Node} node */
  function visit (node) {
    if (ts.isCallExpression(node) &&
        (ts.isPropertyAccessExpression(node.expression) || ts.isPropertyAccessChain(node.expression))) {
      const callee = node.expression
      if (callee.expression.kind === ts.SyntaxKind.ThisKeyword && ts.isPrivateIdentifier(callee.name)) {
        const [first, second, third] = node.arguments
        if (first && ts.isIdentifier(first) && first.text === 'opts' && third) {
          if (second && (ts.isStringLiteral(second) || ts.isNoSubstitutionTemplateLiteral(second))) {
            addMapping(second.text, third)
          }
        }
      }
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      if (ts.isPropertyAccessExpression(node.left) &&
          ts.isIdentifier(node.left.expression) &&
          node.left.expression.text === 'opts') {
        addMapping(node.left.name.text, node.right)
      }
      if (ts.isElementAccessExpression(node.left) &&
          ts.isIdentifier(node.left.expression) &&
          node.left.expression.text === 'opts') {
        const arg = node.left.argumentExpression
        if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
          addMapping(arg.text, node.right)
        }
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(body)

  const flat = {}
  for (const [k, v] of Object.entries(internalToOptions)) flat[k] = Array.from(v)
  return flat
}

function parseEnvToInternalMap (configSrc) {
  const sf = createJsSourceFile(CONFIG_INDEX_JS_PATH, configSrc)
  const body = findPrivateMethodBlock(sf, '#applyConfigValues')
  if (!body) return { envToInternal: {}, envToInternalInputTypes: {} }
  const varInitMap = buildVarInitMap(body)

  /** @type {Record<string, Set<string>>} */
  const envToInternal = {}
  /** @type {Record<string, Record<string, string>>} env -> internal -> inputType */
  const envToInternalInputTypes = {}

  function addMapping (internalKey, exprNode, inputType) {
    const envs = new Set()
    collectEnvVarsFromNode(exprNode, varInitMap, envs)
    for (const env of envs) {
      addToSetMap(envToInternal, env, internalKey)
      if (inputType) {
        if (!envToInternalInputTypes[env]) envToInternalInputTypes[env] = {}
        if (!envToInternalInputTypes[env][internalKey]) envToInternalInputTypes[env][internalKey] = inputType
      }
    }
  }

  /** @param {ts.Node} node */
  function visit (node) {
    if (ts.isCallExpression(node) &&
        (ts.isPropertyAccessExpression(node.expression) || ts.isPropertyAccessChain(node.expression))) {
      const callee = node.expression
      if (callee.expression.kind === ts.SyntaxKind.ThisKeyword && ts.isPrivateIdentifier(callee.name)) {
        const setterName = callee.name.text // includes leading '#'
        const inputTypeFromSetter = inferInputTypeFromSetter(setterName)
        const [first, second, third] = node.arguments
        if (first && ts.isIdentifier(first) && first.text === 'target' && third) {
          if (second && (ts.isStringLiteral(second) || ts.isNoSubstitutionTemplateLiteral(second))) {
            const exprText = third.getText(sf)
            const inferred = inputTypeFromSetter || inferInputTypeFromExpressionText(exprText)
            addMapping(second.text, third, inferred)
          }
        }
      }
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      // target.foo = <expr>
      if (ts.isPropertyAccessExpression(node.left) &&
          ts.isIdentifier(node.left.expression) &&
          node.left.expression.text === 'target') {
        const internalKey = node.left.name.text
        const exprText = node.right.getText(sf)
        addMapping(internalKey, node.right, inferInputTypeFromExpressionText(exprText))
      }
      // target['internal.key'] = <expr>
      if (ts.isElementAccessExpression(node.left) &&
          ts.isIdentifier(node.left.expression) &&
          node.left.expression.text === 'target') {
        const arg = node.left.argumentExpression
        if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
          const exprText = node.right.getText(sf)
          addMapping(arg.text, node.right, inferInputTypeFromExpressionText(exprText))
        }
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(body)

  const flat = {}
  for (const [env, internals] of Object.entries(envToInternal)) {
    flat[env] = Array.from(internals)
  }
  return { envToInternal: flat, envToInternalInputTypes }
}

/**
 * Extract mappings where code explicitly prefers programmatic options but falls back to env vars.
 *
 * Examples we want to capture:
 * - options.experimental?.b3 ?? getEnv('DD_TRACE_EXPERIMENTAL_B3_ENABLED')
 * - this.#optionsArg.stats ?? getEnv('DD_TRACE_STATS_COMPUTATION_ENABLED')
 *
 * @param {string} configSrc
 * @returns {Record<string, string[]>} envVar -> option paths
 */
function parseEnvVarToOptionPathFromCoalesce (configSrc) {
  const sf = createJsSourceFile(CONFIG_INDEX_JS_PATH, configSrc)

  /** @type {Record<string, Set<string>>} */
  const envToOptions = {}

  function accessChainFromRootIdent (node, rootName) {
    if (!node) return null
    if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) {
      return accessChainFromRootIdent(node.expression, rootName)
    }
    if (ts.isIdentifier(node)) return node.text === rootName ? [] : null
    if (ts.isPropertyAccessExpression(node) || ts.isPropertyAccessChain(node)) {
      const base = accessChainFromRootIdent(node.expression, rootName)
      if (!base) return null
      return base.concat(node.name.text)
    }
    if (ts.isElementAccessExpression(node) || ts.isElementAccessChain(node)) {
      const base = accessChainFromRootIdent(node.expression, rootName)
      if (!base) return null
      const arg = node.argumentExpression
      if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
        return base.concat(arg.text)
      }
    }
    return null
  }

  function accessChainFromThisPrivate (node, privateName) {
    if (!node) return null
    if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) {
      return accessChainFromThisPrivate(node.expression, privateName)
    }
    if (ts.isPropertyAccessExpression(node) || ts.isPropertyAccessChain(node)) {
      // base: this.#privateName
      if (
        (ts.isPropertyAccessExpression(node.expression) || ts.isPropertyAccessChain(node.expression)) &&
        node.expression.expression.kind === ts.SyntaxKind.ThisKeyword &&
        ts.isPrivateIdentifier(node.expression.name) &&
        node.expression.name.text === privateName
      ) {
        return [node.name.text]
      }
      const base = accessChainFromThisPrivate(node.expression, privateName)
      if (!base) return null
      return base.concat(node.name.text)
    }
    return null
  }

  function getEnvVarFromGetEnvCall (node) {
    if (!ts.isCallExpression(node)) return
    if (!ts.isIdentifier(node.expression) || node.expression.text !== 'getEnv') return
    const arg = node.arguments[0]
    if (!arg || !(ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) return
    const envVar = arg.text
    if (!ENV_VAR_NAME_RE.test(envVar)) return
    return envVar
  }

  function record (envVar, optionPath) {
    if (!envVar || !optionPath) return
    addToSetMap(envToOptions, envVar, optionPath)
  }

  /** @param {ts.Node} node */
  function visit (node) {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
      const leftEnv = getEnvVarFromGetEnvCall(node.left)
      const rightEnv = getEnvVarFromGetEnvCall(node.right)

      const leftOpt = accessChainFromRootIdent(node.left, 'options') ||
        accessChainFromThisPrivate(node.left, '#optionsArg')
      const rightOpt = accessChainFromRootIdent(node.right, 'options') ||
        accessChainFromThisPrivate(node.right, '#optionsArg')

      // options.* ?? getEnv('ENV')
      if (rightEnv && leftOpt?.length) record(rightEnv, leftOpt.join('.'))
      // getEnv('ENV') ?? options.*
      if (leftEnv && rightOpt?.length) record(leftEnv, rightOpt.join('.'))
    }
    ts.forEachChild(node, visit)
  }

  visit(sf)
  /** @type {Record<string, string[]>} */
  const out = {}
  for (const [envVar, set] of Object.entries(envToOptions)) {
    out[envVar] = Array.from(set).sort()
  }
  return out
}

function main () {
  const argv = process.argv.slice(2)
  const overwriteExisting = argv.includes('--overwrite')
  const emitAllCandidates = argv.includes('--emit-all-candidates')

  const oldSupported = JSON.parse(read(SUPPORTED_JSON_PATH))
  /** @type {Record<string, Partial<SupportedConfigurationEntry>>} */
  const overridesByEnvVar = (() => {
    const doc = tryReadJSON(SUPPORTED_OVERRIDES_JSON_PATH)
    if (!doc) return {}
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      throw new Error(`Overrides must be a JSON object: ${SUPPORTED_OVERRIDES_JSON_PATH}`)
    }
    /** @type {Record<string, Partial<SupportedConfigurationEntry>>} */
    const out = {}
    for (const [k, v] of Object.entries(doc)) {
      if (!ENV_VAR_NAME_RE.test(k)) {
        throw new Error(`Overrides key must be an env var name (DD_/OTEL_): ${k}`)
      }
      if (!v || typeof v !== 'object' || Array.isArray(v)) {
        throw new Error(`Overrides entry for ${k} must be an object`)
      }
      out[k] = /** @type {Partial<SupportedConfigurationEntry>} */ (v)
    }
    return out
  })()
  const configSrc = read(CONFIG_INDEX_JS_PATH)
  const defaultsSrc = read(DEFAULTS_JS_PATH)

  // Keep normalization consistent with runtime (packages/dd-trace/src/util.js).
  // NOTE: This must not create new env keys. It's only used to canonicalize names derived from code lists.
  function normalizePluginEnvName (envPluginName) {
    if (envPluginName.startsWith('@')) {
      envPluginName = envPluginName.slice(1)
    }
    return envPluginName.replace(/[^a-z0-9_]/ig, '_')
  }

  // Instrumentations are enabled by default. Derive canonical env var names from the instrumentation registry.
  /** @type {Set<string>} */
  const instrumentationEnabledEnvVars = new Set()
  try {
    // Safe to require: exports are functions; instrumentations are only required when those functions are invoked.
    const hooks = require('../packages/datadog-instrumentations/src/helpers/hooks')
    for (const key of Object.keys(hooks)) {
      if (key.startsWith('.')) continue // internal paths like './runtime/library.js'
      let name = key
      if (name.startsWith('node:')) name = name.slice('node:'.length)
      const segment = normalizePluginEnvName(name).toUpperCase()
      if (!segment) continue
      instrumentationEnabledEnvVars.add(`DD_TRACE_${segment}_ENABLED`)
    }
  } catch {
    // best-effort; if this fails we simply don't apply instrumentation-specific defaults.
  }

  // Plugins are enabled by default (unless explicitly disabled). Derive env var names from the
  // authoritative plugin ID list in `index.d.ts` (interface Plugins).
  /** @type {Set<string>} */
  const pluginEnabledEnvVars = new Set()
  try {
    const indexDtsSrc = read(INDEX_D_TS_PATH)
    const m = indexDtsSrc.match(/interface\s+Plugins\s*\{([\s\S]*?)\n\}/)
    const block = m?.[1]
    if (block) {
      const re = /"([^"]+)"\s*:\s*tracer\.plugins\./g
      let mm
      while ((mm = re.exec(block)) !== null) {
        const pluginId = mm[1]
        const envName = normalizePluginEnvName(`DD_TRACE_${pluginId.toUpperCase()}_ENABLED`).toUpperCase()
        if (envName) pluginEnabledEnvVars.add(envName)
      }
    }
  } catch {
    // best-effort; if this fails we simply don't apply plugin-specific defaults.
  }

  // Prefer static require to avoid import/no-dynamic-require
  const defaults = require('../packages/dd-trace/src/config/defaults')
  const defaultsMetaByKey = parseDefaultsJsMetadata(defaultsSrc)

  const tracerOptionsMetadata = buildTracerOptionsMetadata()
  const {
    typeByPath: optionTypes,
    jsDocByPath: optionJsDocs,
    containerPaths: optionContainerPaths
  } = tracerOptionsMetadata

  // Some programmatic options are represented in `index.d.ts` under deprecated top-level containers
  // (e.g. `ingestion.*`). When the same internal config key can be set by multiple programmatic paths,
  // prefer deprecated containers as the "env-facing" programmatic mapping to avoid ambiguity.
  /** @type {Set<string>} */
  const deprecatedTopLevelContainers = new Set()
  for (const [path, jsDoc] of optionJsDocs.entries()) {
    if (!path || path.includes('.')) continue // top-level only
    if (typeof jsDoc === 'string' && jsDoc.includes('@deprecated')) {
      deprecatedTopLevelContainers.add(path)
    }
  }
  const { envToInternal, envToInternalInputTypes } = parseEnvToInternalMap(configSrc)
  const internalToOptions = parseInternalToOptionMap(configSrc)
  const envToOptionsFromCoalesce = parseEnvVarToOptionPathFromCoalesce(configSrc)
  const commentDescriptions = extractCommentDescriptionsFromApplyConfigValues(configSrc)
  const docsReport = tryReadJSON(DOCS_REPORT_PATH)

  const oldSupportedConfigurations = oldSupported.supportedConfigurations || {}

  // Support both old schema (top-level aliases/deprecations) and new schema (per-entry fields).
  const oldAliases = oldSupported.aliases || {}
  const oldDeprecations = oldSupported.deprecations || {}

  /** @type {Record<string, SupportedConfigurationEntry[]>} */
  const newSupportedConfigurations = {}

  /** @type {string[]} */
  const nonOneToOne = []
  /** @type {string[]} */
  const internalToMultipleOptions = []
  /** @type {string[]} */
  const envToMultipleOptions = []
  /** @type {string[]} */
  const typeMismatches = []
  /**
   * @type {{
   *   envVar: string,
   *   programmaticConfig: string,
   *   supportedType: string,
   *   tsType: string,
   *   tsNormalizedType: string,
   *   allowedValues?: string[]
   * }[]}
   */
  const programmaticTypeDeviations = []
  /** @type {{ envVar: string, key: string, programmaticConfig?: string }[]} */
  const dynamicDefaults = []
  /** @type {string[]} */
  const missingTypes = []
  /** @type {string[]} */
  const missingDescriptions = []
  /** @type {{ envVar: string, before: string, after: string }[]} */
  const descriptionSanitizationFixes = []
  /** @type {string[]} */
  const unmappedEnvVars = []
  /** @type {string[]} */
  const instrumentationEnabledDefaultsApplied = []
  /** @type {string[]} */
  const pluginEnabledDefaultsApplied = []

  const envVarsAll = Object.keys(oldSupportedConfigurations)
  const {
    literalByEnv: codeLiteralDefaultsByEnvVar,
    booleanByEnv: codeBooleanDefaultsByEnvVar
  } = scanCodeForEnvDefaultEvidence([
    path.join(REPO_ROOT, 'packages/dd-trace/src'),
    path.join(REPO_ROOT, 'packages/datadog-instrumentations/src')
  ])
  const testCandidatesByEnv = scanTestsForEnvDescriptions(envVarsAll)

  /**
   * @type {Record<string, {
   *   internalKey?: string,
   *   optionPath?: string,
   *   chosenType?: ChosenCandidate,
   *   chosenDescription?: ChosenCandidate,
   *   candidates?: Candidate[],
   *   defaultFromCodeLiteral?: DefaultEvidence,
   *   defaultFromCodeBooleanPattern?: DefaultEvidence
   * }>}
   */
  const chosenByEnvVar = {}
  /** @type {unknown[]} */
  const docsTypeConflicts = docsReport?.typeConflicts || []

  function maybeResolveOptionPath (envVar, internalKey) {
    if (!internalKey) return
    const opts = internalToOptions[internalKey] || []
    if (opts.length > 1) internalToMultipleOptions.push(`${internalKey} -> ${opts.join(', ')}`)
    // Accept internalKey itself if it's also an option path
    const candidates = []
    if (opts.length) candidates.push(...opts)
    candidates.push(internalKey)
    const filtered = candidates.filter(p => optionTypes.has(p))
    const unique = Array.from(new Set(filtered))
    if (unique.length > 1) envToMultipleOptions.push(`${envVar} -> ${unique.join(', ')}`)
    if (unique.length === 0) return

    // Prefer deprecated top-level container paths when present (e.g. ingestion.*).
    // This is derived from `index.d.ts` and avoids per-env hardcoding.
    if (deprecatedTopLevelContainers.size) {
      const deprecated = unique.filter(p => deprecatedTopLevelContainers.has(p.split('.')[0]))
      if (deprecated.length) {
        deprecated.sort((a, b) => {
          const aLen = a.split('.').length
          const bLen = b.split('.').length
          if (aLen !== bLen) return aLen - bLen
          return a.localeCompare(b)
        })
        return deprecated[0]
      }
    }

    if (unique.includes(internalKey)) return internalKey
    // Prefer the "most canonical" path: shortest segment length, then alpha
    unique.sort((a, b) => {
      const aLen = a.split('.').length
      const bLen = b.split('.').length
      if (aLen !== bLen) return aLen - bLen
      return a.localeCompare(b)
    })
    return unique[0]
  }

  function getDocsCandidatesForEnv (envVar) {
    const bucket = docsReport?.matchesByEnvVar?.[envVar]
    if (!bucket) return { type: [], description: [] }
    /** @type {Candidate[]} */
    const outType = []
    /** @type {Candidate[]} */
    const outDesc = []

    const pickBest = (arr) => {
      // Prefer nodejs scoped candidates, then other
      const node = arr.filter(c => c.scope === 'nodejs')
      return node.length ? node : arr
    }

    for (const c of pickBest(bucket.typeCandidates || [])) {
      outType.push({
        field: 'type',
        value: c.value,
        source: c.scope === 'nodejs' ? 'docs_nodejs' : 'docs_other',
        confidence: c.scope === 'nodejs' ? 'high' : 'medium',
        evidence: [{ file: c.evidence.file, line: c.evidence.line, snippet: c.evidence.snippet }]
      })
    }

    for (const c of pickBest(bucket.descriptionCandidates || [])) {
      if (!isLikelyEnglish(c.value)) continue
      outDesc.push({
        field: 'description',
        value: c.value,
        source: c.scope === 'nodejs' ? 'docs_nodejs' : 'docs_other',
        confidence: c.scope === 'nodejs' ? 'high' : 'medium',
        evidence: [{ file: c.evidence.file, line: c.evidence.line, snippet: c.evidence.snippet }]
      })
    }

    // If we didn't find any English docs descriptions but we did find docs descriptions, translate known ones.
    if (outDesc.length === 0) {
      const best = pickBest(bucket.descriptionCandidates || [])
      for (const c of best) {
        const translated = translateToEnglishIfKnown(c.value)
        if (!translated) continue
        outDesc.push({
          field: 'description',
          value: translated,
          source: c.scope === 'nodejs' ? 'docs_nodejs' : 'docs_other',
          confidence: 'low',
          evidence: [{ file: c.evidence.file, line: c.evidence.line, snippet: c.evidence.snippet }],
          meta: { translatedFrom: c.value }
        })
      }
    }

    // If docs has a default but no explicit type, infer a weak type hint.
    if ((bucket.typeCandidates || []).length === 0) {
      const bestDefaults = pickBest(bucket.defaultCandidates || [])
      for (const c of bestDefaults) {
        const inferred = inferTypeFromDefaultString(c.value)
        if (!inferred) continue
        outType.push({
          field: 'type',
          value: inferred,
          source: c.scope === 'nodejs' ? 'docs_nodejs' : 'docs_other',
          confidence: 'low',
          evidence: [{ file: c.evidence.file, line: c.evidence.line, snippet: c.evidence.snippet }],
          meta: { inferredFrom: 'docs_default' }
        })
      }
    }
    return { type: outType, description: outDesc }
  }

  function pickDocsDefaultCandidateForEnv (envVar) {
    const bucket = docsReport?.matchesByEnvVar?.[envVar]
    if (!bucket) return
    const candidates = bucket.defaultCandidates || []
    if (!candidates.length) return
    // Prefer nodejs scoped, then other.
    const best = candidates.find(c => c.scope === 'nodejs') || candidates[0]
    const inferredType = inferTypeFromDefaultString(best.value)
    const raw = best.value
    if (!raw) return
    if (inferredType === 'boolean') return String(raw).trim().toLowerCase() === 'true'
    if (inferredType === 'int') return Number.parseInt(String(raw).trim(), 10)
    if (inferredType === 'float') return Number.parseFloat(String(raw).trim())
    if (inferredType === 'array') return String(raw).split(',').map(x => x.trim()).filter(Boolean)
    // If docs default looks like a quoted string or plain string, keep as-is.
    return String(raw).trim().replace(/^['"`]/, '').replace(/['"`]$/, '')
  }

  function maybeGetDocsDefault (envVar, expectedType) {
    if (!expectedType || expectedType === '__UNKNOWN__') return
    // Only accept docs defaults for primitive-ish types where we can validate.
    if (
      expectedType !== 'boolean' &&
      expectedType !== 'int' &&
      expectedType !== 'float' &&
      expectedType !== 'array'
    ) return
    const bucket = docsReport?.matchesByEnvVar?.[envVar]
    if (!bucket) return
    const candidates = bucket.defaultCandidates || []
    if (!candidates.length) return
    const best = candidates.find(c => c.scope === 'nodejs') || candidates[0]
    const inferred = inferTypeFromDefaultString(best.value)
    if (inferred !== expectedType) return
    return pickDocsDefaultCandidateForEnv(envVar)
  }

  function ensureDefaultMatchesType (value, type) {
    if (value === '__UNKNOWN__' || value === '__UNSET__') return true
    if (type === 'boolean') return typeof value === 'boolean'
    if (type === 'int') return typeof value === 'number' && Number.isInteger(value)
    if (type === 'float') return typeof value === 'number' && Number.isFinite(value)
    if (type === 'string') return typeof value === 'string'
    if (type === 'array') return Array.isArray(value)
    return true
  }

  function isLowQualityDescription (value) {
    if (!value || typeof value !== 'string') return true
    const t = value.trim()
    if (!t) return true
    if (t === '__UNKNOWN__') return true
    if (t === 'Configuration option.' || t === 'Configuration option') return true
    if (t === 'Configuration.' || t === 'Configuration') return true
    if (t === 'Mapping configuration.' || t === 'Mapping configuration') return true
    if (t === 'Count configuration.' || t === 'Count configuration') return true
    if (t === 'Destination path or location.' || t === 'Destination path or location') return true
    if (t === 'CI Visibility auto-instrumentation provider name.' ||
        t === 'CI Visibility auto-instrumentation provider name') return true
    if (t === 'Identifier used for configuration and correlation.' ||
        t === 'Identifier used for configuration and correlation') return true
    if (t === 'Enable/disable native span events.' || t === 'Enable/disable native span events') return true
    if (t === 'Interval for heap snapshot.' || t === 'Interval for heap snapshot') return true
    if (t === 'Internal marker set in vitest worker processes for CI Visibility.' ||
        t === 'Internal marker set in vitest worker processes for CI Visibility') return true
    if (t === 'Internal marker set in playwright worker processes for CI Visibility.' ||
        t === 'Internal marker set in playwright worker processes for CI Visibility') return true
    if (
      t === 'Comma-separated list of plugin IDs to disable.' ||
      t === 'Comma-separated list of plugin IDs to disable'
    ) {
      return true
    }
    if (/^\[Datadog site\]\[\d+\]\s*-\s*\*\*Required\*\*$/.test(t)) return true
    if (/^Datadog site\s*-\s*\*\*Required\*\*$/.test(t)) return true
    if (t === 'Destination site for your metrics, traces, and logs.' ||
        t === 'Destination site for your metrics, traces, and logs') return true
    return false
  }

  function inferDefaultHeuristic (envVar, type) {
    // IMPORTANT: heuristic defaults are NOT applied; they are only reported for review.
    if (!type || type === '__UNKNOWN__') return

    // Most override env vars default to "unset" (meaning: do not override programmatic/defaults.js).
    if (type === 'boolean' && (/_ENABLED$/.test(envVar) || /_DISABLED$/.test(envVar) || /_DEBUG$/.test(envVar))) {
      return { suggestedDefault: '__UNSET__', rationale: 'Boolean override env var is typically unset by default.' }
    }
    if (type === 'string' && /_(TAGS|ATTRIBUTES|PROFILERS|PLUGINS|INSTRUMENTATIONS|MAPPING)$/.test(envVar)) {
      return { suggestedDefault: '__UNSET__', rationale: 'List-like string env vars are typically unset by default.' }
    }
    if (type === 'int' && /_(MILLISECONDS|MICROSECONDS|MS|SECONDS|MINUTES|HOURS)$/.test(envVar)) {
      return { suggestedDefault: '__UNSET__', rationale: 'Duration override env var is typically unset by default.' }
    }
    return { suggestedDefault: '__UNSET__', rationale: 'No safe heuristic default; suggest leaving unset.' }
  }

  /**
   * @param {string} envVar
   * @param {string} implementation
   * @param {Partial<SupportedConfigurationEntry> | undefined} existingEntry
   * @param {Partial<SupportedConfigurationEntry>} [extra]
   * @returns {SupportedConfigurationEntry}
   */
  function makeEntry (envVar, implementation, existingEntry, extra = {}) {
    const internals = envToInternal[envVar] || []
    if (internals.length > 1) {
      nonOneToOne.push(`${envVar} -> ${internals.join(', ')}`)
    }

    const internalKey = internals[0]
    const defaultValue = internalKey && Object.hasOwn(defaultsMetaByKey, internalKey)
      ? defaults[internalKey]
      : undefined

    const optionPathFromCode = internalKey ? maybeResolveOptionPath(envVar, internalKey) : undefined
    const existingProgrammaticConfig =
      existingEntry?.programmaticConfig && existingEntry.programmaticConfig !== '__UNKNOWN__'
        ? existingEntry.programmaticConfig
        : undefined
    // Additional mapping source: @env tags in index.d.ts (env var -> option path)
    const optionPathFromEnvTagList = tracerOptionsMetadata.envVarToOptionPaths?.[envVar]
    let optionPathFromEnvTag
    if (optionPathFromEnvTagList?.length) {
      const unique = Array.from(new Set(optionPathFromEnvTagList))
      const leaf = unique.filter(p => normalizeTypeFromTs(optionTypes.get(p)))
      const pick = (leaf.length ? leaf : unique).sort((a, b) => {
        const aLen = a.split('.').length
        const bLen = b.split('.').length
        if (aLen !== bLen) return aLen - bLen
        return a.localeCompare(b)
      })[0]
      optionPathFromEnvTag = pick
    }

    const optionPathFromCoalesceList = envToOptionsFromCoalesce[envVar]
    const optionPathFromCoalesce = optionPathFromCoalesceList?.find(p => optionTypes.has(p)) ||
      optionPathFromCoalesceList?.[0]

    const optionPath =
      existingProgrammaticConfig ||
      optionPathFromCode ||
      optionPathFromEnvTag ||
      optionPathFromCoalesce

    /** @type {Candidate[]} */
    const typeCandidates = []
    /** @type {Candidate[]} */
    const descCandidates = []

    if (!internalKey) unmappedEnvVars.push(envVar)

    // code parse type
    const inputTypeFromCode = internalKey ? envToInternalInputTypes[envVar]?.[internalKey] : undefined
    if (inputTypeFromCode) {
      typeCandidates.push({
        field: 'type',
        value: inputTypeFromCode,
        source: 'code_parse',
        confidence: 'high',
        meta: { internalKey, optionPath }
      })
    }

    // dts type/allowed values
    if (optionPath) {
      const tsType = optionTypes.get(optionPath)
      const inputTypeFromTs = normalizeTypeFromTs(tsType)
      if (inputTypeFromTs) {
        typeCandidates.push({
          field: 'type',
          value: inputTypeFromTs,
          source: 'dts',
          confidence: 'high',
          meta: { optionPath, allowedValues: extractAllowedStringLiteralsFromTsType(tsType) }
        })
      }
      const jsDoc = optionJsDocs.get(optionPath)
      const fullDescription = extractFullDescriptionFromJsDocText(jsDoc)
      if (fullDescription) {
        descCandidates.push({
          field: 'description',
          value: fullDescription,
          source: 'dts',
          confidence: 'high',
          meta: { optionPath }
        })
      }
    }

    // fallback from defaults internal type (medium)
    const internalType = inferInternalTypeFromDefault(defaultValue)
    if (internalType && ['boolean', 'string', 'array', 'int', 'float'].includes(internalType)) {
      typeCandidates.push({
        field: 'type',
        value: internalType === 'array' ? 'array' : internalType,
        source: 'code_parse',
        confidence: 'medium',
        meta: { internalKey, internalType }
      })
    }

    // mismatch reporting: input vs internal parsed type
    if (internalKey && inputTypeFromCode && internalType && inputTypeFromCode !== internalType) {
      typeMismatches.push(`${envVar}: input=${inputTypeFromCode} internal=${internalType} (internalKey=${internalKey})`)
    }

    // code comments
    const codeComment = internalKey
      ? (commentDescriptions.byInternalKey[internalKey] || commentDescriptions.byEnvVar[envVar])
      : undefined
    if (codeComment) {
      descCandidates.push({
        field: 'description',
        value: codeComment,
        source: 'code_comment',
        confidence: 'high',
        meta: { internalKey }
      })
    }

    // docs candidates
    const docsCands = getDocsCandidatesForEnv(envVar)
    typeCandidates.push(...docsCands.type)
    descCandidates.push(...docsCands.description)

    // tests candidates
    descCandidates.push(...(testCandidatesByEnv[envVar] || []))

    // heuristic
    const heur = heuristicDescription(envVar)
    if (heur) {
      descCandidates.push({
        field: 'description',
        value: heur,
        source: 'heuristic',
        confidence: 'low'
      })
    }

    // Forced type overrides (confirmed by code usage).
    const forcedTypeByEnvVar = {
      DD_EXTERNAL_ENV: 'string',
      DD_ACTION_EXECUTION_ID: 'string',
      DD_AAS_DOTNET_EXTENSION_VERSION: 'string',
      DD_AZURE_RESOURCE_GROUP: 'string'
    }
    const forcedType = forcedTypeByEnvVar[envVar]
    if (forcedType) {
      typeCandidates.unshift({ field: 'type', value: forcedType, source: 'code_parse', confidence: 'high' })
    }

    // Name-based type inference fallback (only when type is still unknown after all evidence).
    function inferTypeFromEnvVarName (name) {
      // Booleans
      if (/_ENABLED$/.test(name) || /_DISABLED$/.test(name)) return { type: 'boolean', confidence: 'medium' }
      if (/DANGEROUSLY_FORCE_/.test(name)) return { type: 'boolean', confidence: 'medium' }
      if (name === 'DD_TRACE_BEAUTIFUL_LOGS') return { type: 'boolean', confidence: 'medium' }
      if (name === 'DD_TRACE_ENCODING_DEBUG') return { type: 'boolean', confidence: 'medium' }
      if (name === 'DD_TRACE_EXPERIMENTAL_SPAN_COUNTS' || name === 'DD_TRACE_EXPERIMENTAL_STATE_TRACKING') {
        return { type: 'boolean', confidence: 'medium' }
      }
      if (name === 'DD_PROFILING_DEBUG_SOURCE_MAPS' || name === 'DD_PROFILING_V8_PROFILER_BUG_WORKAROUND') {
        return { type: 'boolean', confidence: 'medium' }
      }

      // URLs / locations
      if (/_URL$/.test(name) || /_URI$/.test(name) || /_HOST$/.test(name) || /_ENDPOINT$/.test(name)) {
        return { type: 'string', confidence: 'medium' }
      }

      // Paths
      if (/_PATH$/.test(name) || /_FILE$/.test(name) || /_DIR$/.test(name)) return { type: 'string', confidence: 'medium' }

      // IDs / refs
      if (/_ID$/.test(name) || /_SHA$/.test(name) || /_BRANCH$/.test(name) || /_TAG$/.test(name) || /_VERSION$/.test(name)) {
        return { type: 'string', confidence: 'medium' }
      }
      if (/_EMAIL$/.test(name) || /_DATE$/.test(name) || /_MESSAGE$/.test(name) || /_PREFIX$/.test(name)) {
        return { type: 'string', confidence: 'medium' }
      }
      if (/_LOG_LEVEL$/.test(name) || name === 'DD_LOG_LEVEL' || name === 'DD_TRACE_LOG_LEVEL' || name === 'OTEL_LOG_LEVEL') {
        return { type: 'string', confidence: 'medium' }
      }
      if (/_ATTRIBUTES$/.test(name)) return { type: 'string', confidence: 'medium' }
      if (/_TAGS$/.test(name)) return { type: 'string', confidence: 'medium' }
      if (/_EXPORTER$/.test(name) || /_EXPORTERS$/.test(name)) return { type: 'string', confidence: 'medium' }
      if (/_WORKER$/.test(name)) return { type: 'string', confidence: 'medium' }
      if (/_PROVIDER$/.test(name)) return { type: 'string', confidence: 'medium' }
      if (/_PROFILERS$/.test(name)) return { type: 'string', confidence: 'medium' }
      if (/_STRATEGIES$/.test(name)) return { type: 'string', confidence: 'medium' }
      if (/UPLOAD_COMPRESSION$/.test(name)) return { type: 'string', confidence: 'medium' }
      if (/_DISABLED_(PLUGINS|INSTRUMENTATIONS)$/.test(name)) return { type: 'string', confidence: 'low' }
      if (/_MAPPING$/.test(name)) return { type: 'string', confidence: 'low' }
      if (/_NAME$/.test(name) || /_COMMAND$/.test(name) || /_HANDLER$/.test(name)) return { type: 'string', confidence: 'medium' }

      // Time units
      if (/_MILLIS$/.test(name) || /_MS$/.test(name) || /_SECONDS$/.test(name) || /_MINUTES$/.test(name) || /_HOURS$/.test(name)) {
        return { type: 'int', confidence: 'medium' }
      }

      // Count-ish
      if (/_COUNT$/.test(name) || /_RETRIES$/.test(name) || /_LIMIT$/.test(name) || /_SIZE$/.test(name)) {
        return { type: 'int', confidence: 'low' }
      }
      if (/_THRESHOLD$/.test(name)) return { type: 'int', confidence: 'low' }
      if (/_SAMPLING_INTERVAL$/.test(name)) return { type: 'int', confidence: 'low' }

      // Rates
      if (/_SAMPLE_RATE$/.test(name) || /_RATE$/.test(name)) return { type: 'float', confidence: 'low' }

      // Time-like without explicit unit: still likely integer, but low confidence.
      if (/_TIMEOUT$/.test(name) || /_INTERVAL$/.test(name) || /_DELAY$/.test(name) || /_DEADLINE$/.test(name)) {
        return { type: 'int', confidence: 'low' }
      }

      // Other unit variants
      if (/_MILLISECONDS$/.test(name) || /_MICROSECONDS$/.test(name)) return { type: 'int', confidence: 'medium' }
      if (/UPLOAD_PERIOD$/.test(name) || /UPLOAD_TIMEOUT$/.test(name)) return { type: 'int', confidence: 'medium' }
    }

    const existingTypeForChoice =
      (instrumentationEnabledEnvVars.has(envVar) || pluginEnabledEnvVars.has(envVar))
        ? '__UNKNOWN__'
        : existingEntry?.type
    const chosenType = chooseCandidate(existingTypeForChoice, typeCandidates, overwriteExisting)
    if (chosenType.value === '__UNKNOWN__') {
      const inferred = inferTypeFromEnvVarName(envVar)
      if (inferred?.type) {
        const inferredCandidate = chooseCandidate('__UNKNOWN__', [{
          field: 'type',
          value: inferred.type,
          source: 'heuristic',
          confidence: inferred.confidence
        }], true)
        chosenType.value = inferredCandidate.value
        chosenType.chosen = inferredCandidate.chosen
      }
    }

    // English-only descriptions: if an existing description isn't English, treat it as missing.
    const existingDescription = existingEntry?.description
    const existingEnglish = isLikelyEnglish(existingDescription) ? existingDescription : undefined
    const translatedExisting = !existingEnglish ? translateToEnglishIfKnown(existingDescription) : undefined
    if (translatedExisting) {
      descCandidates.unshift({
        field: 'description',
        value: translatedExisting,
        source: 'heuristic',
        confidence: 'low'
      })
    }

    // If existing description looks truncated vs d.ts full description, prefer d.ts even if not overwriting.
    const dtsFull = descCandidates.find(c => c.source === 'dts')?.value
    const existingTrim = typeof existingEnglish === 'string' ? existingEnglish.trim() : ''
    const longerDts =
      dtsFull &&
      existingTrim &&
      dtsFull.length > existingTrim.length &&
      dtsFull.startsWith(existingTrim)
    const longerDocs =
      existingTrim &&
      descCandidates.some(c => c?.source?.startsWith('docs') && isTruncatedPrefix(existingTrim, c.value))
    const existingForChoice = (longerDts || longerDocs) ? '__UNKNOWN__' : existingEnglish

    const chosenDescription = chooseCandidate(existingForChoice, descCandidates, overwriteExisting)
    const type = chosenType.value
    const sanitizedDescription = sanitizeDescriptionArtifacts(chosenDescription.value)
    const normalizedDescription = normalizeDescriptionCase(sanitizedDescription)
    if (sanitizedDescription && sanitizedDescription !== chosenDescription.value) {
      descriptionSanitizationFixes.push({
        envVar,
        before: String(chosenDescription.value).slice(0, 240),
        after: String(sanitizedDescription).slice(0, 240)
      })
    }
    const description = isLikelyEnglish(normalizedDescription) ? normalizedDescription : '__UNKNOWN__'

    /** @type {SupportedConfigurationEntry} */
    const entry = {
      implementation,
      type,
      description,
      ...extra
    }
    // Only include programmaticConfig when known (omit when unknown).
    if (optionPath) entry.programmaticConfig = optionPath
    // Default is mandatory: prefer explicit existing default, then defaults.js, then @default in index.d.ts,
    // then docs default (only when type matches), else sentinel.
    if (existingEntry && Object.hasOwn(existingEntry, 'default')) {
      entry.default = existingEntry.default
    } else if (defaultValue !== undefined) {
      entry.default = defaultValue
    } else if (internalKey && Object.hasOwn(defaultsMetaByKey, internalKey) && defaults[internalKey] === undefined) {
      entry.default = '__UNSET__'
    } else if (optionPath && Object.hasOwn(defaultsMetaByKey, optionPath)) {
      entry.default = defaults[optionPath] === undefined ? '__UNSET__' : defaults[optionPath]
    } else if (optionPath) {
      const jsDoc = optionJsDocs.get(optionPath)
      const dtsDefault = extractDefaultFromJsDocText(jsDoc)
      if (dtsDefault !== undefined) {
        entry.default = dtsDefault
      } else {
        const docsDefault = maybeGetDocsDefault(envVar, type)
        entry.default = docsDefault !== undefined ? docsDefault : '__UNKNOWN__'
      }
    } else {
      entry.default = '__UNKNOWN__'
    }

    // Override defaults that are dynamic in defaults.js (e.g. pkg.version, env-derived service name).
    // This replaces previously frozen values (like DD_VERSION: "6.0.0-pre") with "$dynamic".
    const dynamicKey = internalKey && defaultsMetaByKey[internalKey]?.kind === 'dynamic'
      ? internalKey
      : (optionPath && defaultsMetaByKey[optionPath]?.kind === 'dynamic' ? optionPath : undefined)
    if (dynamicKey) {
      entry.default = '$dynamic'
      dynamicDefaults.push({ envVar, key: dynamicKey, programmaticConfig: optionPath })
    }

    // Instrumentations and plugins are enabled by default unless explicitly disabled.
    if (entry.default !== '$dynamic') {
      if (instrumentationEnabledEnvVars.has(envVar)) {
        entry.default = true
        instrumentationEnabledDefaultsApplied.push(envVar)
      } else if (pluginEnabledEnvVars.has(envVar)) {
        entry.default = true
        pluginEnabledDefaultsApplied.push(envVar)
      }
    }

    // Correctness-first: if default is still unknown, try a code-derived literal fallback (reported with evidence).
    if (entry.default === '__UNKNOWN__') {
      const evidences = codeLiteralDefaultsByEnvVar[envVar]
      if (evidences?.length) {
        const best = evidences[0]
        if (ensureDefaultMatchesType(best.value, type)) {
          entry.default = /** @type {JSONValue} */ (best.value)
          chosenByEnvVar[envVar] = chosenByEnvVar[envVar] || {}
          chosenByEnvVar[envVar].defaultFromCodeLiteral = {
            value: best.value,
            evidence: { file: best.file, line: best.line, snippet: best.snippet }
          }
        }
      }
    }

    // If default is still unknown and this is a boolean env var, use code-derived boolean semantics when available.
    if (entry.default === '__UNKNOWN__' && type === 'boolean') {
      const evidences = codeBooleanDefaultsByEnvVar[envVar]
      if (evidences?.length) {
        const best = evidences[0]
        if (best.value === '$dynamic') {
          entry.default = '$dynamic'
        } else if (ensureDefaultMatchesType(best.value, type)) {
          entry.default = /** @type {JSONValue} */ (best.value)
        }
        if (entry.default !== '__UNKNOWN__') {
          chosenByEnvVar[envVar] = chosenByEnvVar[envVar] || {}
          chosenByEnvVar[envVar].defaultFromCodeBooleanPattern = {
            value: best.value,
            evidence: { file: best.file, line: best.line, snippet: best.snippet }
          }
        }
      }
    }

    if (existingEntry?.aliases && !entry.aliases) entry.aliases = existingEntry.aliases
    if (existingEntry?.deprecations && !entry.deprecations) entry.deprecations = existingEntry.deprecations

    // Apply deterministic overrides (must not introduce new env keys).
    const override = overridesByEnvVar[envVar]
    if (override) {
      if (
        isLowQualityDescription(entry.description) &&
        typeof override.description === 'string' &&
        override.description.length
      ) {
        const d = normalizeDescriptionCase(sanitizeDescriptionArtifacts(override.description))
        entry.description = isLikelyEnglish(d) ? d : entry.description
      }
      if (entry.type === '__UNKNOWN__' && typeof override.type === 'string' && override.type.length) {
        entry.type = override.type
      }
      if (
        entry.programmaticConfig === undefined &&
        typeof override.programmaticConfig === 'string' &&
        override.programmaticConfig.length
      ) {
        entry.programmaticConfig = override.programmaticConfig
      }
      if (entry.default === '__UNKNOWN__' && Object.hasOwn(override, 'default')) {
        const v = override.default
        if (ensureDefaultMatchesType(v, entry.type)) {
          entry.default = /** @type {JSONValue} */ (v)
        }
      }
    }

    const allCandidates = emitAllCandidates
      ? typeCandidates.concat(descCandidates)
      : []
    const chosenTypeOut = chosenType.chosen ||
      (chosenType.keptExisting ? { value: entry.type, keptExisting: true } : undefined)
    const chosenDescriptionOut = chosenDescription.chosen ||
      (chosenDescription.keptExisting ? { value: entry.description, keptExisting: true } : undefined)
    chosenByEnvVar[envVar] = {
      internalKey,
      optionPath,
      chosenType: chosenTypeOut,
      chosenDescription: chosenDescriptionOut,
      candidates: allCandidates.length ? allCandidates : undefined
    }

    return entry
  }

  /**
   * @param {unknown} value
   * @returns {Partial<SupportedConfigurationEntry> | undefined}
   */
  function getExistingEntry (value) {
    if (!Array.isArray(value) || value.length === 0) return
    const first = value[0]
    return first && typeof first === 'object' && !Array.isArray(first) ? first : undefined
  }

  function getExistingImplementation (envVar, value) {
    if (Array.isArray(value) && value.length > 0) {
      const first = value[0]
      if (typeof first === 'string') return first
      if (first && typeof first === 'object' && typeof first.implementation === 'string') return first.implementation
    }
    // fallback: preserve any existing mapping if present via defaults mapping, otherwise A
    return envToInternal[envVar]?.length ? 'A' : 'A'
  }

  // 1) Migrate existing supportedConfigurations entries (idempotent: supports old and new schema inputs)
  for (const [envVar, value] of Object.entries(oldSupportedConfigurations)) {
    const existingEntry = getExistingEntry(value)
    const implementation = getExistingImplementation(envVar, value)
    /** @type {Partial<SupportedConfigurationEntry>} */
    const extra = {}
    // Old schema (top-level aliases): migrate into entry
    if (oldAliases[envVar]) extra.aliases = oldAliases[envVar]
    newSupportedConfigurations[envVar] = [makeEntry(envVar, implementation, existingEntry, extra)]
  }

  // 2) Gather deprecations from old schema and/or already-migrated entries.
  const deprecationsMap = { ...oldDeprecations }
  for (const [envVar, entries] of Object.entries(oldSupportedConfigurations)) {
    const existingEntry = getExistingEntry(entries)
    const replacedBy = existingEntry?.deprecations?.replacedBy
    if (replacedBy) deprecationsMap[envVar] = replacedBy
  }

  // 3) Ensure deprecated env vars exist as keys and carry { replacedBy }.
  for (const [deprecatedEnv, replacedBy] of Object.entries(deprecationsMap)) {
    if (newSupportedConfigurations[deprecatedEnv]?.[0]?.deprecations?.replacedBy) continue
    const replacementEntry = newSupportedConfigurations[replacedBy]?.[0]
    const replacementImpl = replacementEntry?.implementation || 'A'
    const inherited = replacementEntry
      ? { type: replacementEntry.type, description: replacementEntry.description, default: replacementEntry.default }
      : undefined
    const entry = makeEntry(deprecatedEnv, replacementImpl, inherited, { deprecations: { replacedBy } })
    newSupportedConfigurations[deprecatedEnv] = [entry]
  }

  // 4) Sibling inheritance: if description is still unknown, try inheriting it from the same internal key.
  /** @type {Record<string, { envVar: string, description: string, sourceRank: number, confidenceRank: number }>} */
  const donorByInternalKey = {}
  for (const [envVar, entries] of Object.entries(newSupportedConfigurations)) {
    const entry = entries?.[0]
    if (!entry || entry.description === '__UNKNOWN__') continue
    const internalKey = envToInternal[envVar]?.[0]
    if (!internalKey) continue
    const chosen = chosenByEnvVar[envVar]?.chosenDescription
    const src = chosen?.source || (chosen?.keptExisting ? 'inherited' : 'inherited')
    const conf = chosen?.confidence || (chosen?.keptExisting ? 'low' : 'low')
    const sRank = sourceRank(src)
    const cRank = confidenceRank(conf)
    const existing = donorByInternalKey[internalKey]
    if (!existing ||
      cRank > existing.confidenceRank ||
      (cRank === existing.confidenceRank && sRank > existing.sourceRank)
    ) {
      donorByInternalKey[internalKey] = {
        envVar,
        description: entry.description,
        sourceRank: sRank,
        confidenceRank: cRank
      }
    }
  }

  for (const [envVar, entries] of Object.entries(newSupportedConfigurations)) {
    const entry = entries?.[0]
    if (!entry || entry.description !== '__UNKNOWN__') continue
    const internalKey = envToInternal[envVar]?.[0]
    if (!internalKey) continue
    const donor = donorByInternalKey[internalKey]
    if (!donor) continue
    entry.description = normalizeDescriptionCase(donor.description)
    /** @type {Confidence} */
    const confidence = donor.confidenceRank >= 2 ? 'medium' : 'low'
    /** @type {Candidate} */
    const chosen = {
      field: 'description',
      value: donor.description,
      source: 'inherited',
      confidence,
      meta: { fromEnvVar: donor.envVar }
    }
    chosenByEnvVar[envVar] = chosenByEnvVar[envVar] || {}
    chosenByEnvVar[envVar].chosenDescription = chosen
    if (emitAllCandidates) {
      chosenByEnvVar[envVar].candidates = chosenByEnvVar[envVar].candidates || []
      chosenByEnvVar[envVar].candidates.push(chosen)
    }
  }

  // 5) Recompute missing fields after inheritance pass (so reports reflect final output).
  missingTypes.length = 0
  missingDescriptions.length = 0
  for (const [envVar, entries] of Object.entries(newSupportedConfigurations)) {
    const entry = entries?.[0]
    if (!entry) continue
    if (entry.type === '__UNKNOWN__') missingTypes.push(envVar)
    if (entry.description === '__UNKNOWN__') missingDescriptions.push(envVar)
  }

  // 6) Report deviations between supported type and the programmaticConfig type in index.d.ts.
  for (const [envVar, entries] of Object.entries(newSupportedConfigurations)) {
    const entry = entries?.[0]
    if (!entry) continue
    if (!entry.programmaticConfig) continue
    if (!entry.type || entry.type === '__UNKNOWN__') continue
    const tsType = optionTypes.get(entry.programmaticConfig)
    const tsNormalizedType = normalizeTypeFromTs(tsType)
    if (!tsType || !tsNormalizedType) continue
    if (tsNormalizedType !== entry.type) {
      const allowedValues = extractAllowedStringLiteralsFromTsType(tsType)
      programmaticTypeDeviations.push({
        envVar,
        programmaticConfig: entry.programmaticConfig,
        supportedType: entry.type,
        tsType,
        tsNormalizedType,
        allowedValues: allowedValues && allowedValues.length ? allowedValues : undefined
      })
    }
  }

  // 7) Report TracerOptions paths that do not correspond to any environment variable.
  // We define "correspond" as: at least one supported env var resolves to this option path
  // (via config/index.js mapping or @env mapping).
  const usedProgrammaticConfigs = new Set()
  for (const entries of Object.values(newSupportedConfigurations)) {
    const entry = entries?.[0]
    if (entry?.programmaticConfig) usedProgrammaticConfigs.add(entry.programmaticConfig)
  }

  const tracerOptionsWithoutEnvVar = []
  for (const [p, tsType] of optionTypes.entries()) {
    if (optionContainerPaths?.has(p)) continue // skip non-leaf containers, even if unions mention primitives
    const normalized = normalizeTypeFromTs(tsType)
    if (!normalized) continue
    if (!usedProgrammaticConfigs.has(p)) tracerOptionsWithoutEnvVar.push(p)
  }
  tracerOptionsWithoutEnvVar.sort()

  // Additional signal: @env tags that reference env vars not present in supported-configurations.json.
  /** @type {{ programmaticConfig: string, env: string[] }[]} */
  const tracerOptionsWithEnvTagButMissingSupportedEnvVar = []
  const supportedEnvVarsSet = new Set(Object.keys(newSupportedConfigurations))
  for (const [p, tsType] of optionTypes.entries()) {
    const normalized = normalizeTypeFromTs(tsType)
    if (!normalized) continue
    const envs = tracerOptionsMetadata.optionPathToEnvVars?.[p] || []
    if (!envs.length) continue
    const missing = envs.filter(e => !supportedEnvVarsSet.has(e))
    if (missing.length) {
      tracerOptionsWithEnvTagButMissingSupportedEnvVar.push({ programmaticConfig: p, env: missing })
    }
  }
  tracerOptionsWithEnvTagButMissingSupportedEnvVar.sort((a, b) =>
    a.programmaticConfig.localeCompare(b.programmaticConfig)
  )

  // 8) Deterministic key order
  const sorted = {}
  for (const key of Object.keys(newSupportedConfigurations).sort()) {
    sorted[key] = newSupportedConfigurations[key]
  }

  const output = {
    version: String(oldSupported.version || '2'),
    supportedConfigurations: sorted
  }

  writeJSON(SUPPORTED_JSON_PATH, output)

  /** @type {{ envVar: string, candidates: string[] }[]} */
  const envVarsWithEnvTagCandidatesButMissingProgrammaticConfig = []
  for (const envVar of Object.keys(newSupportedConfigurations)) {
    const candidates = tracerOptionsMetadata.envVarToOptionPaths?.[envVar]
    if (!candidates?.length) continue
    const entry = newSupportedConfigurations[envVar]?.[0]
    if (entry?.programmaticConfig) continue
    envVarsWithEnvTagCandidatesButMissingProgrammaticConfig.push({ envVar, candidates })
  }
  envVarsWithEnvTagCandidatesButMissingProgrammaticConfig.sort((a, b) => a.envVar.localeCompare(b.envVar))

  /** @type {{ envVar: string, programmaticConfig: string, envTag: string[] }[]} */
  const envVarsWithProgrammaticConfigButNoEnvTag = []
  for (const envVar of Object.keys(newSupportedConfigurations)) {
    const entry = newSupportedConfigurations[envVar]?.[0]
    const p = entry?.programmaticConfig
    if (!p) continue
    const envs = tracerOptionsMetadata.optionPathToEnvVars?.[p] || []
    if (envs.includes(envVar)) continue
    envVarsWithProgrammaticConfigButNoEnvTag.push({ envVar, programmaticConfig: p, envTag: envs })
  }
  envVarsWithProgrammaticConfigButNoEnvTag.sort((a, b) => a.envVar.localeCompare(b.envVar))

  /** @type {{ envVar: string, type: string, suggestedDefault: unknown, rationale: string }[]} */
  const defaultHeuristicSuggestions = []
  for (const envVar of Object.keys(newSupportedConfigurations)) {
    const entry = newSupportedConfigurations[envVar]?.[0]
    if (!entry || entry.default !== '__UNKNOWN__') continue
    const heur = inferDefaultHeuristic(envVar, entry.type)
    if (!heur) continue
    defaultHeuristicSuggestions.push({
      envVar,
      type: entry.type,
      suggestedDefault: heur.suggestedDefault,
      rationale: heur.rationale
    })
  }
  defaultHeuristicSuggestions.sort((a, b) => a.envVar.localeCompare(b.envVar))

  /** @type {{ envVar: string, type: string, candidates: unknown[] }[]} */
  const codeDerivedDefaultSuggestions = []
  for (const envVar of Object.keys(newSupportedConfigurations)) {
    const entry = newSupportedConfigurations[envVar]?.[0]
    if (!entry || entry.default !== '__UNKNOWN__') continue
    const evidences = codeLiteralDefaultsByEnvVar[envVar]
    if (!evidences?.length) continue
    codeDerivedDefaultSuggestions.push({
      envVar,
      type: entry.type,
      candidates: evidences.slice(0, 5)
    })
  }
  codeDerivedDefaultSuggestions.sort((a, b) => a.envVar.localeCompare(b.envVar))

  const report = {
    nonOneToOne: nonOneToOne.sort(),
    internalToMultipleOptions: Array.from(new Set(internalToMultipleOptions)).sort(),
    envToMultipleOptions: Array.from(new Set(envToMultipleOptions)).sort(),
    typeMismatches: typeMismatches.sort(),
    programmaticTypeDeviations: programmaticTypeDeviations.sort((a, b) => a.envVar.localeCompare(b.envVar)),
    tracerOptionsWithoutEnvVar,
    tracerOptionsWithEnvTagButMissingSupportedEnvVar,
    envVarsMissingProgrammaticConfig: Object.keys(newSupportedConfigurations)
      .filter(envVar => !newSupportedConfigurations[envVar]?.[0]?.programmaticConfig)
      .sort(),
    envVarsWithEnvTagCandidatesButMissingProgrammaticConfig,
    envVarsWithProgrammaticConfigButNoEnvTag,
    dynamicDefaults: dynamicDefaults.sort((a, b) => a.envVar.localeCompare(b.envVar)),
    defaultHeuristicSuggestions,
    codeDerivedDefaultSuggestions,
    defaultDiscoveryGates: {
      codeScan: 'unified'
    },
    instrumentationEnabledDefaultsApplied: Array.from(new Set(instrumentationEnabledDefaultsApplied)).sort(),
    pluginEnabledDefaultsApplied: Array.from(new Set(pluginEnabledDefaultsApplied)).sort(),
    descriptionSanitizationFixes,
    unmappedEnvVars: Array.from(new Set(unmappedEnvVars)).sort(),
    missingTypes: Array.from(new Set(missingTypes)).sort(),
    missingDescriptions: Array.from(new Set(missingDescriptions)).sort()
  }

  const reportPath = path.join(REPO_ROOT, 'packages/dd-trace/src/config/supported-configurations.migration-report.json')
  writeJSON(reportPath, report)

  const enrichReport = {
    supportedVersion: output.version,
    overwriteExisting,
    emitAllCandidates,
    docs: docsReport
      ? {
          source: DOCS_REPORT_PATH,
          matchedEnvVarCount: docsReport.matchedEnvVarCount,
          typeConflicts: docsTypeConflicts
        }
      : { source: DOCS_REPORT_PATH, loaded: false },
    chosenByEnvVar
  }
  writeJSON(ENRICH_REPORT_PATH, enrichReport)

  process.stdout.write(`Rewrote ${SUPPORTED_JSON_PATH}\n`)
  process.stdout.write(`Wrote report ${reportPath}\n`)
  process.stdout.write(`Wrote enrichment report ${ENRICH_REPORT_PATH}\n`)
  process.stdout.write(`non-1-to-1 mappings: ${report.nonOneToOne.length}\n`)
  process.stdout.write(`type mismatches: ${report.typeMismatches.length}\n`)
}

if (require.main === module) {
  main()
}
