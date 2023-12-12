const { execFileSync } = require('child_process')
const os = require('os')
const path = require('path')
const fs = require('fs')

const log = require('../../log')
const { sanitizedExec } = require('./exec')
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
const { filterSensitiveInfoFromRepository } = require('./url')

const GIT_REV_LIST_MAX_BUFFER = 8 * 1024 * 1024 // 8MB

function isDirectory (path) {
  try {
    const stats = fs.statSync(path)
    return stats.isDirectory()
  } catch (e) {
    return false
  }
}

function isShallowRepository () {
  return sanitizedExec('git', ['rev-parse', '--is-shallow-repository']) === 'true'
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

  try {
    execFileSync('git', [
      ...baseGitOptions,
      revParseHead
    ], { stdio: 'pipe' })
  } catch (e) {
    // If the local HEAD is a commit that has not been pushed to the remote, the above command will fail.
    log.error(e)
    const upstreamRemote = sanitizedExec('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
    try {
      execFileSync('git', [
        ...baseGitOptions,
        upstreamRemote
      ], { stdio: 'pipe' })
    } catch (e) {
      // If the CI is working on a detached HEAD or branch tracking hasn’t been set up, the above command will fail.
      log.error(e)
      // We use sanitizedExec here because if this last option fails, we'll give up.
      sanitizedExec('git', baseGitOptions)
    }
  }
}

function getRepositoryUrl () {
  return sanitizedExec('git', ['config', '--get', 'remote.origin.url'])
}

function getLatestCommits () {
  try {
    return execFileSync('git', ['log', '--format=%H', '-n 1000', '--since="1 month ago"'], { stdio: 'pipe' })
      .toString()
      .split('\n')
      .filter(commit => commit)
  } catch (err) {
    log.error(`Get latest commits failed: ${err.message}`)
    return []
  }
}

function getCommitsRevList (commitsToExclude, commitsToInclude) {
  const commitsToExcludeString = commitsToExclude.map(commit => `^${commit}`)

  try {
    return execFileSync(
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
    return []
  }
}

function generatePackFilesForCommits (commitsToUpload) {
  const tmpFolder = os.tmpdir()

  if (!isDirectory(tmpFolder)) {
    log.error(new Error('Provided path to generate packfiles is not a directory'))
    return []
  }

  const randomPrefix = String(Math.floor(Math.random() * 10000))
  const temporaryPath = path.join(tmpFolder, randomPrefix)
  const cwdPath = path.join(process.cwd(), randomPrefix)

  // Generates pack files to upload and
  // returns the ordered list of packfiles' paths
  function execGitPackObjects (targetPath) {
    return execFileSync(
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
    return execGitPackObjects(temporaryPath)
  } catch (err) {
    log.error(err)
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
      return execGitPackObjects(cwdPath)
    } catch (err) {
      log.error(err)
    }

    return []
  }
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
