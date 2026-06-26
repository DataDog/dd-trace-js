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

try {
  start('Check for requirements')

  checkGit()
  checkGitHub()

  pass()

  start(`Fetch latest ${main}`)

  run(`git fetch origin ${main}`)

  pass()

  start('Find open release proposal PRs')

  // Release proposal PRs have head branches matching v{major}.*.*-proposal.
  const proposalPRsJson = capture(
    'gh pr list --repo DataDog/dd-trace-js --state open --json headRefName,number,title' +
    String.raw` --jq '[.[] | select(.headRefName | test("^v${releaseLine}\\.[0-9]+\\.[0-9]+-proposal$"))]'`
  )

  const proposalPRs = JSON.parse(proposalPRsJson)

  let baseCommit

  if (proposalPRs.length === 0) {
    pass(`none found — using HEAD of ${main}`)

    baseCommit = capture(`git rev-parse origin/${main}`)
  } else {
    const titles = proposalPRs.map(pr => `#${pr.number} ${pr.title}`).join(', ')

    pass(titles)

    start('Resolve base commit from proposal branches')

    // Fetch all proposal branches so we can compute merge-bases.
    for (const pr of proposalPRs) {
      try {
        run(`git fetch origin ${pr.headRefName}`)
      } catch {
        // Branch may not exist on origin yet; skip it.
      }
    }

    // For each proposal branch, compute its merge-base with master. Then pick
    // the oldest one (the commit with the most subsequent commits on master),
    // which is the last clean commit before the first proposal diverged.
    let oldestCommit = null
    let oldestDistance = -1

    for (const pr of proposalPRs) {
      let mergeBase
      try {
        mergeBase = capture(`git merge-base origin/${main} origin/${pr.headRefName}`)
      } catch {
        continue
      }

      // Count commits on master that come after this merge-base.
      // A larger count means the merge-base is older.
      const distance = Number.parseInt(
        capture(`git rev-list --count ${mergeBase}..origin/${main}`),
        10
      )

      if (distance > oldestDistance) {
        oldestDistance = distance
        oldestCommit = mergeBase
      }
    }

    if (!oldestCommit) {
      fatal('Could not determine a merge-base for any of the proposal branches.')
    }

    baseCommit = oldestCommit

    const shortSha = baseCommit.slice(0, 12)
    const commitMsg = capture(`git log -1 --format=%s ${baseCommit}`)

    pass(`${shortSha} "${commitMsg}"`)
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
