'use strict'

/**
 * Best-effort provenance report for env vars / option names.
 *
 * - Finds the first appearance anywhere in this repo using `git log -S`.
 * - Extracts commit subject/body and touched paths.
 * - Attempts to resolve PR number from the commit message, and (optionally) fetch PR title/body
 *   unauthenticated from GitHub (rate-limited).
 *
 * Output:
 * - packages/dd-trace/src/config/supported-configurations.provenance-report.json
 */

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const https = require('node:https')
const path = require('node:path')

const DEFAULT_REPO_ROOT = path.resolve(__dirname, '..')
const DEFAULT_REPORT_REL = 'packages/dd-trace/src/config/supported-configurations.provenance-report.json'
const DEFAULT_SUPPORTED_REL = 'packages/dd-trace/src/config/supported-configurations.json'
const DEFAULT_PR_CACHE_REL = 'scripts/.cache/github-pr-cache.json'

const DEFAULT_MAX_PR_FETCH = 25

function readJSON (file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function writeJSON (file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8')
}

function tryReadJSON (file) {
  try {
    return readJSON(file)
  } catch {
    return undefined
  }
}

function git (args, repoRoot) {
  try {
    return execFileSync('git', args, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8')
  } catch (e) {
    const stderr = e && e.stderr ? e.stderr.toString('utf8') : ''
    const message = `git ${args.join(' ')} failed${stderr ? `:\n${stderr}` : ''}`
    const err = new Error(message)
    err.cause = e
    throw err
  }
}

function gitFirstAppearance (needle, repoRoot) {
  // Primary: -S finds commits where the number of occurrences changes (good for "first introduction").
  // In partial clones (`blob:none`), this may trigger a fetch from the promisor remote and fail offline.
  try {
    const out = git([
      'log',
      '--all',
      '--reverse',
      `-S${needle}`,
      '--format=%H%x00%s%x00%b%x00'
    ], repoRoot)
    if (!out) return undefined
    const first = out.split('\n')[0]
    const [sha, subject, body] = first.split('\u0000')
    if (!sha) return undefined
    return { sha, subject: subject || '', body: body || '' }
  } catch (e) {
    const message = String(e && e.message ? e.message : e)

    // Fallback for offline partial clones:
    // - Find files in the current checkout that contain the needle
    // - Return the earliest commit that touched any of those files
    if (message.includes('promisor remote') || message.includes('could not fetch')) {
      try {
        const grep = git(['grep', '-n', needle], repoRoot)
        const files = Array.from(new Set(
          grep.split('\n')
            .map(l => l.split(':')[0])
            .filter(Boolean)
        ))
        if (files.length === 0) {
          return { found: false, error: message, offlinePartialClone: true }
        }
        const out = git([
          'log',
          '--reverse',
          '--format=%H%x00%s%x00%b%x00',
          '--',
          ...files
        ], repoRoot)
        if (!out) return { found: false, error: message, offlinePartialClone: true, files }
        const first = out.split('\n')[0]
        const [sha, subject, body] = first.split('\u0000')
        if (!sha) return { found: false, error: message, offlinePartialClone: true, files }
        return { sha, subject: subject || '', body: body || '', approximate: true, files }
      } catch (fallbackError) {
        return {
          found: false,
          error: message,
          offlinePartialClone: true,
          fallbackError: String(fallbackError && fallbackError.message ? fallbackError.message : fallbackError)
        }
      }
    }

    return { error: message }
  }
}

function gitChangedPaths (sha, repoRoot) {
  const out = git(['show', '--name-only', '--pretty=format:', sha], repoRoot)
  return out.split('\n').map(l => l.trim()).filter(Boolean)
}

function extractPrNumber (subject, body) {
  const text = `${subject}\n${body}`
  const m1 = text.match(/Merge pull request #(\d+)/)
  if (m1) return Number.parseInt(m1[1], 10)
  const m2 = text.match(/\(#(\d+)\)/)
  if (m2) return Number.parseInt(m2[1], 10)
}

function httpsGetJson (url) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'dd-trace-js-config-provenance',
        Accept: 'application/vnd.github+json'
      }
    }, res => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data))
          } catch (e) {
            reject(e)
          }
        } else {
          resolve(undefined)
        }
      })
    })
    req.on('error', reject)
    req.end()
  })
}

async function maybeFetchPr (prNumber, cache, repo, maxFetchState) {
  if (!prNumber) return
  if (cache[prNumber]) return
  if (maxFetchState.remaining <= 0) return
  maxFetchState.remaining--

  const url = `https://api.github.com/repos/${repo}/pulls/${prNumber}`
  const pr = await httpsGetJson(url)
  if (!pr) {
    cache[prNumber] = { error: 'unavailable' }
    return
  }
  cache[prNumber] = { number: prNumber, title: pr.title || '', body: pr.body || '' }
}

