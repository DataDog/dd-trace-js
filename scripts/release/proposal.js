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
  run,
} = require('./helpers/terminal')
const { createReleaseChangelog } = require('./changelog')
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

  const { DD_MAJOR, DD_MINOR, DD_PATCH, VERSION } = require('../../version')
  const stableVersion = `${DD_MAJOR}.${DD_MINOR}.${DD_PATCH}`
  const isPreRelease = VERSION !== stableVersion

  // Notes exclude semver-major (gated behind a flag, not user-visible).
  // Cherry-pick includes semver-major; only only-land-on-next is fully excluded,
  // except when promoting a pre-release to stable (that's what "next" means).
  const notesDiffCmd = 'branch-diff --user DataDog --repo dd-trace-js' +
    (isPreRelease ? '' : ' --exclude-label=semver-major --exclude-label=only-land-on-next')
  const cherryPickDiffCmd = 'branch-diff --user DataDog --repo dd-trace-js' +
    (isPreRelease ? '' : ' --exclude-label=only-land-on-next')

  start('Determine version increment')

  // GitHub rebase limit is 100 commits; reserve one slot for the version bump.
  const MAX_CHERRY_PICKS = 99

  // Get all applicable commits from the release branch to main.
  // Used to derive the capped upper bound before checking out any branch,
  // avoiding a circular dependency between isMinor and the proposal branch state.
  const allMainShas = capture(`${cherryPickDiffCmd} --format=sha --reverse v${releaseLine}.x ${main}`)
    .split('\n').filter(Boolean)

  // The upper bound is the last main SHA that will fit in the proposal across all
  // runs. It equals allMainShas[min(length, MAX_CHERRY_PICKS) - 1] regardless of
  // how many commits are already on the branch (proven by:
  // existingCherryPicked + shasToApply.length = min(allMainShas.length, MAX_CHERRY_PICKS)).
  const upperBoundSha = allMainShas.at(Math.min(allMainShas.length, MAX_CHERRY_PICKS) - 1)

  if (!upperBoundSha) {
    pass('none (already up to date)')
    process.exit(0)
  }

  // Expand to full SHA to avoid minimist scientific notation coercion in branch-diff.
  // Abbreviated SHAs like "980e663509" match JS float syntax and become Infinity.
  const upperBoundRef = capture(`git rev-parse ${upperBoundSha}`)

  // notesShas is scoped to upperBoundSha so isMinor and release notes only reflect
  // the capped commits actually included in the proposal, not deferred ones.
  // Excludes semver-major (gated behind a flag, not user-visible).
  const notesShas = capture(`${notesDiffCmd} --format=sha --reverse v${releaseLine}.x ${upperBoundRef}`)
    .split('\n').filter(Boolean)
  const contributorBySha = getContributorsBySha(`v${releaseLine}.x`, upperBoundSha)
  const notesEntries = []
  for (const sha of notesShas) {
    notesEntries.push({
      sha,
      subject: capture(`git show -s --format=%s ${sha}`),
      author: contributorBySha.get(sha),
    })
  }
  const notes = createReleaseChangelog(notesEntries)
  const isMinor = notes.isMinor
  const newPatch = `${releaseLine}.${DD_MINOR}.${DD_PATCH + 1}`
  const newMinor = `${releaseLine}.${DD_MINOR + 1}.0`
  const newVersion = isPreRelease ? stableVersion : (isMinor ? newMinor : newPatch)
  const notesDir = path.join(tmpdir, 'release_notes')
  const notesFile = path.join(notesDir, `v${newVersion}.md`)

  const incrementType = isPreRelease ? 'release' : (isMinor ? 'minor' : 'patch')
  pass(`${incrementType} (${VERSION} -> ${newVersion})`)

  start('Checkout release proposal branch')

  // Checkout new or existing branch.
  run(`git checkout --quiet v${newVersion}-proposal || git checkout --quiet -b v${newVersion}-proposal`)

  try {
    // Pull latest changes in case the release was started by someone else.
    run(`git remote show origin | grep v${newVersion} && git pull --ff-only`)
  } catch {
    // Either there is no remote to pull from or the local and remote branches
    // have diverged. In both cases we ignore the error and will just use our
    // changes.
  }

  pass(`v${newVersion}-proposal`)

  start('Check for new changes')

  // Get the hashes of the last version and the commits to add.
  const lastCommit = capture('git log -1 --pretty=%B')
  const branchCommitCount = Number.parseInt(capture(`git rev-list --count v${releaseLine}.x..HEAD`), 10)
  const existingCherryPicked = lastCommit === `v${newVersion}` ? branchCommitCount - 1 : branchCommitCount
  const proposalShas = allMainShas.slice(existingCherryPicked)
  const shasToApply = proposalShas.slice(0, Math.max(0, MAX_CHERRY_PICKS - existingCherryPicked))
  const truncated = shasToApply.length < proposalShas.length
  const totalCommits = existingCherryPicked + shasToApply.length + 1

  if (shasToApply.length > 0) {
    // Show only commits being applied; upperBoundSha is the last main SHA that fits.
    const newChanges = capture(`${cherryPickDiffCmd} v${newVersion}-proposal ${upperBoundRef}`)
    const truncationNote = truncated
      ? `\n\n⚠️  Applying ${shasToApply.length} of ${proposalShas.length} available commits` +
        ` (GitHub limit: ${MAX_CHERRY_PICKS}). Remaining commits require a separate release.`
      : ''

    pass(`\n${newChanges}${truncationNote}`)

    start('Apply changes from the main branch')

    // We have new commits to add, so revert the version commit if it exists.
    if (lastCommit === `v${newVersion}`) {
      run('git reset --hard HEAD~1')
    }

    // Cherry pick commits up to the GitHub rebase limit.
    try {
      run(`git cherry-pick ${shasToApply.join(' ')}`)

      pass()
    } catch {
      run('git cherry-pick --abort')

      fatal(
        'Cherry-pick failed. This means that the release branch has deviated from the main branch.',
        'Please make sure the release branch contains all changes from the main branch.'
      )
    }
  } else if (proposalShas.length > 0) {
    pass(`⚠️  Proposal is at the commit limit (${MAX_CHERRY_PICKS}/${MAX_CHERRY_PICKS}).` +
      ` ${proposalShas.length} new commit(s) require a separate release.`)
  } else {
    pass('none')
  }

  // Update package.json with new version.
  run(`npm version --allow-same-version --git-tag-version=false ${newVersion}`)
  run(`git commit -uno -m v${newVersion} package.json || exit 0`)

  start('Save release notes draft')

  fs.mkdirSync(notesDir, { recursive: true })
  fs.writeFileSync(notesFile, notes.markdown)

  pass(notesFile)

  for (const warning of notes.warnings) {
    log(`Warning: ${warning}`)
  }

  if (flags.n) process.exit(0)
  if (!flags.y) {
    // Stop and ask the user if they want to proceed with pushing everything upstream.
    checkpoint('Push the release upstream and create/update PR?')
  }

  start('Checking that no ready to merge PR exists')

  let previousPullRequest

  if (isPreRelease) {
    try {
      previousPullRequest = JSON.parse(capture(`gh pr view ${newVersion} --json isDraft,url`))
    } catch {
      // No existing PR for release proposal.
    }
  } else {
    if (isMinor) {
      try {
        previousPullRequest = JSON.parse(capture(`gh pr view ${newMinor} --json isDraft,url`))
      } catch {
        // No existing PR for minor release proposal.
      }
    }

    if (!previousPullRequest) {
      try {
        previousPullRequest = JSON.parse(capture(`gh pr view ${newPatch} --json isDraft,url`))
      } catch {
        // No existing PR for patch release proposal.
      }
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
  } catch {
    // PR already exists so update instead.
    // TODO: Keep existing non-release-notes PR description if there is one.
    run(`gh pr edit -F "${notesFile}"`)
  }

  const pullRequest = JSON.parse(capture('gh pr view --json number,url'))

  // Close PR and delete branch for any patch proposal if new proposal is minor.
  if (!isPreRelease && isMinor) {
    try {
      run(`gh pr close v${newPatch}-proposal --delete-branch --comment "Superseded by #${pullRequest.number}."`)
    } catch {
      // PR didn't exist so nothing to close.
    }
  }

  pass(pullRequest.url)

  if (process.env.CI) {
    log(`\n\n::notice::${newVersion}: ${pullRequest.url}`)
  }

  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, [
      `commit_count=${totalCommits}`,
      `version=v${newVersion}`,
      `pr_url=${pullRequest.url}`,
    ].join('\n') + '\n')
  }
} catch (e) {
  fail(e)
}

/**
 * Map each release commit SHA to its GitHub contributor handle (`@login`), or
 * the git author name when the commit author is not a GitHub user. Bot accounts
 * (dependabot, github-actions) are skipped so the Contributors list stays human.
 *
 * @param {string} base Release branch the proposal lands on, e.g. `v5.x`.
 * @param {string} head Upper-bound commit the proposal is capped at.
 */
function getContributorsBySha (base, head) {
  const contributors = new Map()
  const jq = '.commits[] | [.sha, (.author.login // ""), (.author.type // ""), .commit.author.name] | @tsv'

  let output
  try {
    output = capture(`gh api "repos/DataDog/dd-trace-js/compare/${base}...${head}" --paginate --jq '${jq}'`)
  } catch {
    log('Warning: unable to fetch contributors from GitHub; skipping the Contributors section.')
    return contributors
  }

  for (const line of output.split('\n')) {
    if (!line) continue
    const [sha, login, type, name] = line.split('\t')
    if (type === 'Bot') continue
    contributors.set(sha, login ? `@${login}` : name)
  }

  return contributors
}
