'use strict'

const os = require('os')
const path = require('path')
const fs = require('fs')
const cp = require('child_process')

const log = require('../../log')
const {
  GIT_COMMIT_SHA,
  GIT_BRANCH,
  GIT_REPOSITORY_URL,
  GIT_TAG,
  GIT_COMMIT_MESSAGE,
  GIT_COMMIT_COMMITTER_DATE,
  GIT_COMMIT_COMMITTER_EMAIL,
  GIT_COMMIT_COMMITTER_NAME,
  GIT_COMMIT_AUTHOR_DATE,
  GIT_COMMIT_AUTHOR_EMAIL,
  GIT_COMMIT_AUTHOR_NAME,
  CI_WORKSPACE_PATH,
  GIT_COMMIT_HEAD_AUTHOR_DATE,
  GIT_COMMIT_HEAD_AUTHOR_EMAIL,
  GIT_COMMIT_HEAD_AUTHOR_NAME,
  GIT_COMMIT_HEAD_COMMITTER_DATE,
  GIT_COMMIT_HEAD_COMMITTER_EMAIL,
  GIT_COMMIT_HEAD_COMMITTER_NAME,
  GIT_COMMIT_HEAD_MESSAGE
} = require('./tags')
const {
  incrementCountMetric,
  distributionMetric,
  TELEMETRY_GIT_COMMAND,
  TELEMETRY_GIT_COMMAND_MS,
  TELEMETRY_GIT_COMMAND_ERRORS
} = require('../../ci-visibility/telemetry')
const { filterSensitiveInfoFromRepository } = require('./url')
const { storage } = require('../../../../datadog-core')
const { cachedExec } = require('./git-cache')

const GIT_REV_LIST_MAX_BUFFER = 12 * 1024 * 1024 // 12MB

function sanitizedExec (
  cmd,
  flags,
  operationMetric,
  durationMetric,
  errorMetric,
  shouldTrim = true
) {
  const store = storage('legacy').getStore()
  storage('legacy').enterWith({ noop: true })

  let startTime
  if (operationMetric) {
    incrementCountMetric(operationMetric.name, operationMetric.tags)
  }
  if (durationMetric) {
    startTime = Date.now()
  }
  try {
    if (flags.includes('merge-base')) {
      console.log('calling cachedExec', cmd, flags)
    }
    let result = cachedExec(cmd, flags, { stdio: 'pipe' }).toString()

    if (shouldTrim) {
      result = result.replaceAll(/(\r\n|\n|\r)/gm, '')
    }

    if (durationMetric) {
      distributionMetric(durationMetric.name, durationMetric.tags, Date.now() - startTime)
    }
    return result
  } catch (err) {
    if (flags.includes('--shallow-since')) {
      console.log('failed cachedExec', err)
    }
    if (errorMetric) {
      incrementCountMetric(errorMetric.name, {
        ...errorMetric.tags,
        errorType: err.code,
        exitCode: err.status || err.errno
      })
    }
    log.error('Git plugin error executing command', err)
    return ''
  } finally {
    storage('legacy').enterWith(store)
  }
}

function isDirectory (path) {
  try {
    const stats = fs.statSync(path)
    return stats.isDirectory()
  } catch {
    return false
  }
}

function isGitAvailable () {
  const isWindows = os.platform() === 'win32'
  const command = isWindows ? 'where' : 'which'
  try {
    cachedExec(command, ['git'])
    return true
  } catch {
    incrementCountMetric(TELEMETRY_GIT_COMMAND_ERRORS, { command: 'check_git', exitCode: 'missing' })
    return false
  }
}

function isShallowRepository () {
  return sanitizedExec(
    'git',
    ['rev-parse', '--is-shallow-repository'],
    { name: TELEMETRY_GIT_COMMAND, tags: { command: 'check_shallow' } },
    { name: TELEMETRY_GIT_COMMAND_MS, tags: { command: 'check_shallow' } },
    { name: TELEMETRY_GIT_COMMAND_ERRORS, tags: { command: 'check_shallow' } }
  ) === 'true'
}

function getGitVersion () {
  const gitVersionString = sanitizedExec('git', ['version'])
  const gitVersionMatches = gitVersionString.match(/git version (\d+)\.(\d+)\.(\d+)/)
  try {
    return {
      major: Number.parseInt(gitVersionMatches[1]),
      minor: Number.parseInt(gitVersionMatches[2]),
      patch: Number.parseInt(gitVersionMatches[3])
    }
  } catch {
    return null
  }
}

