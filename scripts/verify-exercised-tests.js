'use strict'

const fs = require('node:fs')
const path = require('node:path')

const { globSync } = require('glob')
const YAML = require('yaml')

const DEFAULT_IGNORE_GLOBS = [
  '**/node_modules/**',
  '**/coverage/**',
  '**/.git/**',
  '**/.nyc_output/**',
  '**/.junit-tmp/**',
  'vendor/dist/**',
]

const GLOB_CACHE_MAX = 2000
/** @type {Map<string, string[]>} */
const globCache = new Map()
let globCacheHits = 0
let globCacheMisses = 0

/**
 * @param {string} pattern
 * @param {{cwd: string, nodir: boolean, windowsPathsNoEscape: boolean, ignore?: string[]}} opts
 * @returns {string[]}
 */
function globSyncCached (pattern, opts) {
  const ignoreKey = Array.isArray(opts.ignore) ? opts.ignore.join('\n') : ''
  const key = `${opts.cwd}\0${pattern}\0${opts.nodir ? 1 : 0}\0${opts.windowsPathsNoEscape ? 1 : 0}\0${ignoreKey}`

  const cached = globCache.get(key)
  if (cached) {
    globCacheHits++
    // Basic LRU: refresh insertion order.
    globCache.delete(key)
    globCache.set(key, cached)
    return cached
  }

  globCacheMisses++
  const res = globSync(pattern, opts)

  globCache.set(key, res)
  if (globCache.size > GLOB_CACHE_MAX) {
    const first = globCache.keys().next().value
    if (first !== undefined) globCache.delete(first)
  }

  return res
}

/**
 * @param {string} s
 * @returns {string}
 */
function stripOuterQuotes (s) {
  if (s.length < 2) return s
  const first = s[0]
  const last = s[s.length - 1]
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return s.slice(1, -1)
  }
  return s
}

/**
 * Minimal shell-ish tokenizer for our package.json scripts. Handles single/double quotes.
 * @param {string} s
 * @returns {string[]}
 */
function shellSplit (s) {
  /** @type {string[]} */
  const out = []
  let cur = ''
  /** @type {'"'|"'"|null} */
  let quote = null

  for (let i = 0; i < s.length; i++) {
    const ch = s[i]

    if (quote) {
      if (ch === quote) {
        quote = null
        continue
      }

      // Allow escaping within double quotes.
      if (quote === '"' && ch === '\\') {
        const next = s[i + 1]
        if (next) {
          cur += next
          i++
          continue
        }
      }

      cur += ch
      continue
    }

    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (cur) out.push(cur)
      cur = ''
      continue
    }

    cur += ch
  }

  if (cur) out.push(cur)
  return out
}

/**
 * @param {string} token
 * @returns {boolean}
 */
function looksLikeFileGlob (token) {
  // We only care about globs that can match paths in the repo.
  if (!token.includes('/') && !token.startsWith('**')) return false

  // Avoid env assignments like SERVICES=*.
  if (!token.includes('/') && token.includes('=')) return false

  // Typical glob metacharacters and brace expansion.
  return /[*?[\]{}()]/.test(token)
}

/**
 * Converts some shell-specific patterns in scripts into a conservative file glob.
 * @param {string} raw
 * @param {{ preserveEnv?: boolean }} [opts]
 * @returns {string}
 */
function normalizeScriptGlob (raw, opts = {}) {
  const preserveEnv = Boolean(opts.preserveEnv)
  let p = stripOuterQuotes(raw.trim())

  // Strip quotes that are meant for bash extglob options inside double-quoted strings.
  p = p.replaceAll('\'', '')

  // Convert bash extglob + command substitution patterns used in this repo into plain env vars.
  // Example: @($(echo $PLUGINS)) -> $PLUGINS
  // Example: @($(echo ${SPEC:-'*'})) -> ${SPEC:-*}
  p = p.replaceAll(/@\(\$\(\s*echo\s+([^)]+?)\s*\)\)/g, '$1')

  // For global analysis we treat env vars as wildcards, but when evaluating a specific CI run
  // we need to preserve them so they can be expanded with the provided env.
  if (!preserveEnv) {
    // Replace shell variable expansion with a wildcard for our analysis.
    // Examples:
    // - ${PLUGINS} -> *
    // - ${SPEC:-*} -> *
    // - $PLUGINS -> *
    p = p.replaceAll(/\$\{[^}]+\}/g, '*')
    p = p.replaceAll(/\$[A-Za-z_][A-Za-z0-9_]*/g, '*')
  }

  // Replace bash extglob constructs with a conservative wildcard to avoid parsing issues.
  // Examples: @(...), +(...), ?(...), !(...)
  p = p.replaceAll(/[@+?!]\([^)]*\)/g, '*')

  // Normalize leading './' which appears sometimes in scripts.
  if (p.startsWith('./')) p = p.slice(2)

  return p
}

