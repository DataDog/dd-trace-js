'use strict'

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const REPO_ROOT = path.resolve(__dirname, '..')
const DEFAULT_DIR = path.join(REPO_ROOT, 'scripts/.cache/datadog-documentation')
const REMOTE = 'https://github.com/DataDog/documentation.git'

function exists (p) {
  try {
    fs.accessSync(p)
    return true
  } catch {
    return false
  }
}

function runGit (args, cwd) {
  execFileSync('git', args, {
    cwd,
    stdio: 'inherit'
  })
}

function getGitOutput (args, cwd) {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] }).toString('utf8').trim()
}

function ensureDir (dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function main () {
  const targetDir = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_DIR
  ensureDir(path.dirname(targetDir))

  if (!exists(path.join(targetDir, '.git'))) {
    runGit(['clone', '--depth', '1', '--filter=blob:none', '--no-checkout', REMOTE, targetDir], REPO_ROOT)
    runGit(['sparse-checkout', 'init', '--cone'], targetDir)
    // Keep checkout small: config/data/content is where most env var references live.
    runGit(['sparse-checkout', 'set', 'content', 'data', 'config'], targetDir)
    runGit(['checkout', '--force'], targetDir)
  } else {
    runGit(['fetch', '--depth', '1', 'origin', 'master'], targetDir)
    runGit(['checkout', '--force', 'origin/master'], targetDir)
  }

  const sha = getGitOutput(['rev-parse', 'HEAD'], targetDir)
  process.stdout.write(`${targetDir}\n${sha}\n`)
}

if (require.main === module) {
  main()
}
