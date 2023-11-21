'use strict'

require('../../setup/tap')

const { execSync } = require('child_process')
const os = require('os')
const fs = require('fs')
const path = require('path')

const { GIT_REV_LIST_MAX_BUFFER } = require('../../../src/plugins/util/git')
const proxyquire = require('proxyquire')
const sanitizedExecStub = sinon.stub().returns('')
const execFileSyncStub = sinon.stub().returns('')

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

const { getGitMetadata, unshallowRepository } = proxyquire('../../../src/plugins/util/git',
  {
    './exec': {
      sanitizedExec: sanitizedExecStub
    },
    'child_process': {
      execFileSync: execFileSyncStub
    }
  }
)

function getFakeDirectory () {
  if (os.platform() === 'win32') {
    return `C:${path.sep}tmp`
  }
  return '/tmp'
}

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
    expect(sanitizedExecStub).to.have.been.calledWith('git', ['ls-remote', '--get-url'])
    expect(sanitizedExecStub).to.have.been.calledWith('git', ['show', '-s', '--format=%an,%ae,%aI,%cn,%ce,%cI'])
    expect(sanitizedExecStub).not.to.have.been.calledWith('git', ['show', '-s', '--format=%s'])
    expect(sanitizedExecStub).not.to.have.been.calledWith('git', ['rev-parse', 'HEAD'])
    expect(sanitizedExecStub).not.to.have.been.calledWith('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
    expect(sanitizedExecStub).not.to.have.been.calledWith('git', ['rev-parse', '--show-toplevel'])
  })
  it('does not crash if git is not available', () => {
    sanitizedExecStub.returns('')
    const ciMetadata = { repositoryUrl: 'https://github.com/datadog/safe-repository.git' }
    const metadata = getGitMetadata(ciMetadata)
    expect(metadata).to.eql({
      [GIT_BRANCH]: '',
      [GIT_TAG]: undefined,
      [GIT_COMMIT_MESSAGE]: '',
      [GIT_COMMIT_SHA]: '',
      [GIT_REPOSITORY_URL]: 'https://github.com/datadog/safe-repository.git',
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
      .onCall(1).returns('https://github.com/datadog/safe-repository.git')
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
      [GIT_REPOSITORY_URL]: 'https://github.com/datadog/safe-repository.git',
      [GIT_COMMIT_AUTHOR_EMAIL]: 'git.author@email.com',
      [GIT_COMMIT_AUTHOR_DATE]: '2022-02-14T16:22:03-05:00',
      [GIT_COMMIT_AUTHOR_NAME]: 'git author',
      [GIT_COMMIT_COMMITTER_EMAIL]: 'git.committer@email.com',
      [GIT_COMMIT_COMMITTER_DATE]: '2022-02-14T16:23:03-05:00',
      [GIT_COMMIT_COMMITTER_NAME]: 'git committer',
      [CI_WORKSPACE_PATH]: 'ciWorkspacePath'
    })
    expect(sanitizedExecStub).to.have.been.calledWith('git', ['ls-remote', '--get-url'])
    expect(sanitizedExecStub).to.have.been.calledWith('git', ['show', '-s', '--format=%s'])
    expect(sanitizedExecStub).to.have.been.calledWith('git', ['show', '-s', '--format=%an,%ae,%aI,%cn,%ce,%cI'])
    expect(sanitizedExecStub).to.have.been.calledWith('git', ['rev-parse', 'HEAD'])
    expect(sanitizedExecStub).to.have.been.calledWith('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
    expect(sanitizedExecStub).to.have.been.calledWith('git', ['rev-parse', '--show-toplevel'])
  })
})

describe('getCommitsToUpload', () => {
  it('gets the commits to upload if the repository is smaller than the limit', () => {
    const logErrorSpy = sinon.spy()

    const { getCommitsToUpload } = proxyquire('../../../src/plugins/util/git',
      {
        'child_process': {
          'execFileSync': (command, flags, options) =>
            execSync(`head -c ${Math.floor(GIT_REV_LIST_MAX_BUFFER * 0.9)} /dev/zero`, options)
        },
        '../../log': {
          error: logErrorSpy
        }
      }
    )
    getCommitsToUpload([], [])
    expect(logErrorSpy).not.to.have.been.called
  })

  it('does not crash and logs the error if the repository is bigger than the limit', () => {
    const logErrorSpy = sinon.spy()

    const { getCommitsToUpload } = proxyquire('../../../src/plugins/util/git',
      {
        'child_process': {
          'execFileSync': (command, flags, options) =>
            execSync(`head -c ${GIT_REV_LIST_MAX_BUFFER * 2} /dev/zero`, options)
        },
        '../../log': {
          error: logErrorSpy
        }
      }
    )
    const commitsToUpload = getCommitsToUpload([], [])
    expect(logErrorSpy).to.have.been.called
    expect(commitsToUpload.length).to.equal(0)
  })
})

