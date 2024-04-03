const cp = require('child_process')
const os = require('os')
const path = require('path')
const fs = require('fs')

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
  CI_WORKSPACE_PATH
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

const GIT_REV_LIST_MAX_BUFFER = 12 * 1024 * 1024 // 12MB

function sanitizedExec (
  cmd,
  flags,
  operationMetric,
  durationMetric,
  errorMetric
) {
  const store = storage.getStore()
  storage.enterWith({ noop: true })

  let startTime
  if (operationMetric) {
    incrementCountMetric(operationMetric.name, operationMetric.tags)
  }
  if (durationMetric) {
    startTime = Date.now()
  }
  try {
    const result = cp.execFileSync(cmd, flags, { stdio: 'pipe' }).toString().replace(/(\r\n|\n|\r)/gm, '')
    if (durationMetric) {
      distributionMetric(durationMetric.name, durationMetric.tags, Date.now() - startTime)
    }
    return result
  } catch (err) {
    if (errorMetric) {
      incrementCountMetric(errorMetric.name, {
        ...errorMetric.tags,
        errorType: err.code,
        exitCode: err.status || err.errno
      })
    }
    log.error(err)
    return ''
  } finally {
    storage.enterWith(store)
  }
}

function isDirectory (path) {
  try {
    const stats = fs.statSync(path)
    return stats.isDirectory()
  } catch (e) {
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
      major: parseInt(gitVersionMatches[1]),
      minor: parseInt(gitVersionMatches[2]),
      patch: parseInt(gitVersionMatches[3])
    }
  } catch (e) {
    return null
  }
}

function unshallowRepository () {
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

  const baseGitOptions = [
    'fetch',
    '--shallow-since="1 month ago"',
    '--update-shallow',
    '--filter=blob:none',
    '--recurse-submodules=no',
    defaultRemoteName
  ]

  incrementCountMetric(TELEMETRY_GIT_COMMAND, { command: 'unshallow' })
  const start = Date.now()
  try {
    cp.execFileSync('git', [
      ...baseGitOptions,
      revParseHead
    ], { stdio: 'pipe' })
  } catch (err) {
    // If the local HEAD is a commit that has not been pushed to the remote, the above command will fail.
    log.error(err)
    incrementCountMetric(
      TELEMETRY_GIT_COMMAND_ERRORS,
      { command: 'unshallow', errorType: err.code, exitCode: err.status || err.errno }
    )
    const upstreamRemote = sanitizedExec('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
    try {
      cp.execFileSync('git', [
        ...baseGitOptions,
        upstreamRemote
      ], { stdio: 'pipe' })
    } catch (err) {
      // If the CI is working on a detached HEAD or branch tracking hasn’t been set up, the above command will fail.
      log.error(err)
      incrementCountMetric(
        TELEMETRY_GIT_COMMAND_ERRORS,
        { command: 'unshallow', errorType: err.code, exitCode: err.status || err.errno }
      )
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
    const result = cp.execFileSync('git', ['log', '--format=%H', '-n 1000', '--since="1 month ago"'], { stdio: 'pipe' })
      .toString()
      .split('\n')
      .filter(commit => commit)
    distributionMetric(TELEMETRY_GIT_COMMAND_MS, { command: 'get_local_commits' }, Date.now() - startTime)
    return result
  } catch (err) {
    log.error(`Get latest commits failed: ${err.message}`)
    incrementCountMetric(
      TELEMETRY_GIT_COMMAND_ERRORS,
      { command: 'get_local_commits', errorType: err.status }
    )
    return []
  }
}

function getCommitsRevList (commitsToExclude, commitsToInclude) {
  let result = null

  const commitsToExcludeString = commitsToExclude.map(commit => `^${commit}`)

  incrementCountMetric(TELEMETRY_GIT_COMMAND, { command: 'get_objects' })
  const startTime = Date.now()
  try {
    result = cp.execFileSync(
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
      .filter(commit => commit)
  } catch (err) {
    log.error(`Get commits to upload failed: ${err.message}`)
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
    log.error(new Error('Provided path to generate packfiles is not a directory'))
    return []
  }

  const randomPrefix = String(Math.floor(Math.random() * 10000))
  const temporaryPath = path.join(tmpFolder, randomPrefix)
  const cwdPath = path.join(process.cwd(), randomPrefix)

  incrementCountMetric(TELEMETRY_GIT_COMMAND, { command: 'pack_objects' })
  const startTime = Date.now()
  // Generates pack files to upload and
  // returns the ordered list of packfiles' paths
  function execGitPackObjects (targetPath) {
    return cp.execFileSync(
      'git',
      [
        'pack-objects',
        '--compression=9',
        '--max-pack-size=3m',
        targetPath
      ],
      { stdio: 'pipe', input: commitsToUpload.join('\n') }
    ).toString().split('\n').filter(commit => commit).map(commit => `${targetPath}-${commit}.pack`)
  }

  try {
    result = execGitPackObjects(temporaryPath)
  } catch (err) {
    log.error(err)
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
      log.error(err)
      incrementCountMetric(
        TELEMETRY_GIT_COMMAND_ERRORS,
        { command: 'pack_objects', exitCode: err.status || err.errno, errorType: err.code }
      )
    }
  }
  distributionMetric(TELEMETRY_GIT_COMMAND_MS, { command: 'pack_objects' }, Date.now() - startTime)

  return result
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
    ciWorkspacePath
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

  return {
    [GIT_REPOSITORY_URL]:
      filterSensitiveInfoFromRepository(repositoryUrl || sanitizedExec('git', ['ls-remote', '--get-url'])),
    [GIT_COMMIT_MESSAGE]:
      commitMessage || sanitizedExec('git', ['show', '-s', '--format=%s']),
    [GIT_COMMIT_AUTHOR_DATE]: authorDate,
    [GIT_COMMIT_AUTHOR_NAME]: ciAuthorName || authorName,
    [GIT_COMMIT_AUTHOR_EMAIL]: ciAuthorEmail || authorEmail,
    [GIT_COMMIT_COMMITTER_DATE]: committerDate,
    [GIT_COMMIT_COMMITTER_NAME]: committerName,
    [GIT_COMMIT_COMMITTER_EMAIL]: committerEmail,
    [GIT_BRANCH]: branch || sanitizedExec('git', ['rev-parse', '--abbrev-ref', 'HEAD']),
    [GIT_COMMIT_SHA]: commitSHA || sanitizedExec('git', ['rev-parse', 'HEAD']),
    [GIT_TAG]: tag,
    [CI_WORKSPACE_PATH]: ciWorkspacePath || sanitizedExec('git', ['rev-parse', '--show-toplevel'])
  }
}

module.exports = {
  getGitMetadata,
  getLatestCommits,
  getRepositoryUrl,
  generatePackFilesForCommits,
  getCommitsRevList,
  GIT_REV_LIST_MAX_BUFFER,
  isShallowRepository,
  unshallowRepository
}
