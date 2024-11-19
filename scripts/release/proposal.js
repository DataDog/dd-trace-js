'use strict'

// TODO: Support major versions.

const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  capture,
  checkpoint,
  fail,
  fatal,
  flags,
  log,
  params,
  pass,
  start,
  run
} = require('./helpers/terminal')
const { checkBranchDiff, checkGitHub, checkGit } = require('./helpers/requirements')

const releaseLine = params[0]

// Validate release line argument.
if (!releaseLine || releaseLine === 'help' || flags.help) {
  log(
    'Usage: node scripts/release/proposal <release-line>\n',
    'Options:',
    '  --debug    Print raw commands and their outputs.',
    '  --help     Show this help.',
    '  --minor    Force a minor release.',
    '  --patch    Force a patch release.'
  )
  process.exit(0)
} else if (!releaseLine?.match(/^\d+$/)) {
  fatal('Invalid release line. Must be a whole number.')
}

try {
  start('Check for requirements')

  checkGit()
  checkBranchDiff()
  checkGitHub()

  pass()

  start('Pull release branch')

  // Make sure the release branch is up to date to prepare for new proposal.
  // The main branch is not automatically pulled to avoid inconsistencies between
  // release lines if new commits are added to it during a release.
  run(`git checkout v${releaseLine}.x`)
  run('git pull --ff-only')

  pass(`v${releaseLine}.x`)

  const diffCmd = [
    'branch-diff',
    '--user DataDog',
    '--repo dd-trace-js',
  `--exclude-label=semver-major,dont-land-on-v${releaseLine}.x`
  ].join(' ')

  start('Determine version increment')

  const lastVersion = require('../../package.json').version
  const [, lastMinor, lastPatch] = lastVersion.split('.').map(Number)
  const lineDiff = capture(`${diffCmd} --markdown=true v${releaseLine}.x master`)
  const isMinor = flags.minor || (!flags.patch && lineDiff.includes('SEMVER-MINOR'))
  const newVersion = isMinor
    ? `${releaseLine}.${lastMinor + 1}.0`
    : `${releaseLine}.${lastMinor}.${lastPatch + 1}`
  const notesDir = path.join(os.tmpdir(), 'release_notes')
  const notesFile = path.join(notesDir, `${newVersion}.md`)

  pass(`${isMinor ? 'minor' : 'patch'} (${lastVersion} -> ${newVersion})`)

  start('Checkout release proposal branch')

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

  pass(`v${newVersion}-proposal`)

  start('Check for new changes')

  // Get the hashes of the last version and the commits to add.
  const lastCommit = capture('git log -1 --pretty=%B').trim()
  const proposalDiff = capture(`${diffCmd} --format=sha --reverse v${newVersion}-proposal master`)
    .replace(/\n/g, ' ').trim()

  if (proposalDiff) {
    // Get new changes since last commit of the proposal branch.
    const newChanges = capture(`${diffCmd} v${newVersion}-proposal master`)

    pass(`\n${newChanges}`)

    start('Apply changes from the main branch')

    // We have new commits to add, so revert the version commit if it exists.
    if (lastCommit === `v${newVersion}`) {
      run('git reset --hard HEAD~1')
    }

    // Cherry pick all new commits to the proposal branch.
    try {
      run(`echo "${proposalDiff}" | xargs git cherry-pick`)

      pass()
    } catch (err) {
      fatal(
        'Cherry-pick failed. Resolve the conflicts and run `git cherry-pick --continue` to continue.',
        'When all conflicts have been resolved, run this script again.'
      )
    }
  } else {
    pass('none')
  }

  // Update package.json with new version.
  run(`npm version --allow-same-version --git-tag-version=false ${newVersion}`)
  run(`git commit -uno -m v${newVersion} package.json || exit 0`)

  start('Save release notes draft')

  // Write release notes to a file that can be copied to the GitHub release.
  fs.mkdirSync(notesDir, { recursive: true })
  fs.writeFileSync(notesFile, lineDiff)

  pass(notesFile)

  // Stop and ask the user if they want to proceed with pushing everything upstream.
  checkpoint('Push the release upstream and create/update PR?')

  start('Push proposal upstream')

  run(`git push -f -u origin v${newVersion}-proposal`)

  // Create or edit the PR. This will also automatically output a link to the PR.
  try {
    run(`gh pr create -d -B v${releaseLine}.x -t "v${newVersion} proposal" -F ${notesFile}`)
  } catch (e) {
    // PR already exists so update instead.
    // TODO: Keep existing non-release-notes PR description if there is one.
    run(`gh pr edit -F "${notesFile}"`)
  }

  const pullRequestUrl = capture('gh pr view --json url --jq=".url"')

  pass(pullRequestUrl)
} catch (e) {
  fail(e)
}
