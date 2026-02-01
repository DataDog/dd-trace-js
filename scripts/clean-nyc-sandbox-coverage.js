'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
// eslint-disable-next-line n/no-unsupported-features/node-builtins
const { parseArgs } = require('node:util')

const repoRootAbs = path.resolve(__dirname, '..')

/**
 * @param {string} p
 * @returns {boolean}
 */
function isSafeRepoRelativePath (p) {
  const candidate = toPosixPath(p)
  if (!candidate) return false
  if (candidate.startsWith('/')) return false
  if (candidate.includes('\0')) return false

  // Reject Windows drive/UNC-style "absolute" paths (nyc may record those on Windows).
  if (/^[a-zA-Z]:\//.test(candidate)) return false
  if (candidate.startsWith('//')) return false

  const abs = path.resolve(repoRootAbs, candidate)
  const rel = path.relative(repoRootAbs, abs)
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`)) return false

  return fs.existsSync(abs)
}

/**
 * @param {string} p
 * @returns {string}
 */
function toPosixPath (p) {
  return p.replaceAll('\\', '/')
}

/**
 * @param {string} p
 * @returns {string}
 */
function ensureLeadingSlash (p) {
  if (p.startsWith('/')) return p
  return `/${p}`
}

/**
 * @param {string} p
 * @returns {boolean}
 */
function isUnderOsTmpdir (p) {
  const candidate = ensureLeadingSlash(toPosixPath(p))
  const tmp = ensureLeadingSlash(toPosixPath(os.tmpdir()))

  // macOS sometimes mixes /var and /private/var paths.
  const candidateNoPrivate = candidate.startsWith('/private/') ? candidate.slice('/private'.length) : candidate
  const tmpNoPrivate = tmp.startsWith('/private/') ? tmp.slice('/private'.length) : tmp

  return candidateNoPrivate.startsWith(tmpNoPrivate.endsWith('/') ? tmpNoPrivate : `${tmpNoPrivate}/`)
}

/**
 * @param {string} sfPath
 * @returns {string|undefined} repo-relative rewritten path, or undefined if not a sandbox dd-trace path
 */
function rewriteSandboxDdTracePathToRepoRelative (sfPath) {
  const original = toPosixPath(sfPath)

  // If it's already repo-relative (e.g. after a previous clean pass), keep it.
  // This makes the cleaner idempotent and prevents double-invocation from wiping output.
  if (!isUnderOsTmpdir(original)) {
    if (isSafeRepoRelativePath(original)) return original
    return
  }

  // Must be inside the sandbox-installed dd-trace package.
  const markers = [
    '/node_modules/dd-trace/',
    '/node_modules/dd-trace-js/'
  ]

  for (const marker of markers) {
    const idx = original.lastIndexOf(marker)
    if (idx !== -1) {
      let out = original.slice(idx + marker.length)
      if (out.startsWith('/')) out = out.slice(1)
      return out
    }
  }
}

/**
 * @returns {string|undefined}
 */
function autoDetectLatestNycOutputDir () {
  const entries = fs.readdirSync(repoRootAbs, { withFileTypes: true })
  /** @type {{ abs: string, mtimeMs: number }[]} */
  const candidates = []

  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    if (!ent.name.startsWith('.nyc_output')) continue

    const abs = path.join(repoRootAbs, ent.name)
    const stat = fs.statSync(abs)
    candidates.push({ abs, mtimeMs: stat.mtimeMs })
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return candidates[0]?.abs
}

/**
 * @param {string} nycOutputAbs
 * @param {{ inPlace: boolean, outDirAbs?: string }} opts
 */
function cleanNycOutputDir (nycOutputAbs, opts) {
  const entries = fs.readdirSync(nycOutputAbs, { withFileTypes: true })

  /** @type {string[]} */
  const jsonFiles = []
  for (const ent of entries) {
    if (!ent.isFile()) continue
    if (!ent.name.endsWith('.json')) continue
    jsonFiles.push(ent.name)
  }

  if (!opts.inPlace && !opts.outDirAbs) {
    throw new Error('Expected either --in-place or --out-dir')
  }

  if (opts.outDirAbs) {
    fs.mkdirSync(opts.outDirAbs, { recursive: true })
  }

  let visitedFiles = 0
  let totalEntries = 0
  let keptEntries = 0
  let rewrittenEntries = 0

  for (const fileName of jsonFiles) {
    visitedFiles++
    const inAbs = path.join(nycOutputAbs, fileName)
    const raw = fs.readFileSync(inAbs, 'utf8')

    /** @type {Record<string, any>} */
    const coverageMap = JSON.parse(raw)
    /** @type {Record<string, any>} */
    const next = {}

    for (const [filePath, fileCoverage] of Object.entries(coverageMap)) {
      totalEntries++

      const rewritten = rewriteSandboxDdTracePathToRepoRelative(filePath)
      if (!rewritten) continue

      keptEntries++
      if (rewritten !== filePath) rewrittenEntries++

      // Keep nyc's internal shape intact, but normalize the key + `path` field.
      fileCoverage.path = rewritten
      next[rewritten] = fileCoverage
    }

    const outAbs = opts.inPlace ? inAbs : path.join(opts.outDirAbs, fileName)
    fs.writeFileSync(outAbs, JSON.stringify(next), 'utf8')
  }

  // eslint-disable-next-line no-console
  console.log(
    `Cleaned nyc output: visited ${visitedFiles} files, kept ${keptEntries}/${totalEntries} entries, rewrote ${rewrittenEntries} paths.`
  )
}

module.exports = { cleanNycOutputDir }

if (require.main === module) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      'nyc-output': { type: 'string' },
      'in-place': { type: 'boolean' },
      'out-dir': { type: 'string' }
    }
  })

  const inPlace = values['in-place'] ?? false
  const outDir = values['out-dir']

  let nycOutput = values['nyc-output'] || process.env.NYC_OUTPUT
  if (!nycOutput) {
    nycOutput = autoDetectLatestNycOutputDir()
  }

  if (!nycOutput) {
    // eslint-disable-next-line no-console
    console.error('Could not determine nyc output dir. Use --nyc-output <dir> or set NYC_OUTPUT.')
    process.exitCode = 1
    return
  }

  const nycOutputAbs = path.resolve(repoRootAbs, nycOutput)
  const outDirAbs = outDir ? path.resolve(repoRootAbs, outDir) : undefined

  if (!inPlace && !outDirAbs) {
    // eslint-disable-next-line no-console
    console.error('Usage: node scripts/clean-nyc-sandbox-coverage.js --in-place [--nyc-output <dir>] | --out-dir <dir>')
    process.exitCode = 1
    return
  }

  cleanNycOutputDir(nycOutputAbs, { inPlace, outDirAbs })
}