/**
 * @param {string} s
 * @param {Record<string, string|undefined>} env
 * @returns {string}
 */
function expandEnvInString (s, env) {
  // ${NAME} / ${NAME:-default}
  s = s.replaceAll(/\$\{([^}]+)\}/g, (_m, inner) => {
    const name = String(inner).split(/[:\s]/, 1)[0]
    return formatEnvValue(name, env[name])
  })

  // $NAME
  s = s.replaceAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, name) => {
    return formatEnvValue(name, env[name])
  })

  return s
}

/**
 * @param {string} name
 * @param {string|undefined} value
 * @returns {string}
 */
function formatEnvValue (name, value) {
  const val = typeof value === 'string' && value.length ? value : ''
  if (!val) return '*'
  // GitHub Actions expressions are not resolvable here; treat them as unknown.
  if (val.includes('${{')) return '*'

  if (name === 'PLUGINS') {
    const items = val.split(/[,\s|]+/g).map(x => x.trim()).filter(Boolean)
    if (items.length > 1) return `{${items.join(',')}}`
    return items[0] || '*'
  }

  return val
}

/**
 * @param {string} maybe
 * @returns {string|null}
 */
function unwrapLiteralEnvValue (maybe) {
  const s = String(maybe ?? '').trim()
  if (!s) return null
  if (s.includes('${{')) return null
  return stripOuterQuotes(s)
}

/**
 * @param {string} value
 * @returns {string[]}
 */
function splitPlugins (value) {
  const raw = unwrapLiteralEnvValue(value)
  if (!raw) return []
  return raw
    .split(/[,\s|]+/g)
    .map(s => s.trim())
    .filter(Boolean)
}

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
function isPlainObject (v) {
  return Boolean(v) && v !== null && typeof v === 'object' && !Array.isArray(v)
}

/**
 * Parse `NAME=value` assignments in front of a command (e.g. `PLUGINS=foo SERVICES=bar yarn ...`).
 * @param {string} prefix
 * @returns {Record<string, string>}
 */
function parseInlineAssignments (prefix) {
  /** @type {Record<string, string>} */
  const out = {}
  const tokens = shellSplit(prefix)
  for (const t of tokens) {
    const eq = t.indexOf('=')
    if (eq <= 0) continue
    const name = t.slice(0, eq)
    const value = t.slice(eq + 1)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue
    out[name] = stripOuterQuotes(value)
  }
  return out
}

/**
 * Extract `export NAME=value` assignments from a multi-line `run:` string.
 * @param {string} run
 * @returns {Record<string, string>}
 */
function parseExportAssignments (run) {
  /** @type {Record<string, string>} */
  const out = {}
  const lines = String(run).split('\n')
  for (const line of lines) {
    const m = line.match(/^\s*export\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/)
    if (!m) continue
    out[m[1]] = stripOuterQuotes(m[2].trim())
  }
  return out
}

/**
 * @param {string} repoRoot
 * @returns {string[]}
 */
function findTestFiles (repoRoot) {
  const commonGlobOpts = { cwd: repoRoot, nodir: true, windowsPathsNoEscape: true, ignore: DEFAULT_IGNORE_GLOBS }

  const files = [
    ...globSyncCached('**/*.spec.js', commonGlobOpts),
    ...globSyncCached('**/*.test.mjs', commonGlobOpts),
  ]

  files.sort((a, b) => a.localeCompare(b, 'en'))
  return files
}

/**
 * @param {string} repoRoot
 * @param {Record<string, string>} scripts
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ globs: string[], matchedFiles: Set<string> }}
 */
function expandScriptGlobs (repoRoot, scripts, env = {}) {
  const ignore = DEFAULT_IGNORE_GLOBS

  /** @type {string[]} */
  const allGlobs = []
  const matchedFiles = new Set()

  const scriptNames = Object.keys(scripts).sort((a, b) => a.localeCompare(b, 'en'))
  for (const scriptName of scriptNames) {
    const script = scripts[scriptName]
    if (typeof script !== 'string') continue

    const tokens = shellSplit(script)
    for (const token of tokens) {
      if (!looksLikeFileGlob(token)) continue

      const normalized = expandEnvInString(normalizeScriptGlob(token), env)
      allGlobs.push(normalized)

      let expanded
      try {
        expanded = globSyncCached(normalized, { cwd: repoRoot, nodir: true, windowsPathsNoEscape: true, ignore })
      } catch {
        // If a pattern can't be parsed by glob, skip expanding it. It still counts as an extracted glob.
        continue
      }

      for (const file of expanded) {
        matchedFiles.add(file)
      }
    }
  }

  return { globs: allGlobs, matchedFiles }
}