function parseArgs () {
  const args = process.argv.slice(2)
  /** @type {{ all: boolean, env: string | undefined, option: string | undefined, fetchPr: boolean, maxPrFetch: number, repoPath: string | undefined }} */
  const out = { all: false, env: undefined, option: undefined, fetchPr: false, maxPrFetch: DEFAULT_MAX_PR_FETCH, repoPath: undefined }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--all') out.all = true
    else if (a === '--env') out.env = args[++i]
    else if (a === '--option') out.option = args[++i]
    else if (a === '--fetch-pr') out.fetchPr = true
    else if (a === '--max-pr-fetch') out.maxPrFetch = Number.parseInt(args[++i], 10)
    else if (a === '--repo-path') out.repoPath = args[++i]
  }
  return out
}

function getRepoPaths (repoRoot) {
  return {
    supportedJsonPath: path.join(repoRoot, DEFAULT_SUPPORTED_REL),
    reportPath: path.join(repoRoot, DEFAULT_REPORT_REL),
    prCachePath: path.join(repoRoot, DEFAULT_PR_CACHE_REL)
  }
}

function getRepoCloneInfo (repoRoot) {
  const info = { repoRoot, isShallow: undefined, promisor: undefined, partialCloneFilter: undefined }
  try {
    const out = git(['rev-parse', '--is-shallow-repository'], repoRoot).trim()
    if (out === 'true' || out === 'false') info.isShallow = out === 'true'
  } catch {}
  try {
    const out = git(['config', '--bool', '--get', 'remote.origin.promisor'], repoRoot).trim()
    if (out === 'true' || out === 'false') info.promisor = out === 'true'
  } catch {}
  try {
    const out = git(['config', '--get', 'remote.origin.partialclonefilter'], repoRoot).trim()
    if (out) info.partialCloneFilter = out
  } catch {}
  return info
}

async function main () {
  const argv = parseArgs()
  const repoRoot = argv.repoPath ? path.resolve(argv.repoPath) : DEFAULT_REPO_ROOT
  const { supportedJsonPath, reportPath, prCachePath } = getRepoPaths(repoRoot)
  const cloneInfo = getRepoCloneInfo(repoRoot)

  const supported = readJSON(supportedJsonPath)
  const supportedConfigurations = supported.supportedConfigurations || {}

  /** @type {string[]} */
  const needles = []
  if (argv.all) {
    needles.push(...Object.keys(supportedConfigurations))
  }
  if (argv.env) needles.push(argv.env)
  if (argv.option) needles.push(argv.option)

  const uniqueNeedles = Array.from(new Set(needles)).filter(Boolean).sort()
  if (uniqueNeedles.length === 0) {
    throw new Error('Provide --all and/or --env DD_FOO and/or --option tracerOptions.path')
  }

  /** @type {Record<string, any>} */
  const prCache = tryReadJSON(prCachePath) || {}
  const maxFetchState = { remaining: Number.isFinite(argv.maxPrFetch) ? argv.maxPrFetch : DEFAULT_MAX_PR_FETCH }

  /** @type {Record<string, any>} */
  const results = {}
  /** @type {Set<number>} */
  const prsToFetch = new Set()

  for (const needle of uniqueNeedles) {
    const first = gitFirstAppearance(needle, repoRoot)
    if (!first) {
      results[needle] = { found: false }
      continue
    }
    if (first.error) {
      results[needle] = { found: false, error: first.error }
      continue
    }

    const prNumber = extractPrNumber(first.subject, first.body)
    if (prNumber) prsToFetch.add(prNumber)

    results[needle] = {
      found: true,
      firstAppearance: {
        sha: first.sha,
        subject: first.subject,
        body: first.body,
        paths: gitChangedPaths(first.sha, repoRoot)
      },
      prNumber
    }
  }

  if (argv.fetchPr) {
    // dd-trace-js repository PR fetches (unauthenticated)
    for (const prNumber of Array.from(prsToFetch).sort((a, b) => a - b)) {
      // eslint-disable-next-line no-await-in-loop
      await maybeFetchPr(prNumber, prCache, 'DataDog/dd-trace-js', maxFetchState)
    }
    writeJSON(prCachePath, prCache)
  }

  const report = {
    supportedVersion: supported.version,
    generatedAt: new Date().toISOString(),
    repo: cloneInfo,
    needleCount: uniqueNeedles.length,
    prFetch: {
      enabled: argv.fetchPr,
      maxPrFetch: argv.maxPrFetch,
      fetched: argv.fetchPr ? Object.keys(prCache).length : 0
    },
    prCache: argv.fetchPr ? prCache : undefined,
    results
  }

  writeJSON(reportPath, report)
  process.stdout.write(`Wrote ${reportPath}\n`)
}

if (require.main === module) {
  main().catch(err => {
    process.stderr.write(String(err && err.stack ? err.stack : err) + '\n')
    process.exitCode = 1
  })
}

