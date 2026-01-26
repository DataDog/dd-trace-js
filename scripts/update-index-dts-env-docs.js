'use strict'

/**
 * Adds/updates `@env` docs in `index.d.ts` for programmatic options that map 1-to-1 to environment variables.
 *
 * Sources:
 * - `packages/dd-trace/src/config/index.js`:
 *   - env var -> internal key mapping from `Config.#applyConfigValues`
 *   - internal key -> programmatic option path mapping from `Config.#applyOptions`
 *
 * Behavior:
 * - Only applies updates for clean 1-to-1 mappings:
 *   envVar -> single internalKey, and internalKey -> single optionPath
 * - Inserts a short precedence note: programmatic option takes precedence over the env var(s)
 * - Writes a report file for anything ambiguous or missing.
 */

const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const REPO_ROOT = path.resolve(__dirname, '..')
const INDEX_D_TS = path.join(REPO_ROOT, 'index.d.ts')
const CONFIG_INDEX_JS = path.join(REPO_ROOT, 'packages/dd-trace/src/config/index.js')
const REPORT_PATH = path.join(REPO_ROOT, 'scripts/index-dts-env-docs.report.json')

const ENV_VAR_NAME_RE = /^(?:DD|OTEL)_[A-Z0-9_]+$/

function read (file) {
  return fs.readFileSync(file, 'utf8')
}

function write (file, contents) {
  fs.writeFileSync(file, contents, 'utf8')
}

function writeJSON (file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8')
}