/**
 * Find `yarn run <script>` / `npm run <script>` and `yarn <script>` (only when it looks like a script)
 * in a `run:` block.
 * @param {string} run
 * @param {Set<string>} knownScripts
 * @returns {{ tool: 'yarn'|'npm', script: string, explicit: boolean }[]}
 */
function extractScriptInvocations (run, knownScripts) {
  /** @type {{ tool: 'yarn'|'npm', script: string, explicit: boolean }[]} */
  const out = []

  const tokens = shellSplit(String(run))
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]

    if (t === 'yarn') {
      let j = i + 1
      const isExplicitRun = tokens[j] === 'run'
      if (isExplicitRun) j++
      const script = tokens[j]
      if (!script || !/^[A-Za-z0-9:_-]+$/.test(script)) continue

      // `yarn run <name>` is unambiguously a package script.
      if (isExplicitRun) {
        out.push({ tool: 'yarn', script, explicit: true })
        continue
      }

      // `yarn <name>` is ambiguous (could be built-in like `yarn config`).
      // Only treat it as a script when it is known (or looks like a script name by convention).
      if (knownScripts.has(script) || script.includes(':')) {
        out.push({ tool: 'yarn', script, explicit: false })
      }
      continue
    }

    if (t === 'npm' && tokens[i + 1] === 'run') {
      const script = tokens[i + 2]
      if (script && /^[A-Za-z0-9:_-]+$/.test(script)) {
        out.push({ tool: 'npm', script, explicit: true })
      }
    }
  }

  return out
}

/**
 * Expand a script and any nested `npm run`/`yarn <script>` calls into matched files.
 * @param {string} repoRoot
 * @param {Record<string, string>} scripts
 * @param {Set<string>} knownScripts
 * @param {string} scriptName
 * @param {Record<string, string|undefined>} env
 * @returns {{ files: Set<string>, globs: string[], visited: string[] }}
 */
function expandInvokedScript (repoRoot, scripts, knownScripts, scriptName, env) {
  /** @type {string[]} */
  const visited = []
  /** @type {string[]} */
  const allGlobs = []
  const files = new Set()

  /** @type {string[]} */
  const queue = [scriptName]
  const seen = new Set()

  const ignore = DEFAULT_IGNORE_GLOBS

  while (queue.length) {
    const name = queue.shift()
    if (!name || seen.has(name)) continue
    seen.add(name)
    visited.push(name)

    const cmd = scripts[name]
    if (typeof cmd !== 'string') continue

    // Extract and expand glob tokens from the script command.
    const tokens = shellSplit(cmd)
    for (const token of tokens) {
      if (!looksLikeFileGlob(token)) continue
      const normalized = expandEnvInString(normalizeScriptGlob(token, { preserveEnv: true }), env)
      allGlobs.push(normalized)
      let expanded
      try {
        expanded = globSyncCached(normalized, { cwd: repoRoot, nodir: true, windowsPathsNoEscape: true, ignore })
      } catch {
        continue
      }
      for (const f of expanded) files.add(f)
    }

    // Follow nested script invocations.
    const nested = extractScriptInvocations(cmd, knownScripts)
    for (const n of nested) queue.push(n.script)
  }

  return { files, globs: allGlobs, visited }
}

/**
 * @param {string} repoRoot
 * @returns {string[]}
 */
function findWorkflowFiles (repoRoot) {
  const files = globSyncCached('.github/workflows/*.{yml,yaml}', {
    cwd: repoRoot,
    nodir: true,
    windowsPathsNoEscape: true,
  })
  files.sort((a, b) => a.localeCompare(b, 'en'))
  return files
}

/**
 * @param {string} repoRoot
 * @returns {unknown|null}
 */
/** @type {Map<string, unknown|null>} */
const yamlFileCache = new Map()

function parseYamlFile (repoRoot, file) {
  const cached = yamlFileCache.get(file)
  if (cached !== undefined) return cached

  /** @type {unknown|null} */
  let doc
  try {
    const raw = fs.readFileSync(path.join(repoRoot, file), 'utf8')
    doc = YAML.parse(raw)
  } catch {
    doc = null
  }

  yamlFileCache.set(file, doc)
  return doc
}

/** @type {Map<string, string|null>} */
const localActionFileCache = new Map()

/**
 * @param {string} repoRoot
 * @param {string} uses
 * @returns {string|null}
 */
