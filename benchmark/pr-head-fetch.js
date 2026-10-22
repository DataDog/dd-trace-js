'use strict'

// Run with `node benchmark/pr-head-fetch.js`. Uses only disposable file:// remotes.
// Clone preparation, validation, and cleanup are excluded from timings. Each variant
// gets a fresh depth-1 merge checkout; the present-head case prefetches two generations.
// The first pass warms up each case, then ten passes rotate variant order.

const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { performance } = require('node:perf_hooks')
const { pathToFileURL } = require('node:url')

process.env.DD_EXPERIMENTAL_TEST_OPT_GIT_CACHE_ENABLED = 'false'
const { fetchHeadCommitSha, getGitRemoteName } = require('../packages/dd-trace/src/plugins/util/git')

const commits = 2000
const samples = 10
const originalDirectory = process.cwd()
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-trace-pr-head-bench-'))
const remote = path.join(directory, 'remote.git')
const checkout = path.join(directory, 'checkout')

/**
 * @param {string} cwd
 * @param {string[]} flags
 * @param {import('node:child_process').ExecFileSyncOptions} [options]
 */
function git (cwd, flags, options = {}) {
  return execFileSync('git', flags, { ...options, cwd, stdio: 'pipe' }).toString().trim()
}

/** @param {boolean} bounded */
function fetch (bounded) {
  const remoteName = getGitRemoteName()
  git(checkout, [
    'fetch',
    ...(bounded ? ['--depth=1', '--no-tags'] : []),
    '--update-shallow', '--filter=blob:none', '--recurse-submodules=no', '--no-write-fetch-head',
    remoteName, headSha,
  ])
}

/** @param {number[]} values */
function median (values) {
  const sorted = values.slice().sort((a, b) => a - b)
  return (sorted[(sorted.length - 1) >> 1] + sorted[sorted.length >> 1]) / 2
}

let headSha
const variants = [
  { name: 'unbounded-fetch', run: () => fetch(false) },
  { name: 'bounded-fetch-only', run: () => fetch(true) },
  { name: 'local-first', run: () => fetchHeadCommitSha(headSha) },
]
const results = []

try {
  git(directory, ['init', '--bare', remote])
  git(remote, ['config', 'uploadpack.allowFilter', 'true'])
  let input = ''
  for (let i = 1; i <= commits; i++) {
    const message = `commit ${i}`
    const content = `${i}`
    input += `commit refs/heads/juan-fernandez/head
mark :${i}
committer Benchmark <benchmark@example.com> ${1700000000 + i} +0000
data ${message.length}
${message}
${i > 1 ? `from :${i - 1}\n` : ''}M 100644 inline history.txt
data ${content.length}
${content}

`
  }
  input += `commit refs/heads/juan-fernandez/merge
mark :${commits + 1}
committer Benchmark <benchmark@example.com> 1700003000 +0000
data 4
base
from :1

commit refs/heads/juan-fernandez/merge
committer Benchmark <benchmark@example.com> 1700003001 +0000
data 5
merge
from :${commits + 1}
merge :${commits}

done
`
  git(remote, ['fast-import', '--quiet'], { input })
  headSha = git(remote, ['rev-parse', 'refs/heads/juan-fernandez/head'])
  const expectedMetadata = git(remote, ['show', '-s', '--format=%H%n%an%n%ae%n%aI%n%cn%n%ce%n%cI%n%B', headSha])

  for (const partial of [false, true]) {
    for (const present of [false, true]) {
      const timings = variants.map(() => [])
      const histories = variants.map(() => 0)
      for (let sample = -1; sample < samples; sample++) {
        for (let offset = 0; offset < variants.length; offset++) {
          const index = (sample + 1 + offset) % variants.length
          const variant = variants[index]
          git(directory, [
            'clone', '--depth=1', '--no-checkout', '--branch', 'juan-fernandez/merge',
            ...(partial ? ['--filter=blob:none'] : []), pathToFileURL(remote).href, checkout,
          ])
          if (present) git(checkout, ['fetch', '--depth=2', '--filter=blob:none', 'origin', headSha])
          process.chdir(checkout)
          const start = performance.now()
          variant.run()
          const elapsed = performance.now() - start
          process.chdir(originalDirectory)
          assert.strictEqual(
            git(checkout, ['show', '-s', '--format=%H%n%an%n%ae%n%aI%n%cn%n%ce%n%cI%n%B', headSha]),
            expectedMetadata
          )
          const history = Number(git(checkout, ['rev-list', '--count', headSha]))
          const expectedHistory = variant.name === 'unbounded-fetch'
            ? (present ? 2 : commits)
            : variant.name === 'local-first' && present ? 2 : 1
          assert.strictEqual(history, expectedHistory)
          if (sample >= 0) timings[index].push(elapsed)
          histories[index] = history
          fs.rmSync(checkout, { recursive: true, force: true })
        }
      }
      for (const [index, variant] of variants.entries()) {
        results.push({
          clone: partial ? 'partial' : 'regular',
          head: present ? 'present' : 'missing',
          variant: variant.name,
          medianMs: Number(median(timings[index]).toFixed(3)),
          headHistoryCommits: histories[index],
          samplesMs: timings[index].map(value => Number(value.toFixed(3))),
        })
      }
    }
  }
  process.stdout.write(JSON.stringify({
    node: process.version,
    git: git(remote, ['--version']),
    platform: `${process.platform}/${process.arch}`,
    commits,
    samples,
    results,
  }, null, 2) + '\n')
} finally {
  process.chdir(originalDirectory)
  fs.rmSync(directory, { recursive: true, force: true })
}
