'use strict'

// TODO: Deduplicate any code that is also in proposal.js

const { randomUUID } = require('crypto')
const {
  capture,
  fail,
  fatal,
  flags,
  log,
  params,
  pass,
  start,
  run
} = require('./helpers/terminal')
const { checkAll } = require('./helpers/requirements')

const main = 'master'

if (params[0] === 'help' || flags.help) {
  log(
    'Usage: node scripts/release/validate [release-proposal]\n',
    'Options:',
    '  --debug    Print raw commands and their outputs.',
    '  --help     Show this help.'
  )
  process.exit(0)
}

try {
  start('Check for requirements')

  checkAll()

  pass()

  start('Pull release branch')

  const currentBranch = capture('git rev-parse --abbrev-ref HEAD')
  const proposalBranch = params[0] || currentBranch
  const tempBranch = randomUUID()
  const newVersion = proposalBranch.match(/^v([0-9]+\.[0-9]+\.[0-9]+).+/)[1]
  const releaseLine = newVersion.match(/^([0-9]+).+/)[1]

  // Restore current branch on success.
  process.once('exit', code => {
    if (code === 0) {
      run(`git checkout ${currentBranch}`)
    }

    run(`git branch -D ${tempBranch}`)
  })

  run(`git checkout ${main}`)
  run(`git checkout --quiet v${releaseLine}.x`)
  run('git pull --quiet --ff-only')

  pass()

  const diffCmd = 'branch-diff --user DataDog --repo dd-trace-js --exclude-label=semver-major'

  start('Validate differences between proposal and main branch.')

  const proposalCommits = capture(
    `git --no-pager log --pretty=format:"%H" v${releaseLine}.x..${proposalBranch}`
  ).split('\n')

  run(`git checkout -b ${tempBranch}`)

  const versionCommit = proposalCommits[0]
  const tempCommits = capture(`${diffCmd} --format=sha --reverse v${releaseLine}.x ${main}`)
    .split('\n')
    .slice(0, proposalCommits.length - 1)
    .join(' ')

  run(`git cherry-pick ${tempCommits} ${versionCommit}`)

  const diff = capture(`git --no-pager diff ${proposalBranch}..${tempBranch}`)

  if (diff.length > 0) {
    fatal(`Validation failed as differences were found between the release proposal branch and ${main}.`)
  }

  pass('none')
} catch (e) {
  fail(e)
}