function resolveLocalActionFile (repoRoot, uses) {
  if (typeof uses !== 'string') return null
  if (!uses.startsWith('./')) return null

  const cached = localActionFileCache.get(uses)
  if (cached !== undefined) return cached

  const rel = uses.replace(/^\.\//, '')
  const dir = path.join(repoRoot, rel)
  const yml = path.join(dir, 'action.yml')
  const yamlFile = path.join(dir, 'action.yaml')

  let resolved = null
  if (fs.existsSync(yml)) resolved = path.join(rel, 'action.yml')
  else if (fs.existsSync(yamlFile)) resolved = path.join(rel, 'action.yaml')

  localActionFileCache.set(uses, resolved)
  return resolved
}

/**
 * @param {unknown} step
 * @returns {step is { run: string, env?: Record<string, unknown> }}
 */
function isRunStep (step) {
  return isPlainObject(step) && typeof step.run === 'string'
}

/**
 * @param {unknown} step
 * @returns {step is { uses: string, env?: Record<string, unknown> }}
 */
function isUsesStep (step) {
  return isPlainObject(step) && typeof step.uses === 'string'
}

/**
 * @param {string} repoRoot
 * @param {string} uses
 * @param {Record<string, string|undefined>} env
 * @param {Set<string>} visiting
 * @returns {{ run: string, env: Record<string, string|undefined> }[]}
 */
function expandLocalCompositeActionRuns (repoRoot, uses, env, visiting) {
  const actionFile = resolveLocalActionFile(repoRoot, uses)
  if (!actionFile) return []
  if (visiting.has(actionFile)) return []
  visiting.add(actionFile)

  const doc = parseYamlFile(repoRoot, actionFile)
  if (!isPlainObject(doc)) return []

  const runs = doc.runs
  if (!isPlainObject(runs) || runs.using !== 'composite') return []
  const steps = Array.isArray(runs.steps) ? runs.steps : []

  /** @type {{ run: string, env: Record<string, string|undefined> }[]} */
  const out = []

  for (const s of steps) {
    if (isRunStep(s)) {
      /** @type {Record<string, string|undefined>} */
      const stepEnv = { ...env }
      if (isPlainObject(s.env)) {
        for (const [k, v] of Object.entries(s.env)) stepEnv[k] = typeof v === 'string' ? v : String(v)
      }

      // Inline env in composite run: export and prefix assignments.
      const exports = parseExportAssignments(s.run)
      for (const [k, v] of Object.entries(exports)) stepEnv[k] = v

      const idxYarn = s.run.indexOf('yarn ')
      const idxNpm = s.run.indexOf('npm ')
      const idx = idxYarn === -1 ? idxNpm : (idxNpm === -1 ? idxYarn : Math.min(idxYarn, idxNpm))
      if (idx > 0) {
        const prefix = s.run.slice(0, idx)
        const assigns = parseInlineAssignments(prefix)
        for (const [k, v] of Object.entries(assigns)) stepEnv[k] = v
      }

      out.push({ run: s.run, env: stepEnv })
      continue
    }

    if (isUsesStep(s)) {
      // Recurse into local composite actions.
      /** @type {Record<string, string|undefined>} */
      const nextEnv = { ...env }
      if (isPlainObject(s.env)) {
        for (const [k, v] of Object.entries(s.env)) nextEnv[k] = typeof v === 'string' ? v : String(v)
      }
      const nested = expandLocalCompositeActionRuns(repoRoot, s.uses, nextEnv, visiting)
      for (const n of nested) out.push(n)
    }
  }

  visiting.delete(actionFile)
  return out
}

/**
 * @param {string} repoRoot
 * @returns {{ workflowFile: string, jobId: string, run: string, env: Record<string, string|undefined> }[]}
 */
function collectWorkflowRuns (repoRoot) {
  /** @type {{ workflowFile: string, jobId: string, run: string, env: Record<string, string|undefined> }[]} */
  const out = []

  const files = findWorkflowFiles(repoRoot)
  for (const wf of files) {
    const doc = parseYamlFile(repoRoot, wf)
    if (!isPlainObject(doc)) continue

    const topEnv = isPlainObject(doc.env) ? doc.env : {}
    const jobs = isPlainObject(doc.jobs) ? doc.jobs : {}

    for (const [jobId, jobVal] of Object.entries(jobs)) {
      const job = isPlainObject(jobVal) ? jobVal : {}
      const jobEnv = isPlainObject(job.env) ? job.env : {}
      const steps = Array.isArray(job.steps) ? job.steps : []

      for (const stepVal of steps) {
        const step = isPlainObject(stepVal) ? stepVal : {}

        // Merge env. Values can be strings or non-strings; we only keep string-ish.
        /** @type {Record<string, string|undefined>} */
        const env = {}
        for (const [k, v] of Object.entries(topEnv)) env[k] = typeof v === 'string' ? v : String(v)
        for (const [k, v] of Object.entries(jobEnv)) env[k] = typeof v === 'string' ? v : String(v)
        if (isPlainObject(step.env)) {
          for (const [k, v] of Object.entries(step.env)) env[k] = typeof v === 'string' ? v : String(v)
        }

        if (typeof step.run === 'string') {
          // Inline env in `run:` (export lines and prefix assignments before yarn/npm).
          const exports = parseExportAssignments(step.run)
          for (const [k, v] of Object.entries(exports)) env[k] = v

          const idxYarn = step.run.indexOf('yarn ')
          const idxNpm = step.run.indexOf('npm ')
          const idx = idxYarn === -1 ? idxNpm : (idxNpm === -1 ? idxYarn : Math.min(idxYarn, idxNpm))
          if (idx > 0) {
            const prefix = step.run.slice(0, idx)
            const assigns = parseInlineAssignments(prefix)
            for (const [k, v] of Object.entries(assigns)) env[k] = v
          }

          out.push({ workflowFile: wf, jobId, run: step.run, env })
          continue
        }

        if (typeof step.uses === 'string' && step.uses.startsWith('./')) {
          const expanded = expandLocalCompositeActionRuns(repoRoot, step.uses, env, new Set())
          for (const e of expanded) {
            out.push({ workflowFile: wf, jobId, run: e.run, env: e.env })
          }
        }
      }
    }
  }

  return out
}

/**
 * @param {string} repoRoot
 * @returns {Set<string>}
 */
function listPluginPackages (repoRoot) {
  const entries = globSyncCached('packages/datadog-plugin-*', {
    cwd: repoRoot,
    nodir: false,
    windowsPathsNoEscape: true,
  })

  const out = new Set()
  for (const p of entries) {
    const full = path.join(repoRoot, p)
    try {
      if (!fs.statSync(full).isDirectory()) continue
    } catch {
      continue
    }
    const name = path.basename(p).slice('datadog-plugin-'.length)
    if (name) out.add(name)
  }
  return out
}

/**
 * @param {string} repoRoot
 * @returns {Set<string>}
 */
function loadUpstreamPluginNames (repoRoot) {
  const file = path.join(repoRoot, 'packages', 'dd-trace', 'test', 'plugins', 'versions', 'package.json')
  try {
    /** @type {unknown} */
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
    const deps = isPlainObject(pkg) && isPlainObject(pkg.dependencies) ? pkg.dependencies : {}
    return new Set(Object.keys(deps))
  } catch {
    return new Set()
  }
}

/**
 * @param {string} repoRoot
 * @returns {Record<string, Array<{ name?: string }>>}
 */
function loadUpstreamExternals (repoRoot) {
  const file = path.join(repoRoot, 'packages', 'dd-trace', 'test', 'plugins', 'externals.js')
  try {
    /** @type {unknown} */
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
    return isPlainObject(doc) ? /** @type {Record<string, Array<{ name?: string }>>} */ (doc) : {}
  } catch {
    return {}
  }
}

/**
 * @param {Record<string, string>} scripts
 * @returns {Set<string>}
 */
function buildScriptPrefixSet (scripts) {
  /** @type {Set<string>} */
  const out = new Set()

  for (const name of Object.keys(scripts)) {
    if (!name.startsWith('test:')) continue
    const parts = name.split(':')
    for (let i = 2; i <= parts.length; i++) {
      out.add(parts.slice(0, i).join(':'))
    }
  }

  return out
}

/**
 * @param {Record<string, string>} scripts
 * @returns {Set<string>}
 */
function getTraceCoreCategoriesFromScripts (scripts) {
  const cmd = scripts['test:trace:core']
  if (typeof cmd !== 'string') return new Set()

  // Extract the {a,b,c} part from:
  // packages/dd-trace/test/{a,b,c}/**/*.spec.js
  const m = cmd.match(/packages\/dd-trace\/test\/\{([^}]+)\}\/\*\*\/\*\.spec\.js/)
  if (!m) return new Set()

  const cats = m[1].split(',').map(s => s.trim()).filter(Boolean)
  return new Set(cats)
}

