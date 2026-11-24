'use strict'

const os = require('os')
const path = require('path')
const fs = require('fs')
const { execFileSync } = require('node:child_process')

const log = require('../../log')
const { getEnvironmentVariables } = require('../../config/helper')
const {
  incrementCountMetric,
  distributionMetric,
  TELEMETRY_GIT_COMMAND,
  TELEMETRY_GIT_COMMAND_MS,
  TELEMETRY_GIT_COMMAND_ERRORS,
} = require('../../ci-visibility/telemetry')
const { storage } = require('../../../../datadog-core')
const { getSegment } = require('../../util')
const {
  GIT_COMMIT_SHA,
  GIT_BRANCH,
  GIT_REPOSITORY_URL,
  GIT_CHECKOUT_ROOT,
  GIT_CHECKOUT_IS_CUSTOM,
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
  GIT_COMMIT_HEAD_MESSAGE,
} = require('./tags')
const { filterSensitiveInfoFromRepository } = require('./url')
const { cachedExec } = require('./git-cache')
const { validateGitCommitSha } = require('./user-provided-git')

/** @typedef {NonNullable<ReturnType<string['match']>>} RegExpMatch */

const legacyStorage = storage('legacy')

const GIT_REV_LIST_MAX_BUFFER = 12 * 1024 * 1024 // 12MB

function getGitEnvironment () {
  const env = { ...getEnvironmentVariables() }
  // Git resolves repository locations before moving from a project subdirectory to the worktree root.
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR']) {
    if (env[key] && !path.isAbsolute(env[key])) {
      // Keep POSIX symlink/.. traversal; Windows also supports drive-relative paths.
      env[key] = path.sep === '\\' ? path.resolve(env[key]) : `${process.cwd()}${path.sep}${env[key]}`
    }
  }
  return env
}

function sanitizedExec (
  flags,
  operationMetric,
  durationMetric,
  errorMetric,
  shouldTrim = true,
  executionOptions
) {
  return legacyStorage.run({ noop: true }, () => {
    let startTime
    if (operationMetric) {
      incrementCountMetric(operationMetric.name, operationMetric.tags)
    }
    if (durationMetric) {
      startTime = Date.now()
    }
    try {
      const exec = executionOptions?.uncached ? execFileSync : cachedExec
      /** @type {import('node:child_process').ExecFileSyncOptions} */
      const options = { stdio: 'pipe', env: getGitEnvironment() }
      if (executionOptions?.cwd) options.cwd = executionOptions.cwd
      if (executionOptions?.timeout) options.timeout = executionOptions.timeout
      if (executionOptions?.localOnly) {
        options.env.GIT_NO_LAZY_FETCH = '1'
        options.env.GIT_ALLOW_PROTOCOL = ''
      }
      let result = exec('git', flags, options).toString()

      if (shouldTrim) {
        result = result.replaceAll(/(\r\n|\n|\r)/g, '')
      }

      if (durationMetric) {
        distributionMetric(durationMetric.name, durationMetric.tags, Date.now() - startTime)
      }
      return result
    } catch (err) {
      if (errorMetric) {
        incrementCountMetric(errorMetric.name, {
          ...errorMetric.tags,
          errorType: err.code,
          exitCode: err.status || err.errno,
        })
      }
      if (executionOptions?.expectedFailure) {
        log.debug('Git plugin error executing command', err)
      } else {
        log.error('Git plugin error executing command', err)
      }
      if (executionOptions?.throwOnError) throw err
      return ''
    }
  })
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
  try {
    cachedExec('git', ['--version'])
    return true
  } catch {
    incrementCountMetric(TELEMETRY_GIT_COMMAND_ERRORS, { command: 'check_git', exitCode: 'missing' })
    return false
  }
}

function isShallowRepository (uncached = false, cwd) {
  return sanitizedExec(
    ['rev-parse', '--is-shallow-repository'],
    { name: TELEMETRY_GIT_COMMAND, tags: { command: 'check_shallow' } },
    { name: TELEMETRY_GIT_COMMAND_MS, tags: { command: 'check_shallow' } },
    { name: TELEMETRY_GIT_COMMAND_ERRORS, tags: { command: 'check_shallow' } },
    true,
    { uncached, cwd }
  ) === 'true'
}