describe('generatePackFilesForCommits', () => {
  let tmpdirStub, statSyncStub
  const fakeDirectory = getFakeDirectory()
  beforeEach(() => {
    sinon.stub(Math, 'random').returns('0.1234')
    tmpdirStub = sinon.stub(os, 'tmpdir').returns(fakeDirectory)
    sinon.stub(process, 'cwd').returns('cwd')
    statSyncStub = sinon.stub(fs, 'statSync').returns({ isDirectory: () => true })
  })
  afterEach(() => {
    sinon.restore()
  })
  it('creates pack files in temporary path', () => {
    const execFileSyncSpy = sinon.stub().returns(['commitSHA'])

    const { generatePackFilesForCommits } = proxyquire('../../../src/plugins/util/git',
      {
        'child_process': {
          'execFileSync': execFileSyncSpy
        }
      }
    )

    const temporaryPath = path.join(fakeDirectory, '1234')
    const packFilesToUpload = generatePackFilesForCommits(['commitSHA'])
    expect(packFilesToUpload).to.eql([`${temporaryPath}-commitSHA.pack`])
  })

  it('creates pack files in cwd if the temporary path fails', () => {
    const execFileSyncSpy = sinon.stub().onCall(0).throws().onCall(1).returns(['commitSHA'])

    const cwdPath = path.join('cwd', '1234')

    const { generatePackFilesForCommits } = proxyquire('../../../src/plugins/util/git',
      {
        'child_process': {
          'execFileSync': execFileSyncSpy
        }
      }
    )

    const packFilesToUpload = generatePackFilesForCommits(['commitSHA'])
    expect(packFilesToUpload).to.eql([`${cwdPath}-commitSHA.pack`])
  })

  it('does not work if tmpdir does not return a folder', () => {
    tmpdirStub.restore()
    statSyncStub.restore()
    sinon.stub(os, 'tmpdir').returns('; echo hey')
    const execFileSyncSpy = sinon.stub().onCall(0).throws().onCall(1).returns(['commitSHA'])

    const { generatePackFilesForCommits } = proxyquire('../../../src/plugins/util/git',
      {
        'child_process': {
          'execFileSync': execFileSyncSpy
        }
      }
    )
    const packFilesToUpload = generatePackFilesForCommits(['commitSHA'])
    expect(packFilesToUpload).to.eql([])
  })
})

describe('unshallowRepository', () => {
  afterEach(() => {
    sanitizedExecStub.reset()
    execFileSyncStub.reset()
  })
  it('works for the usual case', () => {
    sanitizedExecStub
      .onCall(0).returns(
        'git version 2.39.0'
      )
      .onCall(1).returns('origin')
      .onCall(2).returns('daede5785233abb1a3cb76b9453d4eb5b98290b3')

    const options = [
      'fetch',
      '--shallow-since="1 month ago"',
      '--update-shallow',
      '--filter=blob:none',
      '--recurse-submodules=no',
      'origin',
      'daede5785233abb1a3cb76b9453d4eb5b98290b3'
    ]

    unshallowRepository()
    expect(execFileSyncStub).to.have.been.calledWith('git', options)
  })
  it('works if the local HEAD is a commit that has not been pushed to the remote', () => {
    sanitizedExecStub
      .onCall(0).returns(
        'git version 2.39.0'
      )
      .onCall(1).returns('origin')
      .onCall(2).returns('daede5785233abb1a3cb76b9453d4eb5b98290b3')
      .onCall(3).returns('origin/master')

    execFileSyncStub
      .onCall(0).throws()

    const options = [
      'fetch',
      '--shallow-since="1 month ago"',
      '--update-shallow',
      '--filter=blob:none',
      '--recurse-submodules=no',
      'origin',
      'origin/master'
    ]

    unshallowRepository()
    expect(execFileSyncStub).to.have.been.calledWith('git', options)
  })
  it('works if the CI is working on a detached HEAD or branch tracking hasn’t been set up', () => {
    sanitizedExecStub
      .onCall(0).returns(
        'git version 2.39.0'
      )
      .onCall(1).returns('origin')
      .onCall(2).returns('daede5785233abb1a3cb76b9453d4eb5b98290b3')
      .onCall(3).returns('origin/master')

    execFileSyncStub
      .onCall(0).throws()
      .onCall(1).throws()

    const options = [
      'fetch',
      '--shallow-since="1 month ago"',
      '--update-shallow',
      '--filter=blob:none',
      '--recurse-submodules=no',
      'origin'
    ]

    unshallowRepository()
    expect(sanitizedExecStub).to.have.been.calledWith('git', options)
  })
})

describe('user credentials', () => {
  afterEach(() => {
    sanitizedExecStub.reset()
    execFileSyncStub.reset()
  })
  it('scrubs https user credentials', () => {
    sanitizedExecStub
      .onCall(0).returns(
        'git author,git.author@email.com,2022-02-14T16:22:03-05:00,' +
        'git committer,git.committer@email.com,2022-02-14T16:23:03-05:00'
      )
      .onCall(1).returns('https://x-oauth-basic:ghp_safe_characters@github.com/datadog/safe-repository.git')

    const metadata = getGitMetadata({})
    expect(metadata[GIT_REPOSITORY_URL])
      .to.equal('https://github.com/datadog/safe-repository.git')
  })
  it('scrubs ssh user credentials', () => {
    sanitizedExecStub
      .onCall(0).returns(
        'git author,git.author@email.com,2022-02-14T16:22:03-05:00,' +
        'git committer,git.committer@email.com,2022-02-14T16:23:03-05:00'
      )
      .onCall(1).returns('ssh://username@host.xz:port/path/to/repo.git/')

    const metadata = getGitMetadata({})
    expect(metadata[GIT_REPOSITORY_URL])
      .to.equal('ssh://host.xz:port/path/to/repo.git/')
  })
})