/**
 * @param {string} repoRoot
 * @returns {Set<string>}
 */
function findDdTraceTestCategories (repoRoot) {
  const files = globSyncCached('packages/dd-trace/test/*/**/*.spec.js', {
    cwd: repoRoot,
    nodir: true,
    windowsPathsNoEscape: true,
    ignore: [
      '**/node_modules/**',
    ],
  })

  /** @type {Set<string>} */
  const out = new Set()
  const prefix = 'packages/dd-trace/test/'
  for (const f of files) {
    // packages/dd-trace/test/<cat>/...
    if (!f.startsWith(prefix)) continue
    const rest = f.slice(prefix.length)
    const slash = rest.indexOf('/')
    if (slash > 0) out.add(rest.slice(0, slash))
  }

  return out
}

/**
 * @param {string} repoRoot
 * @param {string} category
 * @returns {string[]}
 */
function listDdTraceCategorySpecFiles (repoRoot, category) {
  const files = globSyncCached(`packages/dd-trace/test/${category}/**/*.spec.js`, {
    cwd: repoRoot,
    nodir: true,
    windowsPathsNoEscape: true,
    ignore: [
      '**/node_modules/**',
    ],
  })
  files.sort((a, b) => a.localeCompare(b, 'en'))
  return files
}

/**
 * @param {Set<string>} scriptPrefixes
 * @param {string} category
 * @returns {boolean}
 */