function getGitVersion (cwd) {
  const gitVersionString = sanitizedExec(['version'], null, null, null, true, { cwd })
  const gitVersionMatches = /** @type {RegExpMatch} */ (gitVersionString.match(/git version (\d+)\.(\d+)\.(\d+)/))
  try {
    return {
      major: Number.parseInt(gitVersionMatches[1], 10),
      minor: Number.parseInt(gitVersionMatches[2], 10),
      patch: Number.parseInt(gitVersionMatches[3], 10),
    }
  } catch {
    return null
  }
}

function unshallowRepository (parentOnly = false, commitSha, cwd) {
  if (commitSha && !validateGitCommitSha(commitSha)) return
  const gitVersion = getGitVersion(cwd)
  if (!gitVersion) {
    log.warn('Git version could not be extracted, so git unshallow will not proceed')
    return
  }
  if (gitVersion.major < 2 || (gitVersion.major === 2 && gitVersion.minor < 27)) {
    log.warn('Git version is <2.27, so git unshallow will not proceed')
    return
  }
  const defaultRemoteName = getGitRemoteName(cwd)
  const checkoutHead = sanitizedExec(['rev-parse', 'HEAD'], null, null, null, true, { uncached: true, cwd })
  const revParseHead = commitSha || checkoutHead
  const targetedRecovery = commitSha && commitSha.toLowerCase() !== checkoutHead.toLowerCase()
  /** @type {import('node:child_process').ExecFileSyncOptionsWithBufferEncoding} */
  const fetchOptions = { stdio: 'pipe', env: getGitEnvironment() }
  if (cwd) fetchOptions.cwd = cwd
  if (targetedRecovery) fetchOptions.timeout = 5000
  const depth = parentOnly ? '--deepen=1' : '--shallow-since="1 month ago"'

  const baseGitOptions = [
    'fetch',
    depth,
    '--update-shallow',
    '--filter=blob:none',
    '--recurse-submodules=no',
    defaultRemoteName,
  ]

  incrementCountMetric(TELEMETRY_GIT_COMMAND, { command: 'unshallow' })
  const start = Date.now()
  let flags = [
    ...baseGitOptions,
    revParseHead,
  ]
  try {
    execFileSync('git', flags, fetchOptions)
  } catch (err) {
    // If the local HEAD is a commit that has not been pushed to the remote, the above command will fail.
    // eslint-disable-next-line eslint-rules/eslint-log-printf-style
    log.warn(() => `Git unshallow failed: ${flags.join(' ')}`)
    incrementCountMetric(
      TELEMETRY_GIT_COMMAND_ERRORS,
      { command: 'unshallow', errorType: err.code, exitCode: err.status || err.errno }
    )
    if (targetedRecovery) {
      const timeout = 5000 - (Date.now() - start)
      if (timeout > 0 && !hasLocalGitObject(revParseHead, cwd)) {
        sanitizedExec(
          ['fetch', '--depth=1', ...baseGitOptions.slice(2), revParseHead],
          null, null,
          { name: TELEMETRY_GIT_COMMAND_ERRORS, tags: { command: 'unshallow' } },
          true,
          { uncached: true, timeout, expectedFailure: true, cwd }
        )
      }
      return
    }
    const upstreamRemote = sanitizedExec(
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
      null, null, null, true, { uncached: true, cwd }
    )
    flags = [
      ...baseGitOptions,
      upstreamRemote,
    ]
    try {
      execFileSync('git', flags, fetchOptions)
    } catch (err) {
      // If the CI is working on a detached HEAD or branch tracking hasn't been set up, the above command will fail.
      // eslint-disable-next-line eslint-rules/eslint-log-printf-style
      log.warn(() => `Git unshallow failed again: ${flags.join(' ')}`)
      incrementCountMetric(
        TELEMETRY_GIT_COMMAND_ERRORS,
        { command: 'unshallow', errorType: err.code, exitCode: err.status || err.errno }
      )
      // We use sanitizedExec here because if this last option fails, we'll give up.
      sanitizedExec(
        baseGitOptions,
        null,
        null,
        { name: TELEMETRY_GIT_COMMAND_ERRORS, tags: { command: 'unshallow' } }, // we log the error in sanitizedExec
        true,
        { uncached: true, cwd }
      )
    }
  }
  distributionMetric(TELEMETRY_GIT_COMMAND_MS, { command: 'unshallow' }, Date.now() - start)
}

