'use strict'

/* eslint-disable no-console */

// TODO: Support major versions.

const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

// Helpers for colored output.
const log = msg => console.log(msg)
const success = msg => console.log(`\x1b[32m${msg}\x1b[0m`)
const error = msg => console.log(`\x1b[31m${msg}\x1b[0m`)
const whisper = msg => console.log(`\x1b[90m${msg}\x1b[0m`)

const currentBranch = capture('git rev-parse --abbrev-ref HEAD')
const releaseLine = process.argv[2]

// Validate release line argument.
if (!releaseLine || releaseLine === 'help' || releaseLine === '--help') {
  log('Usage: node scripts/release/prepare <release-line> [release-type]')
  process.exit(0)
} else if (!releaseLine?.match(/^\d+$/)) {
  error('Invalid release line. Must be a whole number.')
  process.exit(1)
}

// Make sure the release branch is up to date to prepare for new proposal.
// The main branch is not automatically pulled to avoid inconsistencies between
// release lines if new commits are added to it during a release.
run(`git checkout v${releaseLine}.x`)
run('git pull')

const diffCmd = [
  'branch-diff',
  '--user DataDog',
  '--repo dd-trace-js',
  isActivePatch()
    ? `--exclude-label=semver-major,semver-minor,dont-land-on-v${releaseLine}.x`
    : `--exclude-label=semver-major,dont-land-on-v${releaseLine}.x`
].join(' ')

// Determine the new version.
const [lastMajor, lastMinor, lastPatch] = require('../../package.json').version.split('.').map(Number)
const lineDiff = capture(`${diffCmd} v${releaseLine}.x master`)
const newVersion = lineDiff.includes('SEMVER-MINOR')
  ? `${releaseLine}.${lastMinor + 1}.${lastPatch}`
  : `${releaseLine}.${lastMinor}.${lastPatch + 1}`

// Checkout new branch and output new changes.
run(`git checkout v${newVersion}-proposal || git checkout -b v${newVersion}-proposal`)

// Get the hashes of the last version and the commits to add.
const lastCommit = capture('git log -1 --pretty=%B').trim()
const proposalDiff = capture(`${diffCmd} --format=sha --reverse v${newVersion}-proposal master`)
  .replace(/\n/g, ' ').trim()

if (proposalDiff) {
  // We have new commits to add, so revert the version commit if it exists.
  if (lastCommit === `v${newVersion}`) {
    run('git reset --hard HEAD~1')
  }

  // Output new changes since last commit of the proposal branch.
  run(`${diffCmd} v${newVersion}-proposal master`)

  // Cherry pick all new commits to the proposal branch.
  try {
    run(`echo "${proposalDiff}" | xargs git cherry-pick`)
  } catch (err) {
    error('Cherry-pick failed. Resolve the conflicts and run `git cherry-pick --continue` to continue.')
    error('When all conflicts have been resolved, run this script again.')
    process.exit(1)
  }
}

// Update package.json with new version.
run(`yarn version --no-git-tag-version --new-version ${newVersion}`)
run(`git commit -uno -m v${newVersion} package.json || exit 0`)

ready()

// Check if current branch is already an active patch proposal branch to avoid
// creating a new minor proposal branch if new minor commits are added to the
// main branch during a existing patch release.
function isActivePatch () {
  const currentMatch = currentBranch.match(/^(\d+)\.(\d+)\.(\d+)-proposal$/)

  if (currentMatch) {
    const [major, minor, patch] = currentMatch.slice(1).map(Number)

    if (major === lastMajor && minor === lastMinor && patch > lastPatch) {
      return true
    }
  }

  return false
}

// Output a command to the terminal and execute it.
function run (cmd) {
  whisper(`> ${cmd}`)

  const output = execSync(cmd, {}).toString()

  log(output)
}

// Run a command and capture its output to return it to the caller.
function capture (cmd) {
  return execSync(cmd, {}).toString()
}

// Write release notes to a file that can be copied to the GitHub release.
function ready () {
  const notesDir = path.join(__dirname, '..', '..', '.github', 'notes')
  const notesFile = path.join(notesDir, `${newVersion}.md`)
  const lineDiff = capture(`${diffCmd} --markdown=true v${releaseLine}.x master`)

  fs.mkdirSync(notesDir, { recursive: true })
  fs.writeFileSync(notesFile, lineDiff)

  success('Release proposal is ready.')
  success(`Changelog at .github/notes/${newVersion}.md`)

  process.exit(0)
}
