const { execSync } = require('child_process')
const os = require('os')

const { GIT_REV_LIST_MAX_BUFFER } = require('../../../src/plugins/util/git')
const proxyquire = require('proxyquire')
const sanitizedExecStub = sinon.stub().returns('')

const {
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
  GIT_COMMIT_AUTHOR_NAME,
  CI_WORKSPACE_PATH
} = require('../../../src/plugins/util/tags')

const { getGitMetadata } = proxyquire('../../../src/plugins/util/git',
  {
    './exec': {
      'sanitizedExec': sanitizedExecStub
    }
  }
)

describe('git', () => {
  afterEach(() => {
    sanitizedExecStub.reset()
    delete process.env.DD_GIT_COMMIT_SHA
    delete process.env.DD_GIT_REPOSITORY_URL
    delete process.env.DD_GIT_BRANCH
    delete process.env.DD_GIT_TAG
    delete process.env.DD_GIT_COMMIT_MESSAGE
    delete process.env.DD_GIT_COMMIT_AUTHOR_NAME
    delete process.env.DD_GIT_COMMIT_AUTHOR_EMAIL
    delete process.env.DD_GIT_COMMIT_AUTHOR_DATE
    delete process.env.DD_GIT_COMMIT_COMMITTER_NAME
    delete process.env.DD_GIT_COMMIT_COMMITTER_EMAIL
    delete process.env.DD_GIT_COMMIT_COMMITTER_DATE
  })
  it('returns ci metadata if it is present and does not call git for those parameters', () => {
    const ciMetadata = {
      commitSHA: 'ciSHA',
      branch: 'myBranch',
      commitMessage: 'myCommitMessage',
      authorName: 'ciAuthorName',
      ciWorkspacePath: 'ciWorkspacePath'
    }
    const metadata = getGitMetadata(ciMetadata)

    expect(metadata).to.contain(
      {
        [GIT_COMMIT_SHA]: 'ciSHA',
        [GIT_BRANCH]: 'myBranch',
        [GIT_COMMIT_MESSAGE]: 'myCommitMessage',
        [GIT_COMMIT_AUTHOR_NAME]: 'ciAuthorName',
        [CI_WORKSPACE_PATH]: 'ciWorkspacePath'
      }
    )
    expect(metadata[GIT_REPOSITORY_URL]).not.to.equal('ciRepositoryUrl')
    expect(sanitizedExecStub).to.have.been.calledWith('git ls-remote --get-url', { stdio: 'pipe' })
    expect(sanitizedExecStub).to.have.been.calledWith('git show -s --format=%an,%ae,%aI,%cn,%ce,%cI', { stdio: 'pipe' })
    expect(sanitizedExecStub).not.to.have.been.calledWith('git show -s --format=%s', { stdio: 'pipe' })
    expect(sanitizedExecStub).not.to.have.been.calledWith('git rev-parse HEAD', { stdio: 'pipe' })
    expect(sanitizedExecStub).not.to.have.been.calledWith('git rev-parse --abbrev-ref HEAD', { stdio: 'pipe' })
    expect(sanitizedExecStub).not.to.have.been.calledWith('git rev-parse --show-toplevel', { stdio: 'pipe' })
  })
  it('does not crash if git is not available', () => {
    sanitizedExecStub.returns('')
    const ciMetadata = { repositoryUrl: 'ciRepositoryUrl' }
    const metadata = getGitMetadata(ciMetadata)
    expect(metadata).to.eql({
      [GIT_BRANCH]: '',
      [GIT_TAG]: undefined,
      [GIT_COMMIT_MESSAGE]: '',
      [GIT_COMMIT_SHA]: '',
      [GIT_REPOSITORY_URL]: 'ciRepositoryUrl',
      [GIT_COMMIT_COMMITTER_EMAIL]: undefined,
      [GIT_COMMIT_COMMITTER_DATE]: undefined,
      [GIT_COMMIT_COMMITTER_NAME]: undefined,
      [GIT_COMMIT_AUTHOR_EMAIL]: undefined,
      [GIT_COMMIT_AUTHOR_DATE]: undefined,
      [GIT_COMMIT_AUTHOR_NAME]: '',
      [CI_WORKSPACE_PATH]: ''
    })
  })
  it('returns all git metadata is git is available', () => {
    sanitizedExecStub
      .onCall(0).returns(
        'git author,git.author@email.com,2022-02-14T16:22:03-05:00,' +
        'git committer,git.committer@email.com,2022-02-14T16:23:03-05:00'
      )
      .onCall(1).returns('gitRepositoryUrl')
      .onCall(2).returns('this is a commit message')
      .onCall(3).returns('gitBranch')
      .onCall(4).returns('gitCommitSHA')
      .onCall(5).returns('ciWorkspacePath')

    const metadata = getGitMetadata({ tag: 'ciTag' })
    expect(metadata).to.eql({
      [GIT_BRANCH]: 'gitBranch',
      [GIT_TAG]: 'ciTag',
      [GIT_COMMIT_MESSAGE]: 'this is a commit message',
      [GIT_COMMIT_SHA]: 'gitCommitSHA',
      [GIT_REPOSITORY_URL]: 'gitRepositoryUrl',
      [GIT_COMMIT_AUTHOR_EMAIL]: 'git.author@email.com',
      [GIT_COMMIT_AUTHOR_DATE]: '2022-02-14T16:22:03-05:00',
      [GIT_COMMIT_AUTHOR_NAME]: 'git author',
      [GIT_COMMIT_COMMITTER_EMAIL]: 'git.committer@email.com',
      [GIT_COMMIT_COMMITTER_DATE]: '2022-02-14T16:23:03-05:00',
      [GIT_COMMIT_COMMITTER_NAME]: 'git committer',
      [CI_WORKSPACE_PATH]: 'ciWorkspacePath'
    })
    expect(sanitizedExecStub).to.have.been.calledWith('git ls-remote --get-url', { stdio: 'pipe' })
    expect(sanitizedExecStub).to.have.been.calledWith('git show -s --format=%s', { stdio: 'pipe' })
    expect(sanitizedExecStub).to.have.been.calledWith('git show -s --format=%an,%ae,%aI,%cn,%ce,%cI', { stdio: 'pipe' })
    expect(sanitizedExecStub).to.have.been.calledWith('git rev-parse HEAD', { stdio: 'pipe' })
    expect(sanitizedExecStub).to.have.been.calledWith('git rev-parse --abbrev-ref HEAD', { stdio: 'pipe' })
    expect(sanitizedExecStub).to.have.been.calledWith('git rev-parse --show-toplevel', { stdio: 'pipe' })
  })
})

