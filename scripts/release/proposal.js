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
const { checkAll } = require('./helpers/requirements')

const tmpdir = process.env.RUNNER_TEMP || os.tmpdir()
const main = 'master'
const releaseLine = params[0]

// Validate release line argument.
if (!releaseLine || releaseLine === 'help' || flags.help) {
  log(
    'Usage: node scripts/release/proposal <release-line>\n',
    'Options:',
    '  -f         Push new changes even if a non-draft PR already exists.',
    '  -n         Do not push release proposal upstream.',
    '  -y         Push release proposal upstream.',
    '  --debug    Print raw commands and their outputs.',
    '  --help     Show this help.'
  )
  process.exit(0)
} else if (!releaseLine?.match(/^\d+$/)) {
  fatal('Invalid release line. Must be a whole number.')
}

try {
  start('Check for requirements')

  checkAll()

  pass()

  start('Pull release branch')

  const currentBranch = capture('git rev-parse --abbrev-ref HEAD')

  // Restore current branch on success.
  process.once('exit', code => {
    if (code !== 0) return

    run(`git checkout ${currentBranch}`)
  })

  // Make sure the release branch is up to date to prepare for new proposal.
  // The main branch is not automatically pulled to avoid inconsistencies between
  // release lines if new commits are added to it during a release.
  run(`git checkout ${main}`)
  run(`git checkout --quiet v${releaseLine}.x`)
  run('git pull --quiet --ff-only')

  pass(`v${releaseLine}.x`)

  // Semver-major changes are behind version conditionals so we can include them
  // in minors.
  const diffCmd = `branch-diff --user DataDog --repo dd-trace-js --exclude-label=dont-land-on-v${releaseLine}.x`

  start('Determine version increment')

  const { DD_MAJOR, DD_MINOR, DD_PATCH } = require('../../version')
  const lineDiffWithMajor = capture(`${diffCmd} --markdown=true v${releaseLine}.x ${main}`)

  if (!lineDiffWithMajor) {
    pass('none (already up to date)')
    process.exit(0)
  }

  // For release notes we want to exclude major changes as they will be go in
  // the release notes of the next major instead.
  const lineDiff = capture(
    `${diffCmd} --exclude-label=semver-major,dont-land-on-v${releaseLine}.x --markdown=true v${releaseLine}.x ${main}`
  )

  const isMinor = lineDiff.includes('SEMVER-MINOR')
  const bump = isMinor ? 'minor' : 'patch'

  if (!lineDiff) {
    pass(`none (major changes cannot be released alone in a ${bump})`)
    process.exit(0)
  }

  const newPatch = `${releaseLine}.${DD_MINOR}.${DD_PATCH + 1}`
  const newMinor = `${releaseLine}.${DD_MINOR + 1}.0`
  const newVersion = isMinor ? newMinor : newPatch
  const notesDir = path.join(tmpdir, 'release_notes')
  const notesFile = path.join(notesDir, `v${newVersion}.md`)

  pass(`${bump} (${DD_MAJOR}.${DD_MINOR}.${DD_PATCH} -> ${newVersion})`)

  start('Checkout release proposal branch')

  // Checkout new or existing branch.
  run(`git checkout --quiet v${newVersion}-proposal || git checkout --quiet -b v${newVersion}-proposal`)

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
  const lastCommit = capture('git log -1 --pretty=%B')
  const proposalDiff = capture(`${diffCmd} --format=sha --reverse v${newVersion}-proposal ${main}`)
    .replace(/\n/g, ' ').trim()

  if (proposalDiff) {
    // Get new changes since last commit of the proposal branch.
    const newChanges = capture(`${diffCmd} v${newVersion}-proposal ${main}`)

    pass(`\n${newChanges}`)

    start('Apply changes from the main branch')

    // We have new commits to add, so revert the version commit if it exists.
    if (lastCommit === `v${newVersion}`) {
      run('git reset --hard HEAD~1')
    }

    // Cherry pick all new commits to the proposal branch.
    try {
      run(`git cherry-pick ${proposalDiff}`)

      pass()
    } catch (err) {
      run('git cherry-pick --abort')

      fatal(
        'Cherry-pick failed. This means that the release branch has deviated from the main branch.',
        'Please make sure the release branch contains all changes from the main branch.'
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

  if (flags.n) process.exit(0)
  if (!flags.y) {
    // Stop and ask the user if they want to proceed with pushing everything upstream.
    checkpoint('Push the release upstream and create/update PR?')
  }

  start('Checking that no ready to merge PR exists')

  let previousPullRequest

  if (isMinor) {
    try {
      previousPullRequest = JSON.parse(capture(`gh pr view ${newMinor} --json isDraft,url`))
    } catch (e) {
      // No existing PR for minor release proposal.
    }
  }

  if (!previousPullRequest) {
    try {
      previousPullRequest = JSON.parse(capture(`gh pr view ${newPatch} --json isDraft,url`))
    } catch (e) {
      // No existing PR for patch release proposal.
    }
  }

  if (previousPullRequest) {
    if (!previousPullRequest.isDraft && !flags.f) {
      if (flags.f) {
        pass(`ready: ${previousPullRequest.url} (ignoring because of -f flag)`)
      } else {
        pass(`ready: ${previousPullRequest.url} (use -f to ignore and force update)`)

        process.exit(0)
      }
    }

    pass(`draft: ${previousPullRequest.url}`)
  } else {
    pass('none')
  }

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

  const pullRequest = JSON.parse(capture('gh pr view --json number,url'))

  // Close PR and delete branch for any patch proposal if new proposal is minor.
  if (isMinor) {
    try {
      run(`gh pr close v${newPatch}-proposal --delete-branch --comment "Superseded by #${pullRequest.number}."`)
    } catch (e) {
      // PR didn't exist so nothing to close.
    }
  }

  pass(pullRequest.url)

  if (process.env.CI) {
    log(`\n\n::notice::${newVersion}: ${pullRequest.url}`)
  }
} catch (e) {
  fail(e)
}