function getRepositoryUrl (cwd) {
  return sanitizedExec(
    ['remote', 'get-url', getGitRemoteName(cwd)],
    { name: TELEMETRY_GIT_COMMAND, tags: { command: 'get_repository' } },
    { name: TELEMETRY_GIT_COMMAND_MS, tags: { command: 'get_repository' } },
    { name: TELEMETRY_GIT_COMMAND_ERRORS, tags: { command: 'get_repository' } },
    true,
    { uncached: true, cwd }
  )
}

/**
 * @param {string=} commitSha
 * @param {string=} cwd
 */
function getLatestCommits (commitSha, cwd) {
  if (commitSha && !validateGitCommitSha(commitSha)) return []
  incrementCountMetric(TELEMETRY_GIT_COMMAND, { command: 'get_local_commits' })
  const startTime = Date.now()
  try {
    const flags = ['log', '--format=%H', '-n 1000', '--since="1 month ago"']
    if (commitSha) flags.push(commitSha, '--')
    const env = { ...getGitEnvironment(), GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '' }
    /** @type {import('node:child_process').ExecFileSyncOptionsWithBufferEncoding} */
    const options = { stdio: 'pipe', env }
    if (cwd) options.cwd = cwd
    const result = execFileSync('git', flags, options)
      .toString()
      .split('\n')
      .filter(Boolean)
    if (commitSha && !result.includes(commitSha)) {
      const selectedCommit = execFileSync('git',
        ['rev-parse', '--verify', commitSha + '^{commit}'], options)
        .toString().trim()
      if (selectedCommit !== commitSha) return []
      result.unshift(commitSha)
    }
    distributionMetric(TELEMETRY_GIT_COMMAND_MS, { command: 'get_local_commits' }, Date.now() - startTime)
    return result
  } catch (err) {
    log.error('Get latest commits failed', err)
    incrementCountMetric(
      TELEMETRY_GIT_COMMAND_ERRORS,
      { command: 'get_local_commits', errorType: err.status }
    )
    return []
  }
}

function getGitDiff (baseCommit, targetCommit, cwd) {
  // Fetch the required snapshots explicitly; a depth-1 metadata fetch does not provide their ancestry.
  for (const commit of targetCommit ? [baseCommit, targetCommit] : [baseCommit]) {
    if (!hasLocalGitObject(commit, cwd)) {
      // Use the current checkout state so a stale cache cannot shorten a complete clone.
      fetchHeadCommitSha(commit, isShallowRepository(true, cwd), cwd)
    }
  }
  const flags = ['diff', '-U0', '--word-diff=porcelain', baseCommit]
  if (targetCommit) {
    flags.push(targetCommit)
  }
  return sanitizedExec(
    flags,
    { name: TELEMETRY_GIT_COMMAND, tags: { command: 'diff' } },
    { name: TELEMETRY_GIT_COMMAND_MS, tags: { command: 'diff' } },
    { name: TELEMETRY_GIT_COMMAND_ERRORS, tags: { command: 'diff' } },
    false, // important not to trim or we'll lose the line breaks which we need to detect impacted tests
    { uncached: true, cwd }
  )
}