describe('getCommitsToUpload', () => {
  it('gets the commits to upload if the repository is smaller than the limit', () => {
    const logErrorSpy = sinon.spy()

    const { getCommitsToUpload } = proxyquire('../../../src/plugins/util/git',
      {
        'child_process': {
          'execSync': (_, ...rest) =>
            execSync(`head -c ${Math.floor(GIT_REV_LIST_MAX_BUFFER * 0.9)} /dev/zero`, ...rest)
        },
        '../../log': {
          error: logErrorSpy
        }
      }
    )
    getCommitsToUpload([])
    expect(logErrorSpy).not.to.have.been.called
  })

  it('does not crash and logs the error if the repository is bigger than the limit', () => {
    const logErrorSpy = sinon.spy()

    const { getCommitsToUpload } = proxyquire('../../../src/plugins/util/git',
      {
        'child_process': {
          'execSync': (_, ...rest) => execSync(`head -c ${GIT_REV_LIST_MAX_BUFFER * 2} /dev/zero`, ...rest)
        },
        '../../log': {
          error: logErrorSpy
        }
      }
    )
    const commitsToUpload = getCommitsToUpload([])
    expect(logErrorSpy).to.have.been.called
    expect(commitsToUpload.length).to.equal(0)
  })
})

describe('generatePackFilesForCommits', () => {
  after(() => {
    sinon.restore()
  })
  it('calls git pack-objects', () => {
    const execSyncSpy = sinon.stub().returns(['commitSHA'])

    sinon.stub(Math, 'random').returns('0.1234')
    sinon.stub(os, 'tmpdir').returns('/tmp')

    const { generatePackFilesForCommits } = proxyquire('../../../src/plugins/util/git',
      {
        'child_process': {
          'execSync': execSyncSpy
        }
      }
    )
    const packFilesToUpload = generatePackFilesForCommits(['commitSHA'])
    expect(execSyncSpy).to.have.been
      .calledWith(`git pack-objects --compression=9 --max-pack-size=3m /tmp/1234`, { input: 'commitSHA' })
    expect(packFilesToUpload).to.eql(['/tmp/1234-commitSHA.pack'])
  })
})
