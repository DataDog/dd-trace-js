'use strict'

const fs = require('node:fs')
const path = require('node:path')

const REPO_ROOT = path.resolve(__dirname, '..')

const SUPPORTED_JSON_PATH = path.join(REPO_ROOT, 'packages/dd-trace/src/config/supported-configurations.json')
const MISSING_LIST_PATH = path.join(
  REPO_ROOT,
  'packages/dd-trace/src/config/supported-configurations.missing-descriptions.json'
)
const OUT_PATH = path.join(
  REPO_ROOT,
  'packages/dd-trace/src/config/supported-configurations.env-usage-index.json'
)

const SEARCH_DIRS = [
  path.join(REPO_ROOT, 'packages/dd-trace/src'),
  path.join(REPO_ROOT, 'packages/dd-trace/test'),
  path.join(REPO_ROOT, 'packages/datadog-instrumentations/src'),
  // Include plugin implementations for richer env var usage evidence (e.g. AWS SDK span pointer env vars).
  // This is still bounded by our per-env max match cap and file type filter.
  path.join(REPO_ROOT, 'packages'),
  path.join(REPO_ROOT, 'integration-tests'),
  path.join(REPO_ROOT, 'scripts'),
  REPO_ROOT // for index.d.ts
]

const EXT_RE = /\.(?:[cm]?js|ts|d\.ts)$/i

function readJSON (file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function writeJSON (file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8')
}

function parseArgs () {
  const args = process.argv.slice(2)
  /** @type {{ small: number, large: number, maxMatches: number }} */
  const out = { small: 3, large: 12, maxMatches: 50 }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--small-context') out.small = Number.parseInt(args[++i], 10)
    else if (a === '--large-context') out.large = Number.parseInt(args[++i], 10)
    else if (a === '--max-matches') out.maxMatches = Number.parseInt(args[++i], 10)
  }
  if (!Number.isFinite(out.small) || out.small < 0) out.small = 3
  if (!Number.isFinite(out.large) || out.large < out.small) out.large = Math.max(out.small, 12)
  if (!Number.isFinite(out.maxMatches) || out.maxMatches < 1) out.maxMatches = 50
  return out
}

function listFilesRecursive (dir, out) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === 'vendor' || e.name === 'coverage') continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      listFilesRecursive(full, out)
      continue
    }
    if (!EXT_RE.test(e.name)) continue
    out.push(full)
  }
}

function computeLineStarts (text) {
  /** @type {number[]} */
  const starts = [0]
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1)
  }
  return starts
}

function posToLineCol (lineStarts, pos) {
  let lo = 0
  let hi = lineStarts.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const s = lineStarts[mid]
    const next = mid + 1 < lineStarts.length ? lineStarts[mid + 1] : Number.POSITIVE_INFINITY
    if (pos >= s && pos < next) return { line: mid + 1, col: pos - s + 1 }
    if (pos < s) hi = mid - 1
    else lo = mid + 1
  }
  return { line: 1, col: 1 }
}

function snippetByLineRadius (lines, line, radius) {
  const start = Math.max(1, line - radius)
  const end = Math.min(lines.length, line + radius)
  return lines.slice(start - 1, end).join('\n')
}

function extractLeadingCommentBlock (lines, line) {
  // Pull contiguous single-line comments or JSDoc-style lines directly above the hit.
  /** @type {string[]} */
  const out = []
  for (let i = line - 2; i >= 0; i--) {
    const raw = lines[i]
    const t = raw.trim()
    if (!t) {
      if (out.length) break
      continue
    }
    if (t.startsWith('//')) {
      out.push(t.replace(/^\/\/\s?/, ''))
      continue
    }
    if (t.startsWith('*') || t.startsWith('/*') || t.startsWith('*/')) {
      out.push(t.replace(/^\*+\s?/, '').replace(/^\/\*\*?\s?/, '').replace(/\*\/\s?$/, ''))
      continue
    }
    break
  }
  out.reverse()
  const joined = out.join('\n').trim()
  return joined.length ? joined : undefined
}

function loadMissingList () {
  try {
    const arr = readJSON(MISSING_LIST_PATH)
    if (Array.isArray(arr)) return arr.filter(x => typeof x === 'string')
  } catch {
    // ignore
  }
  const doc = readJSON(SUPPORTED_JSON_PATH)
  const supported = doc?.supportedConfigurations || {}
  const missing = []
  for (const [envVar, entries] of Object.entries(supported)) {
    const entry = Array.isArray(entries) ? entries[0] : undefined
    if (!entry || typeof entry !== 'object') continue
    if (entry.description === '__UNKNOWN__') missing.push(envVar)
  }
  return missing
}

function main () {
  const opts = parseArgs()
  const envVars = loadMissingList().sort()
  /** @type {Record<string, { matches: { file: string, line: number, col: number, snippetSmall: string, snippetLarge: string, leadingComment?: string }[] }>} */
  const matchesByEnvVar = {}
  for (const env of envVars) matchesByEnvVar[env] = { matches: [] }

  /** @type {string[]} */
  const files = []
  for (const dir of SEARCH_DIRS) {
    if (dir === REPO_ROOT) {
      // only include index.d.ts from repo root
      files.push(path.join(REPO_ROOT, 'index.d.ts'))
      continue
    }
    if (dir === path.join(REPO_ROOT, 'packages')) {
      // Only scan datadog-plugin-* packages (src + test) to avoid traversing the whole monorepo.
      let pkgs
      try {
        pkgs = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        pkgs = []
      }
      for (const e of pkgs) {
        if (!e.isDirectory()) continue
        if (!e.name.startsWith('datadog-plugin-')) continue
        listFilesRecursive(path.join(dir, e.name, 'src'), files)
        listFilesRecursive(path.join(dir, e.name, 'test'), files)
      }
      continue
    }
    listFilesRecursive(dir, files)
  }
  files.sort()

  for (const file of files) {
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    if (!text) continue
    const lineStarts = computeLineStarts(text)
    const lines = text.split('\n')

    for (const envVar of envVars) {
      if (matchesByEnvVar[envVar].matches.length >= opts.maxMatches) continue
      let idx = 0
      while (matchesByEnvVar[envVar].matches.length < opts.maxMatches) {
        const pos = text.indexOf(envVar, idx)
        if (pos === -1) break
        idx = pos + envVar.length
        const { line, col } = posToLineCol(lineStarts, pos)
        const snippetSmall = snippetByLineRadius(lines, line, opts.small)
        const snippetLarge = snippetByLineRadius(lines, line, opts.large)
        const leadingComment = extractLeadingCommentBlock(lines, line)
        matchesByEnvVar[envVar].matches.push({
          file: path.relative(REPO_ROOT, file),
          line,
          col,
          snippetSmall,
          snippetLarge,
          leadingComment
        })
      }
    }
  }

  for (const envVar of envVars) {
    matchesByEnvVar[envVar].matches.sort((a, b) => {
      const f = a.file.localeCompare(b.file)
      if (f !== 0) return f
      return a.line - b.line
    })
  }

  const out = {
    generatedAt: new Date().toISOString(),
    smallContextLines: opts.small,
    largeContextLines: opts.large,
    maxMatchesPerEnvVar: opts.maxMatches,
    matchesByEnvVar
  }
  writeJSON(OUT_PATH, out)
  process.stdout.write(`Indexed ${envVars.length} env vars\nWrote ${OUT_PATH}\n`)
}

if (require.main === module) {
  main()
}