function isCategoryCoveredByOtherScript (scriptPrefixes, category) {
  const aliases = {
    // Historical naming mismatch: tests live in `test/profiling/` but scripts use `profiler`.
    profiling: ['profiler'],
  }

  const keys = [category]
  const extra = aliases[category]
  if (Array.isArray(extra)) keys.push(...extra)

  for (const key of keys) {
    if (scriptPrefixes.has(`test:${key}`)) return true
    if (scriptPrefixes.has(`test:trace:${key}`)) return true
    if (scriptPrefixes.has(`test:integration:${key}`)) return true
  }

  return false
}

/**
 * @param {string} repoRoot
 * @returns {Set<string>}
 */
function buildAppsecPluginTestSet (repoRoot) {
  const files = globSyncCached('packages/dd-trace/test/appsec/**/*.plugin.spec.js', {
    cwd: repoRoot,
    nodir: true,
    windowsPathsNoEscape: true,
    ignore: DEFAULT_IGNORE_GLOBS,
  })

  /** @type {Set<string>} */
  const out = new Set()
  for (const f of files) {
    const base = path.basename(f)
    // e.g. graphql.apollo-server-express.plugin.spec.js -> apollo-server-express
    const m = base.match(/\.([^.]+)\.plugin\.spec\.js$/)
    if (m && m[1]) out.add(m[1])
  }
  return out
}

/**
 * @param {string} repoRoot
 * @returns {Set<string>}
 */
function buildLlmobsPluginTestSet (repoRoot) {
  const files = globSyncCached('packages/dd-trace/test/llmobs/plugins/*/*.spec.js', {
    cwd: repoRoot,
    nodir: true,
    windowsPathsNoEscape: true,
    ignore: DEFAULT_IGNORE_GLOBS,
  })

  /** @type {Set<string>} */
  const out = new Set()
  const prefix = 'packages/dd-trace/test/llmobs/plugins/'
  for (const f of files) {
    if (!f.startsWith(prefix)) continue
    const rest = f.slice(prefix.length)
    const slash = rest.indexOf('/')
    if (slash > 0) out.add(rest.slice(0, slash))
  }
  return out
}