function getGitRemoteName (cwd) {
  const branchRef = sanitizedExec(
    ['symbolic-ref', '--quiet', 'HEAD'],
    { name: TELEMETRY_GIT_COMMAND, tags: { command: 'get_remote_name' } },
    { name: TELEMETRY_GIT_COMMAND_MS, tags: { command: 'get_remote_name' } },
    { name: TELEMETRY_GIT_COMMAND_ERRORS, tags: { command: 'get_remote_name' } },
    true,
    { expectedFailure: true, uncached: true, cwd } // Detached HEADs use the checkout-local fallback.
  )

  const remotes = sanitizedExec(
    ['remote'],
    { name: TELEMETRY_GIT_COMMAND, tags: { command: 'get_remote_name' } },
    { name: TELEMETRY_GIT_COMMAND_MS, tags: { command: 'get_remote_name' } },
    { name: TELEMETRY_GIT_COMMAND_ERRORS, tags: { command: 'get_remote_name' } },
    false,
    { uncached: true, cwd }
  )

  if (!remotes) return 'origin'

  const remoteNames = remotes.trim().split(/\r?\n/)
  const branch = branchRef.replace(/^refs\/heads\//, '')
  if (branch) {
    // Read the configured remote: custom fetch refspecs can use any ref namespace.
    const branchRemote = sanitizedExec(
      ['config', '--get', `branch.${branch}.remote`],
      { name: TELEMETRY_GIT_COMMAND, tags: { command: 'get_remote_name' } },
      { name: TELEMETRY_GIT_COMMAND_MS, tags: { command: 'get_remote_name' } },
      { name: TELEMETRY_GIT_COMMAND_ERRORS, tags: { command: 'get_remote_name' } },
      true,
      { expectedFailure: true, uncached: true, cwd }
    )
    if (branchRemote !== '.' && remoteNames.includes(branchRemote)) return branchRemote
  }
  const configuredRemote = sanitizedExec(
    ['config', '--local', '--get', 'clone.defaultRemoteName'],
    { name: TELEMETRY_GIT_COMMAND, tags: { command: 'get_remote_name' } },
    { name: TELEMETRY_GIT_COMMAND_MS, tags: { command: 'get_remote_name' } },
    { name: TELEMETRY_GIT_COMMAND_ERRORS, tags: { command: 'get_remote_name' } },
    true,
    { expectedFailure: true, uncached: true, cwd }
  )

  if (configuredRemote && remoteNames.includes(configuredRemote)) return configuredRemote
  // Clone -o overrides remain in local branch tracking after HEAD is detached.
  const trackingConfiguration = sanitizedExec(
    ['config', '--local', '--get-regexp', String.raw`^branch\..*\.remote$`],
    { name: TELEMETRY_GIT_COMMAND, tags: { command: 'get_remote_name' } },
    { name: TELEMETRY_GIT_COMMAND_MS, tags: { command: 'get_remote_name' } },
    { name: TELEMETRY_GIT_COMMAND_ERRORS, tags: { command: 'get_remote_name' } },
    false,
    { expectedFailure: true, uncached: true, cwd }
  )
  const trackingRemotes = new Set(trackingConfiguration.split(/\r?\n/)
    .map(line => getSegment(line, ' ', 1)).filter(remote => remote && remoteNames.includes(remote)))
  if (trackingRemotes.size === 1) return trackingRemotes.values().next().value
  return remoteNames.includes('origin') ? 'origin' : remoteNames[0] || 'origin'
}

function getSourceBranch (cwd) {
  return sanitizedExec(
    ['rev-parse', '--abbrev-ref', 'HEAD'],
    { name: TELEMETRY_GIT_COMMAND, tags: { command: 'get_source_branch' } },
    { name: TELEMETRY_GIT_COMMAND_MS, tags: { command: 'get_source_branch' } },
    { name: TELEMETRY_GIT_COMMAND_ERRORS, tags: { command: 'get_source_branch' } },
    true, { cwd }
  )
}

function checkAndFetchBranch (branch, remoteName, cwd) {
  const options = { stdio: 'pipe', env: getGitEnvironment() }
  if (cwd) options.cwd = cwd
  try {
    // `git show-ref --verify --quiet refs/remotes/${remoteName}/${branch}` will exit 0 if the branch exists
    // Otherwise it will exit 1
    cachedExec(
      'git',
      ['show-ref', '--verify', '--quiet', `refs/remotes/${remoteName}/${branch}`],
      options
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
        { ...options, timeout: 2000 }
      )
      if (remoteHeads) {
        // branch exists, so we'll fetch it
        cachedExec(
          'git',
          ['fetch', '--depth', '1', remoteName, branch],
          { ...options, timeout: 5000 }
        )
      }
    } catch (err) {
      // branch does not exist or couldn't be fetched, so we can't do anything
      log.debug('Git plugin error checking and fetching branch', err)
    }
  }
}

function getLocalBranches (remoteName, cwd) {
  const localBranches = sanitizedExec(
    ['for-each-ref', '--format=%(refname:short)', `refs/remotes/${remoteName}`],
    { name: TELEMETRY_GIT_COMMAND, tags: { command: 'get_local_branches' } },
    { name: TELEMETRY_GIT_COMMAND_MS, tags: { command: 'get_local_branches' } },
    { name: TELEMETRY_GIT_COMMAND_ERRORS, tags: { command: 'get_local_branches' } },
    false, { cwd }
  )
  try {
    return localBranches.split('\n').filter(Boolean)
  } catch {
    return []
  }
}

