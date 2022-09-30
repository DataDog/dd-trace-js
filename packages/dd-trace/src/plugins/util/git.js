const { execSync } = require('child_process')
const os = require('os')

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

const GIT_REV_LIST_MAX_BUFFER = 8 * 1024 * 1024 // 8MB

function getRepositoryUrl () {
  return sanitizedExec('git config --get remote.origin.url', { stdio: 'pipe' })
}

function getLatestCommits () {
  try {
    return execSync('git log --format=%H -n 1000 --since="1 month ago"', { stdio: 'pipe' })
      .toString()
      .split('\n')
      .filter(commit => commit)
  } catch (err) {
    log.error(err)
    return []
  }
}

function getCommitsToUpload (commitsToExclude) {
  let gitCommandToGetCommitsToUpload =
    'git rev-list --objects --no-object-names --filter=blob:none --since="1 month ago" HEAD'

  commitsToExclude.forEach(commit => {
    gitCommandToGetCommitsToUpload = `${gitCommandToGetCommitsToUpload} ^${commit}`
  })

  try {
    return execSync(gitCommandToGetCommitsToUpload, { stdio: 'pipe', maxBuffer: GIT_REV_LIST_MAX_BUFFER })
      .toString()
      .split('\n')
      .filter(commit => commit)
  } catch (err) {
    log.error(err)
    return []
  }
}

// Generates pack files to upload and
// returns the ordered list of packfiles' paths
function generatePackFilesForCommits (commitsToUpload) {
  const tmpFolder = os.tmpdir()

  const prefix = Math.floor(Math.random() * 10000)
  const path = `${tmpFolder}/${prefix}`

  const orderedCommits =
    execSync(
      `git pack-objects --compression=9 --max-pack-size=3m ${path}`,
      { input: commitsToUpload.join('\n') }
    ).toString().split('\n').filter(commit => !!commit)

  return orderedCommits.map(commit => `${path}-${commit}.pack`)
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
  ] = sanitizedExec('git show -s --format=%an,%ae,%aI,%cn,%ce,%cI', { stdio: 'pipe' }).split(',')

  return {
    [GIT_REPOSITORY_URL]:
      repositoryUrl || sanitizedExec('git ls-remote --get-url', { stdio: 'pipe' }),
    [GIT_COMMIT_MESSAGE]:
      commitMessage || sanitizedExec('git show -s --format=%s', { stdio: 'pipe' }),
    [GIT_COMMIT_AUTHOR_DATE]: authorDate,
    [GIT_COMMIT_AUTHOR_NAME]: ciAuthorName || authorName,
    [GIT_COMMIT_AUTHOR_EMAIL]: ciAuthorEmail || authorEmail,
    [GIT_COMMIT_COMMITTER_DATE]: committerDate,
    [GIT_COMMIT_COMMITTER_NAME]: committerName,
    [GIT_COMMIT_COMMITTER_EMAIL]: committerEmail,
    [GIT_BRANCH]: branch || sanitizedExec('git rev-parse --abbrev-ref HEAD', { stdio: 'pipe' }),
    [GIT_COMMIT_SHA]: commitSHA || sanitizedExec('git rev-parse HEAD', { stdio: 'pipe' }),
    [GIT_TAG]: tag,
    [CI_WORKSPACE_PATH]: ciWorkspacePath || sanitizedExec('git rev-parse --show-toplevel', { stdio: 'pipe' })
  }
}

module.exports = {
  getGitMetadata,
  getLatestCommits,
  getRepositoryUrl,
  generatePackFilesForCommits,
  getCommitsToUpload
}
