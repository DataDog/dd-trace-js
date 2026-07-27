'use strict'

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
const { checkGit, checkGitHub } = require('./helpers/requirements')

const main = 'master'
const releaseLine = params[0]

if (!releaseLine || releaseLine === 'help' || flags.help) {
  log(
    'Usage: node scripts/release/create-release-line <major-version>\n',
    'Examples:',
    '  node scripts/release/create-release-line 6   # creates v6.x',
    '\nOptions:',
    '  -n         Do not push the release line branch upstream.',
    '  -y         Push the release line branch upstream without prompting.',
    '  --debug    Print raw commands and their outputs.',
    '  --help     Show this help.'
  )
  process.exit(0)
} else if (!/^\d+$/.test(releaseLine)) {
  fatal('Invalid major version. Must be a whole number (e.g. 6 for v6.x).')
}

const releaseBranch = `v${releaseLine}.x`
const prevReleaseLine = String(Number(releaseLine) - 1)
const prevReleaseBranch = `v${prevReleaseLine}.x`

try {
  start('Check for requirements')

  checkGit()
  checkGitHub()

  pass()

  start(`Fetch latest ${main}`)

  run(`git fetch origin ${main}`)

  pass()

  start(`Find open release proposal PRs for ${prevReleaseBranch}`)

  // Release proposal PRs for the previous release line have head branches
  // matching v{prev}.*.*-proposal. We look at the previous line because
  // the new release line doesn't have proposals yet.
  const proposalPRsJson = capture(
    'gh pr list --repo DataDog/dd-trace-js --state open --json headRefName,number,title' +
    String.raw` --jq '[.[] | select(.headRefName | test("^v${prevReleaseLine}\\.[0-9]+\\.[0-9]+-proposal$"))]'`
  )

  const proposalPRs = JSON.parse(proposalPRsJson)

  let baseCommit

  if (proposalPRs.length === 0) {
    pass(`none found — using HEAD of ${main}`)

    baseCommit = capture(`git rev-parse origin/${main}`)
  } else {
    const titles = proposalPRs.map(pr => `#${pr.number} ${pr.title}`).join(', ')

    pass(titles)

    start('Resolve base commit before proposal commits on master')

    // Fetch the previous release line so we can compare against master.
    run(`git fetch origin ${prevReleaseBranch}`)

    // Find the oldest master commit not yet reflected in the previous release
    // line (by patch-id matching). Commits cherry-picked to the release line
    // are excluded; those still pending — including the ones in the open
    // proposal — are included. The first (oldest) is where the proposal cycle
    // started on master.
    const firstProposalSha = capture(
      'git log --cherry-pick --right-only --format=%H --reverse' +
      ` origin/${prevReleaseBranch}...origin/${main} | head -1`
    )

    if (firstProposalSha) {
      // Branch the new release line from the parent of the first proposal
      // commit, so it starts before any proposal-cycle work.
      baseCommit = capture(`git rev-parse ${firstProposalSha}^`)

      const shortSha = baseCommit.slice(0, 12)
      const commitMsg = capture(`git log -1 --format=%s ${baseCommit}`)

      pass(`${shortSha} "${commitMsg}"`)
    } else {
      pass(`${prevReleaseBranch} is fully up to date — using HEAD of ${main}`)

      baseCommit = capture(`git rev-parse origin/${main}`)
    }
  }

  start(`Check whether ${releaseBranch} already exists on remote`)

  const remoteRef = capture(`git ls-remote --heads origin ${releaseBranch}`).trim()
  const existsOnRemote = remoteRef !== ''

  if (existsOnRemote) {
    pass('yes — will force-update')
  } else {
    pass('no — will create')
  }

  start(`Set ${releaseBranch} to ${baseCommit.slice(0, 12)}`)

  const currentBranch = capture('git rev-parse --abbrev-ref HEAD')

  // Restore current branch when done.
  process.once('exit', code => {
    if (code !== 0) return
    if (capture('git rev-parse --abbrev-ref HEAD') !== currentBranch) {
      run(`git checkout ${currentBranch}`)
    }
  })

  // Create or reset the local branch to the target commit.
  try {
    run(`git branch ${releaseBranch} ${baseCommit}`)
  } catch {
    run(`git branch -f ${releaseBranch} ${baseCommit}`)
  }

  pass()

  if (flags.n) process.exit(0)
  if (!flags.y) {
    checkpoint(`Push ${releaseBranch} to origin?`)
  }

  start(`Push ${releaseBranch}`)

  // Use -f since we may be updating an existing remote branch.
  run(`git push -f origin ${releaseBranch}`)

  pass()

  log(`\nRelease line branch ${releaseBranch} is now at ${baseCommit.slice(0, 12)}.`)
} catch (e) {
  fail(e)
}