function main () {
  const startNs = process.hrtime.bigint()

  const repoRoot = path.resolve(__dirname, '..')
  const packageJsonPath = path.join(repoRoot, 'package.json')
  const pluginsVar = '$' + '{PLUGINS}'
  const bracePluginsVar = '{' + pluginsVar + '}'
  const ghaExprStart = '$' + '{{'

  /** @type {{ scripts?: Record<string, string> }} */
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
  const scripts = pkg.scripts || {}
  const knownScripts = new Set(Object.keys(scripts))
  const scriptPrefixes = buildScriptPrefixSet(scripts)

  const testFiles = findTestFiles(repoRoot)
  const { globs, matchedFiles } = expandScriptGlobs(repoRoot, scripts)

  /** @type {string[]} */
  const missing = []
  for (const file of testFiles) {
    if (!matchedFiles.has(file)) missing.push(file)
  }

  if (missing.length) {
    process.stderr.write('Test files not covered by any package.json script glob.\n')
    process.stderr.write(`Found test files: ${testFiles.length}\n`)
    process.stderr.write(`Extracted globs: ${globs.length}\n\n`)
    for (const file of missing) {
      process.stderr.write(`- ${file}\n`)
    }
    process.exit(1)
  }

  const workflowRuns = collectWorkflowRuns(repoRoot)

  /** @type {{ workflowFile: string, jobId: string, script: string, env: Record<string, string|undefined> }[]} */
  const invoked = []
  for (const r of workflowRuns) {
    for (const inv of extractScriptInvocations(r.run, knownScripts)) {
      invoked.push({ workflowFile: r.workflowFile, jobId: r.jobId, script: inv.script, env: r.env })
    }
  }

  const uniqueErrors = new Set()
  /** @param {string} msg */
  const pushError = (msg) => {
    if (!uniqueErrors.has(msg)) uniqueErrors.add(msg)
  }

  const invokedScripts = new Set(invoked.map(i => i.script))

  // CI must not invoke missing scripts.
  for (const i of invoked) {
    if (!scripts[i.script]) {
      // Any entry in `invoked` already passed our "looks like a script" filter in extractScriptInvocations.
      pushError(`${i.workflowFile}#${i.jobId}: invokes missing script "${i.script}"`)
    }
  }

  // All :ci scripts should be referenced by CI.
  for (const name of Object.keys(scripts).sort((a, b) => a.localeCompare(b, 'en'))) {
    if (!name.endsWith(':ci')) continue
    if (!invokedScripts.has(name)) {
      pushError(`package.json: script "${name}" is not invoked by any GitHub Actions workflow`)
    }
  }

  // All test:integration* scripts should be referenced by CI (except test:integration:plugins).
  for (const name of Object.keys(scripts).sort((a, b) => a.localeCompare(b, 'en'))) {
    if (!name.startsWith('test:integration')) continue
    // Skip test:integration:plugins - it's a convenience script for running only plugin integration
    // tests locally, but in CI these are already covered by test:plugins:ci (which runs all plugin
    // tests including integration tests).
    if (name === 'test:integration:plugins') continue
    if (!invokedScripts.has(name)) {
      pushError(`package.json: script "${name}" is not invoked by any GitHub Actions workflow`)
    }
  }

  // Validate plugin setup (domain-specific):
  // - test:plugins* expects packages/datadog-plugin-<name>
  // - test:appsec:plugins* expects matching *.plugin.spec.js files
  // - test:llmobs:plugins* expects llmobs plugin test directories
  // - test:plugins:upstream expects the module name listed in packages/dd-trace/test/plugins/versions/package.json
  const pluginPkgs = listPluginPackages(repoRoot)
  const versionsDeps = loadUpstreamPluginNames(repoRoot)
  const pluginExternals = loadUpstreamExternals(repoRoot)
  const appsecPluginTests = buildAppsecPluginTestSet(repoRoot)
  const llmobsPluginTests = buildLlmobsPluginTestSet(repoRoot)

  // Detect CI steps that will match no tests due to env/script mismatches.
  const testFileSet = new Set(testFiles)
  for (const i of invoked) {
    if (!i.script.startsWith('test:')) continue

    /** @type {Record<string, string|undefined>} */
    const env = { ...i.env }

    // Only use literal PLUGINS for matching; expressions are unknown.
    if (env.PLUGINS && env.PLUGINS.includes(ghaExprStart)) env.PLUGINS = undefined

    const { files, globs: invokedGlobs } = expandInvokedScript(repoRoot, scripts, knownScripts, i.script, env)

    // Only enforce "matches test files" when the (expanded) script actually contains globs.
    // Some scripts (e.g. `test:plugins:upstream`) run a suite runner and do not directly
    // enumerate files via globs.
    if (invokedGlobs.length) {
      let matchedTestCount = 0
      for (const f of files) {
        if (testFileSet.has(f)) matchedTestCount++
      }

      if (matchedTestCount === 0) {
        const pluginsRaw = unwrapLiteralEnvValue(i.env.PLUGINS || '')
        const hint = pluginsRaw && /[,|]/.test(pluginsRaw) && scripts[`${i.script}:multi`]
          ? ` (PLUGINS="${pluginsRaw}" looks multi-valued; did you mean "${i.script}:multi"?)`
          : ''
        pushError(`${i.workflowFile}#${i.jobId}: "${i.script}" would match 0 test files${hint}`)
      }
    }

    // Validate each plugin name individually when PLUGINS is present
    // (avoid "one matches, one doesn't" hiding mistakes).
    const pluginsRaw = unwrapLiteralEnvValue(i.env.PLUGINS || '')
    const pluginList = pluginsRaw ? splitPlugins(pluginsRaw) : []

    if (pluginList.length) {
      if (i.script === 'test:plugins:upstream') {
        for (const p of pluginList) {
          const externals = pluginExternals[p]
          if (!Array.isArray(externals) || externals.length === 0) continue

          for (const ext of externals) {
            const dep = ext && typeof ext === 'object' ? ext.name : undefined
            if (!dep || typeof dep !== 'string') continue
            if (!versionsDeps.has(dep)) {
              pushError(
                `${i.workflowFile}#${i.jobId}: upstream dependency "${dep}" (from externals.js "${p}") ` +
                'is not listed in packages/dd-trace/test/plugins/versions/package.json'
              )
            }
          }
        }
      } else if (i.script.startsWith('test:appsec:plugins')) {
        for (const p of pluginList) {
          // In AppSec workflows, PLUGINS often includes "setup" dependencies that are used by a test
          // (e.g. express + multer) without necessarily having a dedicated `*.${plugin}.plugin.spec.js`
          // file. We only fail when the plugin is not:
          // - referenced by an AppSec plugin test file, AND
          // - a real dd-trace plugin package, AND
          // - an upstream test dependency in versions/package.json (e.g. apollo-server-core)
          const hasAppsecTests = appsecPluginTests.has(p)
          const isPluginPkg = pluginPkgs.has(p)
          const isUpstreamDep = versionsDeps.has(p)

          if (!hasAppsecTests && !isPluginPkg && !isUpstreamDep) {
            pushError(
              `${i.workflowFile}#${i.jobId}: PLUGINS includes "${p}" but no appsec plugin tests match ` +
              `"packages/dd-trace/test/appsec/**/*.${p}.plugin.spec.js" and it is not a plugin package ` +
              'or an upstream dependency in packages/dd-trace/test/plugins/versions/package.json'
            )
          }
        }
      } else if (i.script.startsWith('test:llmobs:plugins')) {
        for (const p of pluginList) {
          if (!llmobsPluginTests.has(p)) {
            pushError(
              `${i.workflowFile}#${i.jobId}: PLUGINS includes "${p}" but no llmobs plugin tests match ` +
              `'packages/dd-trace/test/llmobs/plugins/${p}/*.spec.js'`
            )
          }
        }
      } else if (i.script.startsWith('test:plugins') || i.script.includes(':plugins')) {
        for (const p of pluginList) {
          if (!pluginPkgs.has(p)) {
            pushError(
              `${i.workflowFile}#${i.jobId}: PLUGINS includes "${p}" but packages/datadog-plugin-${p} does not exist`
            )
            continue
          }
        }
      }
    }

    // If PLUGINS is multi-valued and we have a matching :multi script, enforce using it.
    if (pluginsRaw && /[,|]/.test(pluginsRaw)) {
      const cmd = scripts[i.script]
      if (
        typeof cmd === 'string' &&
        cmd.includes(pluginsVar) &&
        !cmd.includes(bracePluginsVar) &&
        scripts[`${i.script}:multi`]
      ) {
        pushError(
            `${i.workflowFile}#${i.jobId}: PLUGINS="${pluginsRaw}" but CI runs "${i.script}" ` +
            `which is single-plugin; use "${i.script}:multi" instead`
        )
      }
    }
  }

  // NOTE: We intentionally do NOT require every datadog-plugin-* package to appear in CI here.
  // Some plugins are intentionally excluded (platform/service constraints) and are tracked elsewhere.

  if (uniqueErrors.size) {
    process.stderr.write('CI / script coverage checks failed:\n')
    for (const e of uniqueErrors) process.stderr.write(`- ${e}\n`)
    process.exit(1)
  }

  // Warn about dd-trace test categories not covered by test:trace:core.
  // This helps prevent "silent" test directories that are never run by the core suite.
  let hasCategoryWarnings = false
  const traceCoreCats = getTraceCoreCategoriesFromScripts(scripts)
  if (traceCoreCats.size) {
    const ddTraceCats = findDdTraceTestCategories(repoRoot)
    /** @type {string[]} */
    const missingFromTraceCore = []

    for (const cat of ddTraceCats) {
      if (!traceCoreCats.has(cat)) missingFromTraceCore.push(cat)
    }

    missingFromTraceCore.sort((a, b) => a.localeCompare(b, 'en'))

    /** @type {string[]} */
    const warnLines = []
    for (const cat of missingFromTraceCore) {
      const covered = isCategoryCoveredByOtherScript(scriptPrefixes, cat)
      // Only warn when the category is excluded from core AND we can't find any dedicated script
      // that appears to cover it. If it is covered elsewhere, it should not produce warnings.
      if (!covered) {
        const files = listDdTraceCategorySpecFiles(repoRoot, cat)
        const maxList = 25
        warnLines.push(`test:trace:core excludes "${cat}" (no dedicated test script found; files: ${files.length})`)
        for (let i = 0; i < files.length && i < maxList; i++) {
          warnLines.push(`  - ${files[i]}`)
        }
        if (files.length > maxList) {
          warnLines.push(`  - ... ${files.length - maxList} more`)
        }
      }
    }

    if (warnLines.length) {
      hasCategoryWarnings = true
      process.stdout.write('\nWarnings:\n')
      for (const w of warnLines) {
        if (w.startsWith('  ')) process.stdout.write(w + '\n')
        else process.stdout.write(`- ${w}\n`)
      }
    }
  } else if (typeof scripts['test:trace:core'] === 'string') {
    hasCategoryWarnings = true
    process.stdout.write('\nWarnings:\n')
    process.stdout.write('- Could not parse categories from scripts["test:trace:core"]\n')
  }

  if (hasCategoryWarnings) {
    process.stdout.write(
      'Some dd-trace test files are not covered by test:trace:core and no dedicated test script was found.\n'
    )
  } else {
    process.stdout.write('All test files are covered by at least one package.json script glob.\n')
  }
  process.stdout.write('All CI workflows reference valid scripts, and plugin setup looks consistent.\n')
  process.stdout.write(`Test files: ${testFiles.length}\n`)
  process.stdout.write(`Extracted globs: ${globs.length}\n`)

  const durMs = Number(process.hrtime.bigint() - startNs) / 1e6
  process.stdout.write(`Runtime(ms): ${durMs.toFixed(1)}\n`)
  process.stdout.write(`Glob cache: size=${globCache.size} hits=${globCacheHits} misses=${globCacheMisses}\n`)

  process.exit(hasCategoryWarnings ? 1 : 0)
}

main()
