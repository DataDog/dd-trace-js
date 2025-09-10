'use strict'

const fs = require('fs/promises')
const path = require('path')

// Light-weight heuristic judge to approximate human judgment of core APIs
// Signals:
// - Mentions in README/docs/examples/tests (weighted)
// - Presence in type declarations (.d.ts)
// - File path hints (core/client/connection vs utils/helpers/internal)

const MAX_FILE_SIZE_BYTES = 512 * 1024

const WEIGHTS = {
  readme: 3,
  docs: 2,
  examples: 2,
  tests: 2,
  types: 1.5
}

const PATH_BOOST = {
  positive: [/\bcore\b/i, /\bclient\b/i, /\bconnection\b/i, /\brequest\b/i, /\badapter\b/i, /\bcommand\b/i],
  negative: [/\butils?\b/i, /\bhelpers?\b/i, /\binternal\b/i, /\bheaders?\b/i, /\bvalidator\b/i, /\btypes?\b/i]
}

function clamp (num, min, max) {
  return Math.min(Math.max(num, min), max)
}

async function safeRead (filePath) {
  try {
    const stat = await fs.stat(filePath)
    if (!stat.isFile() || stat.size > MAX_FILE_SIZE_BYTES) return ''
    return await fs.readFile(filePath, 'utf8')
  } catch {
    return ''
  }
}

async function listFiles (root, subdirs, extensionsRegex) {
  const results = []
  for (const sub of subdirs) {
    const base = path.join(root, sub)
    await walk(base, (file) => {
      if (extensionsRegex.test(file)) results.push(file)
    })
  }
  return results
}

async function walk (dir, onFile) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        await walk(full, onFile)
      } else if (e.isFile()) {
        onFile(full)
      }
    }
  } catch {}
}

function buildMentionRegexps (pkgName, methodName) {
  // Prefer code-like patterns to reduce false positives
  const escaped = methodName.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')
  return [
    new RegExp(`\\.${escaped}\\s*\\(`, 'g'), // .method(
    new RegExp(`\n\\s*${escaped}\\s*:\\s*`, 'g'), // method:
    new RegExp(`\n\\s*${escaped}\\s*=`, 'g'), // method =
    new RegExp(`\n\\s*${escaped}\\?\\(`, 'g'), // method?(  (TS optional)
    new RegExp(`${pkgName.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\.${escaped}\\s*\\(`, 'g') // pkg.method(
  ]
}

function pathMultiplier (relativeFilePath) {
  let multiplier = 1
  for (const r of PATH_BOOST.positive) {
    if (r.test(relativeFilePath)) { multiplier *= 1.2 }
  }
  for (const r of PATH_BOOST.negative) {
    if (r.test(relativeFilePath)) { multiplier *= 0.7 }
  }
  return multiplier
}

async function adjustScores (pkgRootDir, pkgName, targets) {
  // Preload corpora
  const readmeFiles = [path.join(pkgRootDir, 'README.md'), path.join(pkgRootDir, 'readme.md')]
  const docsFiles = await listFiles(pkgRootDir, ['docs', 'documentation', 'doc'], /\.(md|markdown|mdx|txt)$/i)
  const exampleFiles = await listFiles(pkgRootDir, ['examples', 'example'], /\.(js|ts|mjs|cjs|md)$/i)
  const testFiles = await listFiles(pkgRootDir, ['test', 'tests', '__tests__'], /\.(js|ts|mjs|cjs)$/i)
  const typeFiles = await listFiles(pkgRootDir, ['.', 'types', 'dist', 'lib'], /\.d\.ts$/i)

  const corpora = {
    readme: await Promise.all(readmeFiles.map(f => safeRead(f))),
    docs: await Promise.all(docsFiles.map(f => safeRead(f))),
    examples: await Promise.all(exampleFiles.map(f => safeRead(f))),
    tests: await Promise.all(testFiles.map(f => safeRead(f))),
    types: await Promise.all(typeFiles.map(f => safeRead(f)))
  }

  for (const t of targets) {
    const method = t.function_name
    const rel = t.file_path || ''
    const regexps = buildMentionRegexps(pkgName || '', method)

    let mentionsWeighted = 0
    for (const [bucket, files] of Object.entries(corpora)) {
      const w = WEIGHTS[bucket] || 1
      let bucketHits = 0
      for (const content of files) {
        if (!content) continue
        for (const re of regexps) {
          const matches = content.match(re)
          if (matches && matches.length) bucketHits += matches.length
        }
      }
      mentionsWeighted += bucketHits * w
    }

    const alpha = 0.15
    const additive = alpha * Math.log1p(mentionsWeighted)
    const pm = pathMultiplier(rel)
    const adjusted = clamp((t.confidence_score || 0) + additive, 0, 1) * pm

    t.confidence_score = clamp(adjusted, 0, 1)
    if (mentionsWeighted > 0) {
      t.reasoning += ` Judge boost: mentions=${mentionsWeighted}, pathMult=${pm.toFixed(2)}.`
    }
  }

  return targets
}

module.exports = { adjustScores }