function getMergeBase (baseBranch, sourceBranch, cwd) {
  return sanitizedExec(
    ['merge-base', baseBranch, sourceBranch],
    { name: TELEMETRY_GIT_COMMAND, tags: { command: 'get_merge_base' } },
    { name: TELEMETRY_GIT_COMMAND_MS, tags: { command: 'get_merge_base' } },
    { name: TELEMETRY_GIT_COMMAND_ERRORS, tags: { command: 'get_merge_base' } },
    true, { cwd }
  )
}

function getCounts (sourceBranch, candidateBranch, cwd) {
  const counts = sanitizedExec(
    ['rev-list', '--left-right', '--count', `${candidateBranch}...${sourceBranch}`],
    { name: TELEMETRY_GIT_COMMAND, tags: { command: 'get_counts' } },
    { name: TELEMETRY_GIT_COMMAND_MS, tags: { command: 'get_counts' } },
    { name: TELEMETRY_GIT_COMMAND_ERRORS, tags: { command: 'get_counts' } },
    true, { cwd }
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

/**
 * @param {string[]} commitsToExclude
 * @param {string[]} commitsToInclude
 * @param {boolean} [allowLazyFetch] Allow a bounded retry to hydrate promised objects.
 * @param {string=} cwd
 */
function getCommitsRevList (commitsToExclude, commitsToInclude, allowLazyFetch = false, cwd) {
  let result

  const commitsToExcludeString = commitsToExclude.map(commit => `^${commit}`)

  incrementCountMetric(TELEMETRY_GIT_COMMAND, { command: 'get_objects' })
  const startTime = Date.now()
  try {
    const env = allowLazyFetch
      ? getGitEnvironment()
      : { ...getGitEnvironment(), GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '' }
    /** @type {import('node:child_process').ExecFileSyncOptions} */
    const options = { stdio: 'pipe', maxBuffer: GIT_REV_LIST_MAX_BUFFER, env }
    if (cwd) options.cwd = cwd
    if (allowLazyFetch) options.timeout = 5000
    result = execFileSync(
      'git',
      [
        'rev-list',
        '--objects',
        '--no-object-names',
        '--filter=blob:none',
        '--since="1 month ago"',
        '--max-count=1000',
        ...commitsToExcludeString,
        ...commitsToInclude,
      ],
      options)
      .toString()
      .split('\n')
      .filter(Boolean)
    const objects = new Set(result)
    // Only the first root can be the old selection prepended by getLatestCommits; other roots came from its window.
    const selectedCommit = commitsToInclude[0]
    if (validateGitCommitSha(selectedCommit) && !objects.has(selectedCommit) &&
      !commitsToExclude.includes(selectedCommit)) {
      if (allowLazyFetch) {
        options.timeout = 5000 - (Date.now() - startTime)
        if (options.timeout <= 0) throw new Error('Git object hydration timed out')
      }
      const selectedObjects = execFileSync('git', [
        'rev-list', '--objects', '--no-object-names', '--filter=blob:none', '--max-count=1',
        ...commitsToExcludeString, selectedCommit,
      ], options).toString().split('\n').filter(Boolean)
      result = [...new Set([...result, ...selectedObjects])]
    }
  } catch (err) {
    result = null
    log.error('Get commits to upload failed', err)
    incrementCountMetric(
      TELEMETRY_GIT_COMMAND_ERRORS,
      { command: 'get_objects', errorType: err.code, exitCode: err.status || err.errno } // err.status might be null
    )
  }
  distributionMetric(TELEMETRY_GIT_COMMAND_MS, { command: 'get_objects' }, Date.now() - startTime)
  return result
}

function generatePackFilesForCommits (commitsToUpload, cwd) {
  let result = []
  const tmpFolder = os.tmpdir()

  if (!isDirectory(tmpFolder)) {
    // TODO: Do we need the stack trace for this error? If not, just log the string
    log.error(new Error('Provided path to generate packfiles is not a directory'))
    return []
  }

  const randomPrefix = String(Math.floor(Math.random() * 10_000))
  const temporaryPath = path.join(tmpFolder, randomPrefix)
  const cwdPath = path.join(cwd || process.cwd(), randomPrefix)

  incrementCountMetric(TELEMETRY_GIT_COMMAND, { command: 'pack_objects' })
  const startTime = Date.now()
  // Generates pack files to upload and
  // returns the ordered list of packfiles' paths
  function execGitPackObjects (targetPath) {
    /** @type {import('node:child_process').ExecFileSyncOptionsWithBufferEncoding} */
    const options = { stdio: 'pipe', input: commitsToUpload.join('\n'), env: getGitEnvironment() }
    if (cwd) options.cwd = cwd
    return cachedExec(
      'git',
      [
        'pack-objects',
        '--compression=9',
        '--max-pack-size=3m',
        targetPath,
      ],
      options
    ).toString().split('\n').filter(Boolean).map(commit => `${targetPath}-${commit}.pack`)
  }

  try {
    result = execGitPackObjects(temporaryPath)
  } catch (err) {
    log.debug('Git plugin error executing git pack-objects command, trying the working directory', err)
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

function getRepositoryRoot (cwd) {
  return sanitizedExec(
    ['rev-parse', '--show-toplevel'], null, null, null, true, { uncached: true, cwd }
  )
}

/**
 * Read mutable checkout metadata without the cache shared by CI jobs.
 * @param {string[]} flags
 * @param {boolean} [shouldTrim]
 * @param {string=} cwd
 */
function readCheckout (flags, shouldTrim = true, cwd) {
  return sanitizedExec(flags, null, null, null, shouldTrim, { uncached: true, cwd })
}

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
    headCommitSha,
    pullRequestBaseBranchSha,
  } = ciMetadata
  const gitRoot = getRepositoryRoot()

  // With stdio: 'pipe', errors in this command will not be output to the parent process,
  // so if `git` is not present in the env, we won't show a warning to the user.
  const [
    authorName,
    authorEmail,
    authorDate,
    committerName,
    committerEmail,
    committerDate,
  ] = readCheckout([
    'show', '-s', '--no-show-signature', '--format=%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI',
  ], true, gitRoot).split('\0')

  const tags = {
    [GIT_COMMIT_MESSAGE]:
      commitMessage || readCheckout(['show', '-s', '--no-show-signature', '--format=%B'], false, gitRoot),
    [GIT_BRANCH]: branch || readCheckout(['rev-parse', '--abbrev-ref', 'HEAD'], true, gitRoot),
    [GIT_COMMIT_SHA]: commitSHA || readCheckout(['rev-parse', 'HEAD'], true, gitRoot),
    [CI_WORKSPACE_PATH]: ciWorkspacePath || gitRoot,
  }

  if (gitRoot) {
    tags[GIT_CHECKOUT_ROOT] = gitRoot
    if (ciWorkspacePath) {
      let workspacePath = path.resolve(ciWorkspacePath)
      let checkoutPath = path.resolve(gitRoot)
      try {
        workspacePath = fs.realpathSync.native(workspacePath)
        checkoutPath = fs.realpathSync.native(checkoutPath)
      } catch {
        // A provider may report a host path that is not mounted in the test container.
      }
      if (workspacePath !== checkoutPath) tags[GIT_CHECKOUT_IS_CUSTOM] = 'true'
    }
  }

  if (tags[GIT_BRANCH] === 'HEAD') delete tags[GIT_BRANCH]

  let localTag = tag
  if (!localTag && !tags[GIT_BRANCH]) {
    const tagsAtHead = readCheckout(['tag', '--no-column', '--points-at', 'HEAD'], false, gitRoot)
      .trim().split(/\r?\n/).filter(Boolean)
    if (tagsAtHead.length === 1) localTag = tagsAtHead[0]
  }

  if (headCommitSha) {
    const shallow = isShallowRepository(true, gitRoot)
    const fetchedAtDepthOne = shallow && fetchHeadCommitSha(headCommitSha, true, gitRoot)
    const headFlags = [
      'show',
      '-s',
      '--no-show-signature',
      '--format=%H%x00%aI%x00%an%x00%ae%x00%cI%x00%cn%x00%ce%x00%B',
      headCommitSha,
    ]
    // Only explicit, bounded fetches may contact the remote during head metadata recovery.
    const headOptions = { uncached: true, localOnly: true, cwd: gitRoot }
    let headInfo = sanitizedExec(headFlags, null, null, null, false, headOptions)
    if (!headInfo && (fetchedAtDepthOne || !shallow)) {
      fetchHeadCommitSha(headCommitSha, false, gitRoot)
      headInfo = sanitizedExec(headFlags, null, null, null, false, headOptions)
    }

    // Prepare a known diff base while the remote is available, including when Git upload is disabled.
    if (shallow && pullRequestBaseBranchSha && !hasLocalGitObject(pullRequestBaseBranchSha, gitRoot)) {
      fetchHeadCommitSha(pullRequestBaseBranchSha, true, gitRoot)
    }

    const [
      gitHeadCommitSha,
      headAuthorDate,
      headAuthorName,
      headAuthorEmail,
      headCommitterDate,
      headCommitterName,
      headCommitterEmail,
      headCommitMessage,
    ] = headInfo.split('\0')

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
    filterSensitiveInfoFromRepository(repositoryUrl || getRepositoryUrl(gitRoot)),
    GIT_COMMIT_AUTHOR_DATE, authorDate,
    GIT_COMMIT_AUTHOR_NAME, ciAuthorName || authorName,
    GIT_COMMIT_AUTHOR_EMAIL, ciAuthorEmail || authorEmail,
    GIT_COMMIT_COMMITTER_DATE, committerDate,
    GIT_COMMIT_COMMITTER_NAME, committerName,
    GIT_COMMIT_COMMITTER_EMAIL, committerEmail,
    GIT_TAG, localTag,
  ]

  for (let i = 0; i < entries.length; i += 2) {
    const value = entries[i + 1]
    if (value) {
      tags[entries[i]] = value
    }
  }

  return tags
}

function getGitInformationDiscrepancy (cwd) {
  const gitRepositoryUrl = getRepositoryUrl(cwd)

  const gitCommitSHA = sanitizedExec(
    ['rev-parse', 'HEAD'],
    { name: TELEMETRY_GIT_COMMAND, tags: { command: 'get_commit_sha' } },
    { name: TELEMETRY_GIT_COMMAND_MS, tags: { command: 'get_commit_sha' } },
    { name: TELEMETRY_GIT_COMMAND_ERRORS, tags: { command: 'get_commit_sha' } },
    true,
    { uncached: true, cwd }
  )

  return { gitRepositoryUrl, gitCommitSHA }
}

/**
 * @param {string} sha
 * @param {string=} cwd
 */
function hasLocalGitObject (sha, cwd) {
  return legacyStorage.run({ noop: true }, () => {
    try {
      /** @type {import('node:child_process').ExecFileSyncOptionsWithBufferEncoding} */
      const options = {
        stdio: 'pipe',
        // Older Git versions ignore GIT_NO_LAZY_FETCH, so also disallow transports for this local-only probe.
        env: { ...getGitEnvironment(), GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '' },
      }
      if (cwd) options.cwd = cwd
      execFileSync('git', ['cat-file', '-e', sha], options)
      return true
    } catch {
      return false
    }
  })
}

function fetchHeadCommitSha (headSha, useDepth = true, cwd) {
  const remoteName = getGitRemoteName(cwd)
  // Existing heads retain the original repair/history behavior; a failed bounded fetch also retries that path.
  const depths = useDepth && !hasLocalGitObject(headSha, cwd) ? [true, false] : [false]
  for (const shallow of depths) {
    try {
      sanitizedExec(
        [
          'fetch',
          ...(shallow ? ['--depth=1'] : []),
          '--update-shallow',
          '--filter=blob:none',
          '--recurse-submodules=no',
          '--no-write-fetch-head',
          remoteName,
          headSha,
        ],
        { name: TELEMETRY_GIT_COMMAND, tags: { command: 'fetch_head_commit_sha' } },
        { name: TELEMETRY_GIT_COMMAND_MS, tags: { command: 'fetch_head_commit_sha' } },
        { name: TELEMETRY_GIT_COMMAND_ERRORS, tags: { command: 'fetch_head_commit_sha' } },
        true,
        { uncached: true, throwOnError: true, timeout: 5000, cwd }
      )
      return shallow
    } catch {
      // sanitizedExec records the failure; retry without a depth limit if the bounded fetch failed.
    }
  }
  return false
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
  hasLocalGitObject,
  fetchHeadCommitSha,
  getRepositoryRoot,
}