function sleepSync (ms) {
  const sab = new SharedArrayBuffer(4)
  const i32 = new Int32Array(sab)
  Atomics.wait(i32, 0, 0, ms)
}

function waitForLock ({ intervalMs = 500, timeoutMs = 5 * 60 * 1000 } = {}) {
  const repositoryRoot = getRepositoryRoot()
  const target = path.resolve(repositoryRoot, '.git/shallow.lock')
  const start = Date.now()

  while (true) {
    let exists = true
    try {
      fs.accessSync(target, fs.constants.F_OK)
    } catch (err) {
      if (err && err.code === 'ENOENT') exists = false
      else throw err
    }

    if (!exists) return

    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for ${target} to disappear`)
    }

    sleepSync(intervalMs)
  }
}

function runGit(args, opts = {}) {
  try {
    console.log('running git', args)
    return cp.execFileSync(
      "git",
      args,
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }
    ).trim()
  } catch (err) {
    const stderr = err.stderr?.toString?.() || ""
    const stdout = err.stdout?.toString?.() || ""
    err.message = `git ${args.join(" ")}\n${stderr || stdout || err.message}`
    throw err
  }
}
function getMergeBase (baseBranch, sourceBranch) {
  const step = 200
  const maxDepth = 5000
  const shallowSince = '2 day ago' // e.g., '2025-04-01'

  // Ensure we're in a repo
  const inside = runGit(['rev-parse', '--is-inside-work-tree'])
  if (inside !== 'true') {
    throw new Error('Not a git repository here.')
  }

  // Prepare a local remote-tracking ref for the target branch with minimal payload
  const targetRef = `refs/remotes/origin/${baseBranch}`
  const refspec = `+refs/heads/${baseBranch}:${targetRef}`

  // First, create the local tracking ref with the smallest possible history
  const baseFetchArgs = ['fetch', '--no-tags', '--filter=blob:none', 'origin', refspec]
  if (shallowSince) {
    // Prefer a date fence if you roughly know when the branch diverged
    baseFetchArgs.splice(2, 0, `--shallow-since=${shallowSince}`)
  } else {
    baseFetchArgs.splice(2, 0, '--depth=1')
  }
  runGit(baseFetchArgs)

  // Try an immediate merge-base with minimal history
  let base = ''
  try {
    base = runGit(['merge-base', targetRef, sourceBranch])
  } catch {
    base = ''
  }
  if (base) return base

  // Incrementally deepen both sides
  let curDepth = step
  while (!base && curDepth <= maxDepth) {
    // Deepen the currently checked-out history (your pipeline commit side)
    // (No refspec => deepen the mapped refs for 'origin' works for detached HEAD as well)
    try {
      runGit(['fetch', '--no-tags', '--filter=blob:none', `--deepen=${step}`, 'origin'])
    } catch { /* ignore transient failures and keep trying */ }

    // Deepen the target branch tracking ref
    try {
      runGit(['fetch', '--no-tags', '--filter=blob:none', `--deepen=${step}`, 'origin', refspec])
    } catch { /* ignore transient failures */ }

    try {
      base = runGit(['merge-base', targetRef, sourceBranch])
    } catch {
      base = ''
    }
    curDepth += step
  }

  if (!base) {
    throw new Error(
      `No merge-base found after deepening to ~${maxDepth} commits.\n` +
      'Possible causes: unrelated histories, very old fork point, or branch was force-pushed/rebased.'
    )
  }
  return base
}

function unshallowRepository (parentOnly = false) {
  console.log('waiting for lock')
  waitForLock()

  console.log('waiting for lock done')

  const gitVersion = getGitVersion()
  if (!gitVersion) {
    log.warn('Git version could not be extracted, so git unshallow will not proceed')
    return
  }
  if (gitVersion.major < 2 || (gitVersion.major === 2 && gitVersion.minor < 27)) {
    log.warn('Git version is <2.27, so git unshallow will not proceed')
    return
  }
  const defaultRemoteName = sanitizedExec('git', ['config', '--default', 'origin', '--get', 'clone.defaultRemoteName'])
  const revParseHead = sanitizedExec('git', ['rev-parse', 'HEAD'])

  console.log('defaultRemoteName', defaultRemoteName)
  console.log('revParseHead', revParseHead)
  const baseGitOptions = [
    'fetch',
    parentOnly ? '--deepen=1' : '--shallow-since="1 day ago"',
    '--update-shallow',
    '--recurse-submodules=no',
    defaultRemoteName
  ]
  console.log('baseGitOptions', baseGitOptions)

  incrementCountMetric(TELEMETRY_GIT_COMMAND, { command: 'unshallow' })
  const start = Date.now()
  let flags = [
    ...baseGitOptions,
    revParseHead
  ]
  try {
    cachedExec('git', flags)
  } catch (err) {
    console.log('failed cachedExec', err)
    // If the local HEAD is a commit that has not been pushed to the remote, the above command will fail.
    log.warn(`Git unshallow failed: ${flags.join(' ')}`)
    incrementCountMetric(
      TELEMETRY_GIT_COMMAND_ERRORS,
      { command: 'unshallow', errorType: err.code, exitCode: err.status || err.errno }
    )
    const upstreamRemote = sanitizedExec(
      'git',
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']
    )
    flags = [
      ...baseGitOptions,
      upstreamRemote
    ]
    console.log('trying unshallow again', flags)
    try {
      cachedExec('git', flags)
    } catch (err) {
      console.log('failed unshallow again two', err)
      // If the CI is working on a detached HEAD or branch tracking hasn't been set up, the above command will fail.
      log.warn(`Git unshallow failed again: ${flags.join(' ')}`)
      incrementCountMetric(
        TELEMETRY_GIT_COMMAND_ERRORS,
        { command: 'unshallow', errorType: err.code, exitCode: err.status || err.errno }
      )
      console.log('trying unshallow for the last time')
      // We use sanitizedExec here because if this last option fails, we'll give up.
      sanitizedExec(
        'git',
        baseGitOptions,
        null,
        null,
        { name: TELEMETRY_GIT_COMMAND_ERRORS, tags: { command: 'unshallow' } } // we log the error in sanitizedExec
      )
    }
  }
  distributionMetric(TELEMETRY_GIT_COMMAND_MS, { command: 'unshallow' }, Date.now() - start)
}

function getRepositoryUrl () {
  return sanitizedExec(
    'git',
    ['config', '--get', 'remote.origin.url'],
    { name: TELEMETRY_GIT_COMMAND, tags: { command: 'get_repository' } },
    { name: TELEMETRY_GIT_COMMAND_MS, tags: { command: 'get_repository' } },
    { name: TELEMETRY_GIT_COMMAND_ERRORS, tags: { command: 'get_repository' } }
  )
}

function getLatestCommits () {
  incrementCountMetric(TELEMETRY_GIT_COMMAND, { command: 'get_local_commits' })
  const startTime = Date.now()
  try {
    const result = cachedExec('git', ['log', '--format=%H', '-n 1000', '--since="1 month ago"'])
      .toString()
      .split('\n')
      .filter(Boolean)
    distributionMetric(TELEMETRY_GIT_COMMAND_MS, { command: 'get_local_commits' }, Date.now() - startTime)
    return result
  } catch (err) {
    log.error('Get latest commits failed: %s', err.message)
    incrementCountMetric(
      TELEMETRY_GIT_COMMAND_ERRORS,
      { command: 'get_local_commits', errorType: err.status }
    )
    return []
  }
}

function getGitDiff (baseCommit, targetCommit) {
  const flags = ['diff', '-U0', '--word-diff=porcelain', baseCommit]
  if (targetCommit) {
    flags.push(targetCommit)
  }
  return sanitizedExec(
    'git',
    flags,
    { name: TELEMETRY_GIT_COMMAND, tags: { command: 'diff' } },
    { name: TELEMETRY_GIT_COMMAND_MS, tags: { command: 'diff' } },
    { name: TELEMETRY_GIT_COMMAND_ERRORS, tags: { command: 'diff' } },
    false // important not to trim or we'll lose the line breaks which we need to detect impacted tests
  )
}

function getGitRemoteName () {
  const upstreamRemote = sanitizedExec(
    'git',
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
    { name: TELEMETRY_GIT_COMMAND, tags: { command: 'get_remote_name' } },
    { name: TELEMETRY_GIT_COMMAND_MS, tags: { command: 'get_remote_name' } },
    { name: TELEMETRY_GIT_COMMAND_ERRORS, tags: { command: 'get_remote_name' } }
  )

  if (upstreamRemote) {
    return upstreamRemote.split('/')[0]
  }

  const remotes = sanitizedExec(
    'git',
    ['remote'],
    { name: TELEMETRY_GIT_COMMAND, tags: { command: 'get_remote_name' } },
    { name: TELEMETRY_GIT_COMMAND_MS, tags: { command: 'get_remote_name' } },
    { name: TELEMETRY_GIT_COMMAND_ERRORS, tags: { command: 'get_remote_name' } },
    false
  )

  return remotes.split('\n')[0] || 'origin'
}

function getSourceBranch () {
  return sanitizedExec(
    'git',
    ['rev-parse', '--abbrev-ref', 'HEAD'],
    { name: TELEMETRY_GIT_COMMAND, tags: { command: 'get_source_branch' } },
    { name: TELEMETRY_GIT_COMMAND_MS, tags: { command: 'get_source_branch' } },
    { name: TELEMETRY_GIT_COMMAND_ERRORS, tags: { command: 'get_source_branch' } }
  )
}

function checkAndFetchBranch (branch, remoteName) {
  try {
    // `git show-ref --verify --quiet refs/remotes/${remoteName}/${branch}` will exit 0 if the branch exists
    // Otherwise it will exit 1
    cachedExec(
      'git',
      ['show-ref', '--verify', '--quiet', `refs/remotes/${remoteName}/${branch}`],
    )
    // branch exists locally, so we finish
  } catch {
    // branch does not exist locally, so we will check the remote
    try {
      // IMPORTANT: we use timeouts because these commands hang if the branch can't be found
      // `git ls-remote --heads origin my-branch` will exit 0 even if the branch doesn't exist.
      // The piece of information we need is whether the command outputs anything.
      // `git ls-remote --heads origin my-branch` could exit an error code if the remote does not exist.
      const remoteHeads = cachedExec(
        'git',
        ['ls-remote', '--heads', remoteName, branch],
        { stdio: 'pipe', timeout: 2000 }
      )
      if (remoteHeads) {
        // branch exists, so we'll fetch it
        cachedExec(
          'git',
          ['fetch', '--depth', '1', remoteName, branch],
          { stdio: 'pipe', timeout: 5000 }
        )
      }
    } catch (err) {
      // branch does not exist or couldn't be fetched, so we can't do anything
      log.debug('Git plugin error checking and fetching branch', err)
    }
  }
}

function getLocalBranches (remoteName) {
  const localBranches = sanitizedExec(
    'git',
    ['for-each-ref', '--format=%(refname:short)', `refs/remotes/${remoteName}`],
    { name: TELEMETRY_GIT_COMMAND, tags: { command: 'get_local_branches' } },
    { name: TELEMETRY_GIT_COMMAND_MS, tags: { command: 'get_local_branches' } },
    { name: TELEMETRY_GIT_COMMAND_ERRORS, tags: { command: 'get_local_branches' } },
    false
  )
  try {
    return localBranches.split('\n').filter(Boolean)
  } catch {
    return []
  }
}

// function getMergeBase (baseBranch, sourceBranch) {
//   console.log('getMergeBase', { baseBranch, sourceBranch })

//   let other = null
//   try {
//     other = cp.execFileSync(
//       'git', ['merge-base', baseBranch, sourceBranch], { stdio: 'pipe', timeout: 5000 })
//     console.log('other', other)
//     other = other.toString()
//   } catch (err) {
//     console.log('failed merge-base', err)
//   }

//   return other
// }

function getCounts (sourceBranch, candidateBranch) {
  const counts = sanitizedExec(
    'git',
    ['rev-list', '--left-right', '--count', `${candidateBranch}...${sourceBranch}`],
    { name: TELEMETRY_GIT_COMMAND, tags: { command: 'get_counts' } },
    { name: TELEMETRY_GIT_COMMAND_MS, tags: { command: 'get_counts' } },
    { name: TELEMETRY_GIT_COMMAND_ERRORS, tags: { command: 'get_counts' } }
  )
  try {
    if (!counts) {
      return { behind: null, ahead: null }
    }
    const [behind, ahead] = counts.split(/\s+/).map(Number)
    return { behind, ahead }
  } catch {
    return { behind: null, ahead: null }
  }
}

function getCommitsRevList (commitsToExclude, commitsToInclude) {
  let result = null

  const commitsToExcludeString = commitsToExclude.map(commit => `^${commit}`)

  incrementCountMetric(TELEMETRY_GIT_COMMAND, { command: 'get_objects' })
  const startTime = Date.now()
  try {
    result = cachedExec(
      'git',
      [
        'rev-list',
        '--objects',
        '--no-object-names',
        '--filter=blob:none',
        '--since="1 month ago"',
        ...commitsToExcludeString,
        ...commitsToInclude
      ],
      { stdio: 'pipe', maxBuffer: GIT_REV_LIST_MAX_BUFFER })
      .toString()
      .split('\n')
      .filter(Boolean)
  } catch (err) {
    log.error('Get commits to upload failed: %s', err.message)
    incrementCountMetric(
      TELEMETRY_GIT_COMMAND_ERRORS,
      { command: 'get_objects', errorType: err.code, exitCode: err.status || err.errno } // err.status might be null
    )
  }
  distributionMetric(TELEMETRY_GIT_COMMAND_MS, { command: 'get_objects' }, Date.now() - startTime)
  return result
}

function generatePackFilesForCommits (commitsToUpload) {
  let result = []
  const tmpFolder = os.tmpdir()

  if (!isDirectory(tmpFolder)) {
    // TODO: Do we need the stack trace for this error? If not, just log the string
    log.error(new Error('Provided path to generate packfiles is not a directory'))
    return []
  }

  const randomPrefix = String(Math.floor(Math.random() * 10_000))
  const temporaryPath = path.join(tmpFolder, randomPrefix)
  const cwdPath = path.join(process.cwd(), randomPrefix)

  incrementCountMetric(TELEMETRY_GIT_COMMAND, { command: 'pack_objects' })
  const startTime = Date.now()
  // Generates pack files to upload and
  // returns the ordered list of packfiles' paths
  function execGitPackObjects (targetPath) {
    return cachedExec(
      'git',
      [
        'pack-objects',
        '--compression=9',
        '--max-pack-size=3m',
        targetPath
      ],
      { stdio: 'pipe', input: commitsToUpload.join('\n') }
    ).toString().split('\n').filter(Boolean).map(commit => `${targetPath}-${commit}.pack`)
  }

  try {
    result = execGitPackObjects(temporaryPath)
  } catch (err) {
    log.error('Git plugin error executing git pack-objects command', err)
    incrementCountMetric(
      TELEMETRY_GIT_COMMAND_ERRORS,
      { command: 'pack_objects', exitCode: err.status || err.errno, errorType: err.code }
    )
    /**
     * The generation of pack files in the temporary folder (from `os.tmpdir()`)
     * sometimes fails in certain CI setups with the error message
     * `unable to rename temporary pack file: Invalid cross-device link`.
     * The reason why is unclear.
     *
     * A workaround is to attempt to generate the pack files in `process.cwd()`.
     * While this works most of the times, it's not ideal since it affects the git status.
     * This workaround is intended to be temporary.
     *
     * TODO: fix issue and remove workaround.
     */
    try {
      result = execGitPackObjects(cwdPath)
    } catch (err) {
      log.error('Git plugin error executing fallback git pack-objects command', err)
      incrementCountMetric(
        TELEMETRY_GIT_COMMAND_ERRORS,
        { command: 'pack_objects', exitCode: err.status || err.errno, errorType: err.code }
      )
    }
  }
  distributionMetric(TELEMETRY_GIT_COMMAND_MS, { command: 'pack_objects' }, Date.now() - startTime)

  return result
}

function getRepositoryRoot () {
  return sanitizedExec(
    'git',
    ['rev-parse', '--show-toplevel']
  )
}

// If there is ciMetadata, it takes precedence.
function getGitMetadata (ciMetadata) {
  const {
    commitSHA,
    branch,
    repositoryUrl,
    tag,
    commitMessage,
    authorName: ciAuthorName,
    authorEmail: ciAuthorEmail,
    ciWorkspacePath,
    headCommitSha
  } = ciMetadata

  // With stdio: 'pipe', errors in this command will not be output to the parent process,
  // so if `git` is not present in the env, we won't show a warning to the user.
  const [
    authorName,
    authorEmail,
    authorDate,
    committerName,
    committerEmail,
    committerDate
  ] = sanitizedExec('git', ['show', '-s', '--format=%an,%ae,%aI,%cn,%ce,%cI']).split(',')

  const tags = {
    [GIT_COMMIT_MESSAGE]:
      commitMessage || sanitizedExec('git', ['show', '-s', '--format=%B'], null, null, null, false),
    [GIT_BRANCH]: branch || sanitizedExec('git', ['rev-parse', '--abbrev-ref', 'HEAD']),
    [GIT_COMMIT_SHA]: commitSHA || sanitizedExec('git', ['rev-parse', 'HEAD']),
    [CI_WORKSPACE_PATH]: ciWorkspacePath || getRepositoryRoot(),
  }

  if (headCommitSha) {
    if (isShallowRepository()) {
      fetchHeadCommitSha(headCommitSha)
    }

    const [
      gitHeadCommitSha,
      headAuthorDate,
      headAuthorName,
      headAuthorEmail,
      headCommitterDate,
      headCommitterName,
      headCommitterEmail,
      headCommitMessage
    ] = sanitizedExec(
      'git',
      [
        'show',
        '-s',
        '--format=\'%H","%aI","%an","%ae","%cI","%cn","%ce","%B\'',
        headCommitSha
      ],
      null,
      null,
      null,
      false
    ).split('","')

    if (gitHeadCommitSha) {
      tags[GIT_COMMIT_HEAD_AUTHOR_DATE] = headAuthorDate
      tags[GIT_COMMIT_HEAD_AUTHOR_EMAIL] = headAuthorEmail
      tags[GIT_COMMIT_HEAD_AUTHOR_NAME] = headAuthorName
      tags[GIT_COMMIT_HEAD_COMMITTER_DATE] = headCommitterDate
      tags[GIT_COMMIT_HEAD_COMMITTER_EMAIL] = headCommitterEmail
      tags[GIT_COMMIT_HEAD_COMMITTER_NAME] = headCommitterName
      tags[GIT_COMMIT_HEAD_MESSAGE] = headCommitMessage
    }
  }

  const entries = [
    GIT_REPOSITORY_URL,
    filterSensitiveInfoFromRepository(repositoryUrl || sanitizedExec('git', ['ls-remote', '--get-url'])),
    GIT_COMMIT_AUTHOR_DATE, authorDate,
    GIT_COMMIT_AUTHOR_NAME, ciAuthorName || authorName,
    GIT_COMMIT_AUTHOR_EMAIL, ciAuthorEmail || authorEmail,
    GIT_COMMIT_COMMITTER_DATE, committerDate,
    GIT_COMMIT_COMMITTER_NAME, committerName,
    GIT_COMMIT_COMMITTER_EMAIL, committerEmail,
    GIT_TAG, tag
  ]

  for (let i = 0; i < entries.length; i += 2) {
    const value = entries[i + 1]
    if (value) {
      tags[entries[i]] = value
    }
  }

  return tags
}

function getGitInformationDiscrepancy () {
  const gitRepositoryUrl = getRepositoryUrl()

  const gitCommitSHA = sanitizedExec(
    'git',
    ['rev-parse', 'HEAD'],
    { name: TELEMETRY_GIT_COMMAND, tags: { command: 'get_commit_sha' } },
    { name: TELEMETRY_GIT_COMMAND_MS, tags: { command: 'get_commit_sha' } },
    { name: TELEMETRY_GIT_COMMAND_ERRORS, tags: { command: 'get_commit_sha' } }
  )

  return { gitRepositoryUrl, gitCommitSHA }
}

function fetchHeadCommitSha (headSha) {
  const remoteName = getGitRemoteName()

  sanitizedExec(
    'git',
    [
      'fetch',
      '--update-shallow',
      '--filter=blob:none',
      '--recurse-submodules=no',
      '--no-write-fetch-head',
      remoteName,
      headSha
    ],
    { name: TELEMETRY_GIT_COMMAND, tags: { command: 'fetch_head_commit_sha' } },
    { name: TELEMETRY_GIT_COMMAND_MS, tags: { command: 'fetch_head_commit_sha' } },
    { name: TELEMETRY_GIT_COMMAND_ERRORS, tags: { command: 'fetch_head_commit_sha' } }
  )
}

module.exports = {
  getGitMetadata,
  getLatestCommits,
  getRepositoryUrl,
  generatePackFilesForCommits,
  getCommitsRevList,
  GIT_REV_LIST_MAX_BUFFER,
  isShallowRepository,
  unshallowRepository,
  isGitAvailable,
  getGitInformationDiscrepancy,
  getGitDiff,
  getGitRemoteName,
  getSourceBranch,
  checkAndFetchBranch,
  getLocalBranches,
  getMergeBase,
  getCounts,
  fetchHeadCommitSha,
  getRepositoryRoot
}
