const proxyquire = require('proxyquire')
const { expect } = require('chai')

const sanitizedExecStub = sinon.stub().returns('')
const gitRepoInfoStub = sinon.stub().returns({
  author: 'author <author@commit.com>',
  committer: 'committer <committer@commit.com>',
  authorDate: '1970',
  committerDate: '1971',
  commitMessage: 'commit message',
  branch: 'gitBranch',
  tag: 'gitTag',
  sha: 'gitSha'
})

const {
  getGitMetadata,
  GIT_COMMIT_SHA,
  GIT_BRANCH,
  GIT_TAG,
  GIT_REPOSITORY_URL,
  GIT_COMMIT_MESSAGE,
  GIT_COMMIT_COMMITTER_DATE,
  GIT_COMMIT_COMMITTER_EMAIL,
  GIT_COMMIT_COMMITTER_NAME,
  GIT_COMMIT_AUTHOR_DATE,
  GIT_COMMIT_AUTHOR_EMAIL,
  GIT_COMMIT_AUTHOR_NAME
} = proxyquire('../../../src/plugins/util/git',
  {
    './exec': {
      'sanitizedExec': sanitizedExecStub
    },
    '../../../../../vendor/git-repo-info': gitRepoInfoStub
  }
)

describe('git', () => {
  afterEach(() => {
    sanitizedExecStub.reset()
  })
  const commonGitMetadata = {
    [GIT_COMMIT_MESSAGE]: 'commit message',
    [GIT_COMMIT_COMMITTER_DATE]: '1971',
    [GIT_COMMIT_COMMITTER_EMAIL]: 'committer@commit.com',
    [GIT_COMMIT_COMMITTER_NAME]: 'committer',
    [GIT_COMMIT_AUTHOR_DATE]: '1970',
    [GIT_COMMIT_AUTHOR_EMAIL]: 'author@commit.com',
    [GIT_COMMIT_AUTHOR_NAME]: 'author',
    [GIT_TAG]: 'gitTag',
    [GIT_BRANCH]: 'gitBranch'
  }
  it('calls git when some ci metadata is not present', () => {
    const ciMetadata = { commitSHA: 'ciSHA' }
    const metadata = getGitMetadata(ciMetadata)

    expect(metadata).to.include(
      {
        [GIT_COMMIT_SHA]: 'ciSHA',
        ...commonGitMetadata
      }
    )
    expect(metadata[GIT_REPOSITORY_URL]).not.to.equal('ciRepositoryUrl')
    expect(sanitizedExecStub).to.have.been.calledWith('git ls-remote --get-url', { stdio: 'pipe' })
    expect(gitRepoInfoStub).to.have.been.called
  })
  it('returns ci metadata if present', () => {
    sanitizedExecStub.returns('')
    const ciMetadata = { commitSHA: 'ciSHA', branch: 'ciBranch', repositoryUrl: 'ciRepositoryUrl', tag: 'tag' }
    const metadata = getGitMetadata(ciMetadata)

    expect(metadata).to.eql(
      {
        ...commonGitMetadata,
        [GIT_COMMIT_SHA]: 'ciSHA',
        [GIT_BRANCH]: 'ciBranch',
        [GIT_REPOSITORY_URL]: 'ciRepositoryUrl',
        [GIT_TAG]: 'tag'
      }
    )
  })
  it('returns author from git executable', () => {
    sanitizedExecStub.returns('git author,git.author@email.com,1972')
    const ciMetadata = { repositoryUrl: 'ciRepositoryUrl' }
    const metadata = getGitMetadata(ciMetadata)
    expect(metadata).to.contain({
      [GIT_COMMIT_AUTHOR_EMAIL]: 'git.author@email.com',
      [GIT_COMMIT_AUTHOR_DATE]: '1972',
      [GIT_COMMIT_AUTHOR_NAME]: 'git author'
    })
  })
  it('returns author from parsing .git folder if git is not available', () => {
    gitRepoInfoStub.returns({
      author: 'author <>',
      committer: 'committer <committer@email.com>',
      authorDate: '1970',
      committerDate: '1971',
      commitMessage: 'commit message',
      branch: 'gitBranch',
      tag: 'gitTag',
      sha: 'gitSha'
    })
    sanitizedExecStub.returns('')
    const ciMetadata = { repositoryUrl: 'ciRepositoryUrl' }
    const metadata = getGitMetadata(ciMetadata)
    expect(metadata).to.contain({
      [GIT_COMMIT_AUTHOR_EMAIL]: '',
      [GIT_COMMIT_AUTHOR_DATE]: '1970',
      [GIT_COMMIT_AUTHOR_NAME]: 'author'
    })
  })
  it('returns committer from git executable', () => {
    sanitizedExecStub.returns('git committer,git.committer@email.com,1971')
    const ciMetadata = { repositoryUrl: 'ciRepositoryUrl' }
    const metadata = getGitMetadata(ciMetadata)
    expect(metadata).to.contain({
      [GIT_COMMIT_COMMITTER_EMAIL]: 'git.committer@email.com',
      [GIT_COMMIT_COMMITTER_DATE]: '1971',
      [GIT_COMMIT_COMMITTER_NAME]: 'git committer'
    })
  })
  it('returns committer from parsing .git folder if git is not available', () => {
    gitRepoInfoStub.returns({
      author: 'author <>',
      committer: 'committer <committer@email.com>',
      authorDate: '1970',
      committerDate: '1971',
      commitMessage: 'commit message',
      branch: 'gitBranch',
      tag: 'gitTag',
      sha: 'gitSha'
    })
    sanitizedExecStub.returns('')
    const ciMetadata = { repositoryUrl: 'ciRepositoryUrl' }
    const metadata = getGitMetadata(ciMetadata)
    expect(metadata).to.contain({
      [GIT_COMMIT_COMMITTER_EMAIL]: 'committer@email.com',
      [GIT_COMMIT_COMMITTER_DATE]: '1971',
      [GIT_COMMIT_COMMITTER_NAME]: 'committer'
    })
  })
  it('does not crash with badly shapen author or committer', () => {
    gitRepoInfoStub.returns({
      author: 'author <>',
      committer: undefined,
      authorDate: '1970',
      committerDate: '1971',
      commitMessage: 'commit message',
      branch: 'gitBranch',
      tag: 'gitTag',
      sha: 'gitSha'
    })
    sanitizedExecStub.returns('')
    const ciMetadata = { repositoryUrl: 'ciRepositoryUrl' }
    const metadata = getGitMetadata(ciMetadata)
    expect(metadata).to.contain({
      [GIT_COMMIT_COMMITTER_EMAIL]: '',
      [GIT_COMMIT_COMMITTER_DATE]: '1971',
      [GIT_COMMIT_COMMITTER_NAME]: '',
      [GIT_COMMIT_AUTHOR_EMAIL]: '',
      [GIT_COMMIT_AUTHOR_DATE]: '1970',
      [GIT_COMMIT_AUTHOR_NAME]: 'author'
    })
  })
  it('returns message from git executable', () => {
    gitRepoInfoStub.returns({
      commitMessage: 'other commit message'
    })
    sanitizedExecStub.returns('this is a commit message')
    const metadata = getGitMetadata({})
    expect(metadata).to.contain({
      [GIT_COMMIT_MESSAGE]: 'this is a commit message'
    })
  })
  it('returns message from .git folder if git is not available', () => {
    gitRepoInfoStub.returns({
      commitMessage: 'other commit message'
    })
    sanitizedExecStub.returns('')
    const metadata = getGitMetadata({})
    expect(metadata).to.contain({
      [GIT_COMMIT_MESSAGE]: 'other commit message'
    })
  })
  it('returns SHA from git executable', () => {
    gitRepoInfoStub.returns({
      sha: 'gitSHA'
    })
    sanitizedExecStub.returns('gitSHAFromGit')
    const metadata = getGitMetadata({})
    expect(metadata).to.contain({
      [GIT_COMMIT_SHA]: 'gitSHAFromGit'
    })
  })
  it('returns SHA from .git folder if git is not available', () => {
    gitRepoInfoStub.returns({
      commitMessage: 'gitSHA'
    })
    sanitizedExecStub.returns('')
    const metadata = getGitMetadata({})
    expect(metadata).to.contain({
      [GIT_COMMIT_MESSAGE]: 'gitSHA'
    })
  })
})
