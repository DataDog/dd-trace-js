const coalesce = require('koalas')
const getRepoInfo = require('../../../../../vendor/git-repo-info')

const { sanitizedExec } = require('./exec')

const GIT_COMMIT_SHA = 'git.commit.sha'
const GIT_BRANCH = 'git.branch'
const GIT_REPOSITORY_URL = 'git.repository_url'
const GIT_TAG = 'git.tag'
const GIT_COMMIT_MESSAGE = 'git.commit.message'
const GIT_COMMIT_COMMITTER_DATE = 'git.commit.committer.date'
const GIT_COMMIT_COMMITTER_EMAIL = 'git.commit.committer.email'
const GIT_COMMIT_COMMITTER_NAME = 'git.commit.committer.name'
const GIT_COMMIT_AUTHOR_DATE = 'git.commit.author.date'
const GIT_COMMIT_AUTHOR_EMAIL = 'git.commit.author.email'
const GIT_COMMIT_AUTHOR_NAME = 'git.commit.author.name'

// Receives a string with the form 'John Doe <john.doe@gmail.com>'
// and returns { name: 'John Doe', email: 'john.doe@gmail.com' }
function parseUser (user) {
  if (!user) {
    return { name: '', email: '' }
  }
  let email = ''
  const matchEmail = user.match(/[^@<\s]+@[^@\s>]+/g)
  if (matchEmail) {
    email = matchEmail[0]
  }
  return { name: user.replace(`<${email}>`, '').trim(), email }
}

// If there is ciMetadata, it takes precedence.
function getGitMetadata (ciMetadata) {
  const { commitSHA, branch, repositoryUrl, tag } = ciMetadata

  const {
    author,
    committer,
    authorDate,
    committerDate,
    commitMessage,
    branch: gitBranch,
    tag: gitTag,
    sha: gitCommitSHA
  } = getRepoInfo(process.cwd())

  const { name: authorName, email: authorEmail } = parseUser(author)
  const { name: committerName, email: committerEmail } = parseUser(committer)

  return {
    // With stdio: 'pipe', errors in this command will not be output to the parent process,
    // so if `git` is not present in the env, we won't show a warning to the user.
    [GIT_REPOSITORY_URL]: repositoryUrl || sanitizedExec('git ls-remote --get-url', { stdio: 'pipe' }),
    [GIT_BRANCH]: coalesce(branch, gitBranch),
    [GIT_COMMIT_SHA]: coalesce(commitSHA, gitCommitSHA),
    [GIT_TAG]: coalesce(tag, gitTag),
    [GIT_COMMIT_MESSAGE]: commitMessage,
    [GIT_COMMIT_AUTHOR_DATE]: authorDate,
    [GIT_COMMIT_AUTHOR_NAME]: authorName,
    [GIT_COMMIT_AUTHOR_EMAIL]: authorEmail,
    [GIT_COMMIT_COMMITTER_DATE]: committerDate,
    [GIT_COMMIT_COMMITTER_NAME]: committerName,
    [GIT_COMMIT_COMMITTER_EMAIL]: committerEmail
  }
}

module.exports = {
  getGitMetadata,
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
  GIT_COMMIT_AUTHOR_NAME
}
