'use strict'

// TODO: Support major versions.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { capture, checkpoint, exit, fatal, success, run } = require('./helpers/terminal')
const { checkBranchDiff, checkGitHub, checkGit } = require('./helpers/requirements')

checkGit()
checkBranchDiff()

const releaseLine = process.argv[2]

// Validate release line argument.
if (!releaseLine || releaseLine === 'help' || releaseLine === '--help') {
  exit('Usage: node scripts/release/proposal <release-line> [release-type]')
} else if (!releaseLine?.match(/^\d+$/)) {
  fatal('Invalid release line. Must be a whole number.')
}

// Make sure the release branch is up to date to prepare for new proposal.
// The main branch is not automatically pulled to avoid inconsistencies between
// release lines if new commits are added to it during a release.
run(`git checkout v${releaseLine}.x`)
run('git pull --ff-only')

const diffCmd = [
  'branch-diff',
  '--user DataDog',
  '--repo dd-trace-js',
  `--exclude-label=semver-major,dont-land-on-v${releaseLine}.x`
].join(' ')

// Determine the new version and release notes location.
const [, lastMinor, lastPatch] = require('../../package.json').version.split('.').map(Number)
const lineDiff = capture(`${diffCmd} --markdown=true v${releaseLine}.x master`)
const newVersion = lineDiff.includes('SEMVER-MINOR')
  ? `${releaseLine}.${lastMinor + 1}.0`
  : `${releaseLine}.${lastMinor}.${lastPatch + 1}`
const notesDir = path.join(os.tmpdir(), 'release_notes')
const notesFile = path.join(notesDir, `${newVersion}.md`)

// Checkout new or existing branch.
run(`git checkout v${newVersion}-proposal || git checkout -b v${newVersion}-proposal`)

try {
  // Pull latest changes in case the release was started by someone else.
  run(`git remote show origin | grep v${newVersion} && git pull --ff-only`)
} catch (e) {
  // Either there is no remote to pull from or the local and remote branches
  // have diverged. In both cases we ignore the error and will just use our
  // changes.
}

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
    fatal(
      'Cherry-pick failed. Resolve the conflicts and run `git cherry-pick --continue` to continue.',
      'When all conflicts have been resolved, run this script again.'
    )
  }
}

// Update package.json with new version.
run(`npm version --allow-same-version --git-tag-version=false ${newVersion}`)
run(`git commit -uno -m v${newVersion} package.json || exit 0`)

// Write release notes to a file that can be copied to the GitHub release.
fs.mkdirSync(notesDir, { recursive: true })
fs.writeFileSync(notesFile, lineDiff)

success('Release proposal is ready.')
success(`Changelog at ${os.tmpdir()}/release_notes/${newVersion}.md`)

// Stop and ask the user if they want to proceed with pushing everything upstream.
checkpoint('Push the release upstream and create/update PR?')

checkGitHub()

run(`git push -f -u origin v${newVersion}-proposal`)

// Create or edit the PR. This will also automatically output a link to the PR.
try {
  run(`gh pr create -d -B v${releaseLine}.x -t "v${newVersion} proposal" -F ${notesFile}`)
} catch (e) {
  // PR already exists so update instead.
  // TODO: Keep existing non-release-notes PR description if there is one.
  run(`gh pr edit -F "${notesFile}"`)
}

success('Release PR is ready.')
