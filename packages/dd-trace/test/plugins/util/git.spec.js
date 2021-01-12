const childProcess = require('child_process')

const { getGitMetadata, GIT_COMMIT_SHA, GIT_BRANCH, GIT_REPOSITORY_URL } = require('../../../src/plugins/util/git')

describe('git', () => {
  beforeEach(() => {
    sinon.spy(childProcess, 'execSync')
  })
  afterEach(() => {
    childProcess.execSync.restore()
  })
  it('returns ci metadata if present and does not call git', () => {
    const ciMetadata = { commitSHA: 'ciSHA', branch: 'ciBranch', repositoryUrl: 'ciRepositoryUrl' }
    const metadata = getGitMetadata(ciMetadata)

    expect(metadata).to.eql(
      { [GIT_COMMIT_SHA]: 'ciSHA', [GIT_BRANCH]: 'ciBranch', [GIT_REPOSITORY_URL]: 'ciRepositoryUrl' }
    )
    expect(childProcess.execSync).not.to.have.been.called
  })
  it('calls git when some ci metadata is not present', () => {
    const ciMetadata = { commitSHA: 'ciSHA', branch: 'ciBranch' }
    const metadata = getGitMetadata(ciMetadata)

    expect(metadata).to.eql(
      {
        [GIT_COMMIT_SHA]: 'ciSHA',
        [GIT_BRANCH]: 'ciBranch',
        [GIT_REPOSITORY_URL]: 'git@github.com:DataDog/dd-trace-js.git'
      }
    )
    expect(childProcess.execSync).to.have.been.calledWith('git ls-remote --get-url', { stdio: 'pipe' })
  })
})