function createJsSourceFile (filename, src) {
  return ts.createSourceFile(filename, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
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

function accessChainFromRoot (node, rootName) {
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
    return null
  }
  return null
}

function filterToDeepestPaths (paths) {
  const unique = Array.from(new Set(paths)).filter(Boolean)
  return unique.filter(p => !unique.some(other => other !== p && other.startsWith(`${p}.`)))
}

function collectOptionPathsFromNode (node, varInitMap, out, seenVars = new Set()) {
  const all = new Set()

  /** @param {ts.Node} n */
  function visit (n) {
    const chain = accessChainFromRoot(n, 'options')
    if (chain && chain.length > 0) all.add(chain.join('.'))

    if (ts.isIdentifier(n) && varInitMap.has(n.text) && !seenVars.has(n.text)) {
      seenVars.add(n.text)
      visit(varInitMap.get(n.text))
    }

    ts.forEachChild(n, visit)
  }

  if (node) visit(node)
  for (const p of filterToDeepestPaths(all)) out.add(p)
}

function addToSetMap (map, key, value) {
  if (!key || !value) return
  if (!map[key]) map[key] = new Set()
  map[key].add(value)
}

function parseEnvToInternal (configSrc) {
  const sf = createJsSourceFile(CONFIG_INDEX_JS, configSrc)
  const body = findPrivateMethodBlock(sf, '#applyConfigValues')
  if (!body) return {}
  const varInitMap = buildVarInitMap(body)

  /** @type {Record<string, Set<string>>} */
  const envToInternal = {}

  function addMapping (internalKey, exprNode) {
    const envs = new Set()
    collectEnvVarsFromNode(exprNode, varInitMap, envs)
    for (const env of envs) addToSetMap(envToInternal, env, internalKey)
  }

  /** @param {ts.Node} node */
  function visit (node) {
    if (ts.isCallExpression(node) && (ts.isPropertyAccessExpression(node.expression) || ts.isPropertyAccessChain(node.expression))) {
      const callee = node.expression
      if (callee.expression.kind === ts.SyntaxKind.ThisKeyword && ts.isPrivateIdentifier(callee.name)) {
        const [first, second, third] = node.arguments
        if (first && ts.isIdentifier(first) && first.text === 'target' && third) {
          if (second && (ts.isStringLiteral(second) || ts.isNoSubstitutionTemplateLiteral(second))) {
            addMapping(second.text, third)
          }
        }
      }
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      if (ts.isPropertyAccessExpression(node.left) &&
          ts.isIdentifier(node.left.expression) &&
          node.left.expression.text === 'target') {
        addMapping(node.left.name.text, node.right)
      }
      if (ts.isElementAccessExpression(node.left) &&
          ts.isIdentifier(node.left.expression) &&
          node.left.expression.text === 'target') {
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
  for (const [k, v] of Object.entries(envToInternal)) flat[k] = Array.from(v)
  return flat
}

function parseInternalToOptions (configSrc) {
  const sf = createJsSourceFile(CONFIG_INDEX_JS, configSrc)
  const body = findPrivateMethodBlock(sf, '#applyOptions')
  if (!body) return {}
  const varInitMap = buildVarInitMap(body)

  /** @type {Record<string, Set<string>>} */
  const internalToOptions = {}

  function addMapping (internalKey, exprNode) {
    const opts = new Set()
    collectOptionPathsFromNode(exprNode, varInitMap, opts)
    for (const opt of opts) addToSetMap(internalToOptions, internalKey, opt)
  }

  /** @param {ts.Node} node */
  function visit (node) {
    if (ts.isCallExpression(node) && (ts.isPropertyAccessExpression(node.expression) || ts.isPropertyAccessChain(node.expression))) {
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

function buildTracerOptionsDeclarationMap () {
  const program = ts.createProgram([INDEX_D_TS], { allowJs: false, checkJs: false, skipLibCheck: true })
  const checker = program.getTypeChecker()
  const sf = program.getSourceFile(INDEX_D_TS)
  if (!sf) throw new Error('Could not load index.d.ts')

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

  ts.forEachChild(sf, visit)
  if (!tracerOptionsDecl) throw new Error('Could not find TracerOptions in index.d.ts')

  const rootType = checker.getTypeAtLocation(tracerOptionsDecl)

  /** @type {Map<string, ts.Node>} */
  const declByPath = new Map()

  function isFunctionLike (type) {
    return type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0
  }

  function isArrayLike (type) {
    return checker.isArrayType(type) || checker.isTupleType(type)
  }

  function getObjectLikeConstituents (type) {
    if (type.flags & ts.TypeFlags.Union) {
      // @ts-expect-error runtime type narrowing
      return type.types.flatMap(getObjectLikeConstituents)
    }
    if (type.flags & ts.TypeFlags.Intersection) {
      // @ts-expect-error runtime type narrowing
      return type.types.flatMap(getObjectLikeConstituents)
    }
    if (isArrayLike(type)) return []
    if (isFunctionLike(type)) return []
    if (type.flags & ts.TypeFlags.Object) return [type]
    return []
  }

  const visited = new WeakMap()

  function shouldRecurse (type) {
    if (isFunctionLike(type) || isArrayLike(type)) return false
    const objectLikes = getObjectLikeConstituents(type)
    if (objectLikes.length === 0) return false
    return objectLikes.some(t => t.getProperties().length > 0)
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
        const decl = prop.valueDeclaration || prop.declarations?.[0]
        if (decl) declByPath.set(fullPath, decl)
        const propType = checker.getTypeOfSymbolAtLocation(prop, sf)
        if (shouldRecurse(propType)) walk(propType, fullPath)
      }
    }
  }

  for (const prop of rootType.getProperties()) {
    const name = prop.getName()
    const decl = prop.valueDeclaration || prop.declarations?.[0]
    if (decl) declByPath.set(name, decl)
    const propType = checker.getTypeOfSymbolAtLocation(prop, sf)
    if (shouldRecurse(propType)) walk(propType, name)
  }

  return { sourceFile: sf, declByPath }
}

function upsertEnvJsDoc (original, indent, envs) {
  const lines = original.split('\n')
  const out = []
  for (const line of lines) {
    if (/@env\b/.test(line)) continue
    if (/Programmatic configuration takes precedence over/.test(line)) continue
    out.push(line)
  }
  const envLine = `${indent} * @env ${envs.join(', ')}`
  const precLine = `${indent} * Programmatic configuration takes precedence over the environment variables listed above.`

  const rewritten = []
  for (const line of out) {
    if (line.trim() === '*/') {
      rewritten.push(envLine)
      rewritten.push(precLine)
    }
    rewritten.push(line)
  }
  return rewritten.join('\n')
}

function main () {
  const configSrc = read(CONFIG_INDEX_JS)
  const envToInternal = parseEnvToInternal(configSrc)
  const internalToOptions = parseInternalToOptions(configSrc)

  // Join env -> internal -> optionPath
  /** @type {Record<string, string[]>} */
  const envToOptionPaths = {}
  for (const [envVar, internals] of Object.entries(envToInternal)) {
    const optionPaths = new Set()
    for (const internal of internals) {
      for (const opt of internalToOptions[internal] || []) optionPaths.add(opt)
      // Some internals are also public option paths (e.g. "hostname")
      optionPaths.add(internal)
    }
    envToOptionPaths[envVar] = Array.from(optionPaths).sort()
  }

  // Candidate 1-to-1 mappings for doc insertion
  /** @type {Record<string, string[]>} optionPath -> envVars[] */
  const optionToEnvs = {}
  const report = {
    envMissingInConfig: [],
    envToMultipleInternals: [],
    internalToMultipleOptions: [],
    optionPathMissingInDts: []
  }

  // Compute internals -> option paths cardinality report
  for (const [internal, opts] of Object.entries(internalToOptions)) {
    if (opts.length > 1) report.internalToMultipleOptions.push({ internal, options: opts })
  }
  for (const [envVar, internals] of Object.entries(envToInternal)) {
    if (internals.length > 1) report.envToMultipleInternals.push({ envVar, internals })
  }

  const { sourceFile, declByPath } = buildTracerOptionsDeclarationMap()
  const indexTs = read(INDEX_D_TS)

  /** @type {{ start: number, end: number, text: string }[]} */
  const edits = []

  for (const [envVar, internals] of Object.entries(envToInternal)) {
    if (internals.length !== 1) continue
    const internal = internals[0]
    const optionPaths = envToOptionPaths[envVar] || []
    if (optionPaths.length !== 1) continue
    const optionPath = optionPaths[0]

    if (!declByPath.has(optionPath)) {
      report.optionPathMissingInDts.push({ envVar, internal, optionPath })
      continue
    }

    addToSetMap(optionToEnvs, optionPath, envVar)
  }

  for (const [optionPath, envsSet] of Object.entries(optionToEnvs)) {
    const envs = Array.from(envsSet).sort()
    const decl = declByPath.get(optionPath)
    if (!decl) continue

    // Determine indentation from file text
    const start = decl.getStart(sourceFile)
    const lineStart = indexTs.lastIndexOf('\n', start - 1) + 1
    const indent = indexTs.slice(lineStart, start).match(/^\s*/)?.[0] ?? ''

    const jsDocs = decl.jsDoc || []
    const jsDoc = jsDocs[jsDocs.length - 1]
    if (jsDoc) {
      const jsStart = jsDoc.pos
      const jsEnd = jsDoc.end
      const original = indexTs.slice(jsStart, jsEnd)
      const updated = upsertEnvJsDoc(original, indent, envs)
      if (updated !== original) edits.push({ start: jsStart, end: jsEnd, text: updated })
    } else {
      const insertAt = decl.getFullStart()
      const comment =
        `${indent}/**\n` +
        `${indent} * @env ${envs.join(', ')}\n` +
        `${indent} * Programmatic configuration takes precedence over the environment variables listed above.\n` +
        `${indent} */\n`
      edits.push({ start: insertAt, end: insertAt, text: comment })
    }
  }

  edits.sort((a, b) => b.start - a.start)
  let out = indexTs
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end)

  if (out !== indexTs) write(INDEX_D_TS, out)
  writeJSON(REPORT_PATH, report)
}

if (require.main === module) {
  main()
}

