'use strict'

const { expect } = require('chai')
const { describe, it, afterEach, beforeEach } = require('tap').mocha
const sinon = require('sinon')
const proxyquire = require('proxyquire')
const { execSync } = require('node:child_process')
const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')

require('../../setup/core')

const { GIT_REV_LIST_MAX_BUFFER, isGitAvailable } = require('../../../src/plugins/util/git')
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
  CI_WORKSPACE_PATH,
  GIT_COMMIT_HEAD_MESSAGE,
  GIT_COMMIT_HEAD_AUTHOR_DATE,
  GIT_COMMIT_HEAD_AUTHOR_EMAIL,
  GIT_COMMIT_HEAD_AUTHOR_NAME,
  GIT_COMMIT_HEAD_COMMITTER_DATE,
  GIT_COMMIT_HEAD_COMMITTER_EMAIL,
  GIT_COMMIT_HEAD_COMMITTER_NAME
} = require('../../../src/plugins/util/tags')

const { getGitMetadata, unshallowRepository, getGitDiff } = proxyquire('../../../src/plugins/util/git',
  {
    child_process: {
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
    execFileSyncStub.reset()
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
      ciWorkspacePath: 'ciWorkspacePath',
      headCommitSha: 'headCommitSha'
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
    expect(execFileSyncStub).to.have.been.calledWith('git', ['ls-remote', '--get-url'])
    expect(execFileSyncStub).to.have.been.calledWith('git', ['show', '-s', '--format=%an,%ae,%aI,%cn,%ce,%cI'])
    expect(execFileSyncStub).not.to.have.been.calledWith('git', ['show', '-s', '--format=%B'])
    expect(execFileSyncStub).not.to.have.been.calledWith('git', ['rev-parse', 'HEAD'])
    expect(execFileSyncStub).not.to.have.been.calledWith('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
    expect(execFileSyncStub).not.to.have.been.calledWith('git', ['rev-parse', '--show-toplevel'])
    expect(execFileSyncStub).to.have.been.calledWith(
      'git',
      ['show', '-s', '--format=\'%H","%aI","%an","%ae","%cI","%cn","%ce","%B\'', ciMetadata.headCommitSha]
    )
  })

  it('does not crash if git is not available', () => {
    execFileSyncStub.returns('')
    const ciMetadata = { repositoryUrl: 'https://github.com/datadog/safe-repository.git' }
    const metadata = getGitMetadata(ciMetadata)

    expect(metadata).to.eql({
      [GIT_BRANCH]: '',
      [GIT_COMMIT_MESSAGE]: '',
      [GIT_COMMIT_SHA]: '',
      [GIT_REPOSITORY_URL]: 'https://github.com/datadog/safe-repository.git',
      [CI_WORKSPACE_PATH]: ''
    })
  })

  it('returns all git metadata is git is available', () => {
    const commitMessage = `multi line
      commit message`
    const headCommitMessage = `multi line
      head commit message`

    execFileSyncStub
      .onCall(0).returns(
        'git author,git.author@email.com,2022-02-14T16:22:03-05:00,' +
        'git committer,git.committer@email.com,2022-02-14T16:23:03-05:00'
      )
      .onCall(1).returns(commitMessage)
      .onCall(2).returns('gitBranch')
      .onCall(3).returns('gitCommitSHA')
      .onCall(4).returns('ciWorkspacePath')
      .onCall(5).returns(false)
      .onCall(6).returns(
        'headCommitSha",' +
        '"2022-02-14T16:22:03-05:00","git head author","git.head.author@email.com",' +
        '"2022-02-14T16:23:03-05:00","git head committer","git.head.committer@email.com",' +
        '"' + headCommitMessage
      )
      .onCall(7).returns('https://github.com/datadog/safe-repository.git')

    const metadata = getGitMetadata({ tag: 'ciTag', headCommitSha: 'headCommitSha' })

    expect(metadata).to.eql({
      [GIT_BRANCH]: 'gitBranch',
      [GIT_TAG]: 'ciTag',
      [GIT_COMMIT_MESSAGE]: commitMessage,
      [GIT_COMMIT_SHA]: 'gitCommitSHA',
      [GIT_REPOSITORY_URL]: 'https://github.com/datadog/safe-repository.git',
      [GIT_COMMIT_AUTHOR_EMAIL]: 'git.author@email.com',
      [GIT_COMMIT_AUTHOR_DATE]: '2022-02-14T16:22:03-05:00',
      [GIT_COMMIT_AUTHOR_NAME]: 'git author',
      [GIT_COMMIT_COMMITTER_EMAIL]: 'git.committer@email.com',
      [GIT_COMMIT_COMMITTER_DATE]: '2022-02-14T16:23:03-05:00',
      [GIT_COMMIT_COMMITTER_NAME]: 'git committer',
      [GIT_COMMIT_HEAD_MESSAGE]: headCommitMessage,
      [GIT_COMMIT_HEAD_AUTHOR_DATE]: '2022-02-14T16:22:03-05:00',
      [GIT_COMMIT_HEAD_AUTHOR_EMAIL]: 'git.head.author@email.com',
      [GIT_COMMIT_HEAD_AUTHOR_NAME]: 'git head author',
      [GIT_COMMIT_HEAD_COMMITTER_DATE]: '2022-02-14T16:23:03-05:00',
      [GIT_COMMIT_HEAD_COMMITTER_EMAIL]: 'git.head.committer@email.com',
      [GIT_COMMIT_HEAD_COMMITTER_NAME]: 'git head committer',
      [CI_WORKSPACE_PATH]: 'ciWorkspacePath'
    })

    expect(execFileSyncStub).to.have.been.calledWith('git', ['show', '-s', '--format=%B'])
    expect(execFileSyncStub).to.have.been.calledWith('git', ['show', '-s', '--format=%an,%ae,%aI,%cn,%ce,%cI'])
    expect(execFileSyncStub).to.have.been.calledWith('git', ['rev-parse', 'HEAD'])
    expect(execFileSyncStub).to.have.been.calledWith('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
    expect(execFileSyncStub).to.have.been.calledWith('git', ['rev-parse', '--show-toplevel'])
    expect(execFileSyncStub).to.have.been.calledWith('git', ['ls-remote', '--get-url'])
  })
})

describe('getCommitsRevList', () => {
  it('gets the commits to upload if the repository is smaller than the limit', () => {
    const logErrorSpy = sinon.spy()

    const { getCommitsRevList } = proxyquire('../../../src/plugins/util/git',
      {
        child_process: {
          execFileSync: (command, flags, options) =>
            execSync(`head -c ${Math.floor(GIT_REV_LIST_MAX_BUFFER * 0.9)} /dev/zero`, options)
        },
        '../../log': {
          error: logErrorSpy
        }
      }
    )
    getCommitsRevList([], [])
    expect(logErrorSpy).not.to.have.been.called
  })

  it('does not crash and logs the error if the repository is bigger than the limit', () => {
    const logErrorSpy = sinon.spy()

    const { getCommitsRevList } = proxyquire('../../../src/plugins/util/git',
      {
        child_process: {
          execFileSync: (command, flags, options) =>
            execSync(`head -c ${GIT_REV_LIST_MAX_BUFFER * 2} /dev/zero`, options)
        },
        '../../log': {
          error: logErrorSpy
        }
      }
    )
    getCommitsRevList([], [])
    expect(logErrorSpy).to.have.been.called
  })

  it('returns null if the repository is bigger than the limit', () => {
    const { getCommitsRevList } = proxyquire('../../../src/plugins/util/git',
      {
        child_process: {
          execFileSync: (command, flags, options) =>
            execSync(`head -c ${GIT_REV_LIST_MAX_BUFFER * 2} /dev/zero`, options)
        }
      }
    )
    const commitsToUpload = getCommitsRevList([], [])
    expect(commitsToUpload).to.be.null
  })

  it('returns null if execFileSync fails for whatever reason', () => {
    const { getCommitsRevList } = proxyquire('../../../src/plugins/util/git',
      {
        child_process: {
          execFileSync: () => { throw new Error('error!') }
        }
      }
    )
    const commitsToUpload = getCommitsRevList([], [])
    expect(commitsToUpload).to.be.null
  })
})

describe('generatePackFilesForCommits', () => {
  let tmpdirStub, statSyncStub
  const fakeDirectory = getFakeDirectory()

  beforeEach(() => {
    sinon.stub(Math, 'random').returns('0.1234')
    tmpdirStub = sinon.stub(os, 'tmpdir').returns(fakeDirectory)
    sinon.stub(process, 'cwd').returns('cwd')
    const realStatSync = fs.statSync
    statSyncStub = sinon.stub(fs, 'statSync').callsFake((p, ...args) =>
      p === fakeDirectory || p === 'cwd'
        ? { isDirectory: () => true }
        : realStatSync(p, ...args)
    )
  })

  afterEach(() => {
    sinon.restore()
  })

  it('creates pack files in temporary path', () => {
    const execFileSyncSpy = sinon.stub().returns(['commitSHA'])

    const { generatePackFilesForCommits } = proxyquire('../../../src/plugins/util/git',
      {
        child_process: {
          execFileSync: execFileSyncSpy
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
        child_process: {
          execFileSync: execFileSyncSpy
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
        child_process: {
          execFileSync: execFileSyncSpy
        }
      }
    )
    const packFilesToUpload = generatePackFilesForCommits(['commitSHA'])
    expect(packFilesToUpload).to.eql([])
  })
})

describe('unshallowRepository', () => {
  afterEach(() => {
    execFileSyncStub.reset()
  })

  it('works for the usual case', () => {
    execFileSyncStub
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

    unshallowRepository(false)
    expect(execFileSyncStub).to.have.been.calledWith('git', options)
  })

  it('works for the usual case with parentOnly', () => {
    execFileSyncStub
      .onCall(0).returns(
        'git version 2.39.0'
      )
      .onCall(1).returns('origin')
      .onCall(2).returns('daede5785233abb1a3cb76b9453d4eb5b98290b3')

    const options = [
      'fetch',
      '--deepen=1',
      '--update-shallow',
      '--filter=blob:none',
      '--recurse-submodules=no',
      'origin',
      'daede5785233abb1a3cb76b9453d4eb5b98290b3'
    ]

    unshallowRepository(true)
    expect(execFileSyncStub).to.have.been.calledWith('git', options)
  })

  it('works if the local HEAD is a commit that has not been pushed to the remote', () => {
    execFileSyncStub
      .onCall(0).returns(
        'git version 2.39.0'
      )
      .onCall(1).returns('origin')
      .onCall(2).returns('daede5785233abb1a3cb76b9453d4eb5b98290b3')
      .onCall(3).throws()
      .onCall(4).returns('origin/master')

    const options = [
      'fetch',
      '--shallow-since="1 month ago"',
      '--update-shallow',
      '--filter=blob:none',
      '--recurse-submodules=no',
      'origin',
      'origin/master'
    ]

    unshallowRepository(false)
    expect(execFileSyncStub).to.have.been.calledWith('git', options)
  })

  it('works if the CI is working on a detached HEAD or branch tracking hasn’t been set up', () => {
    execFileSyncStub
      .onCall(0).returns(
        'git version 2.39.0'
      )
      .onCall(1).returns('origin')
      .onCall(2).returns('daede5785233abb1a3cb76b9453d4eb5b98290b3')
      .onCall(3).throws()
      .onCall(4).returns('origin/master')
      .onCall(5).throws()

    const options = [
      'fetch',
      '--shallow-since="1 month ago"',
      '--update-shallow',
      '--filter=blob:none',
      '--recurse-submodules=no',
      'origin'
    ]

    unshallowRepository(false)
    expect(execFileSyncStub).to.have.been.calledWith('git', options)
  })
})

describe('user credentials', () => {
  afterEach(() => {
    execFileSyncStub.reset()
    execFileSyncStub.reset()
  })

  it('scrubs https user credentials', () => {
    execFileSyncStub
      .onCall(0).returns(
        'git author,git.author@email.com,2022-02-14T16:22:03-05:00,' +
        'git committer,git.committer@email.com,2022-02-14T16:23:03-05:00'
      )
      .onCall(5).returns('https://x-oauth-basic:ghp_safe_characters@github.com/datadog/safe-repository.git')

    const metadata = getGitMetadata({})
    expect(metadata[GIT_REPOSITORY_URL])
      .to.equal('https://github.com/datadog/safe-repository.git')
  })

  it('scrubs ssh user credentials', () => {
    execFileSyncStub
      .onCall(0).returns(
        'git author,git.author@email.com,2022-02-14T16:22:03-05:00,' +
        'git committer,git.committer@email.com,2022-02-14T16:23:03-05:00'
      )
      .onCall(5).returns('ssh://username@host.xz:port/path/to/repo.git/')

    const metadata = getGitMetadata({})
    expect(metadata[GIT_REPOSITORY_URL])
      .to.equal('ssh://host.xz:port/path/to/repo.git/')
  })
})

describe('isGitAvailable', () => {
  let originalPath

  beforeEach(() => {
    originalPath = process.env.PATH
  })

  afterEach(() => {
    process.env.PATH = originalPath
  })

  it('returns true if git is available', () => {
    expect(isGitAvailable()).to.be.true
  })

  it('returns false if git is not available', () => {
    process.env.PATH = ''

    expect(isGitAvailable()).to.be.false
  })
})

describe('getGitDiff', () => {
  afterEach(() => {
    execFileSyncStub.reset()
  })

  it('returns the diff between two commits', () => {
    const expectedDiff = 'diff --git a/file.js b/file.js'
    execFileSyncStub.returns(expectedDiff)

    const diff = getGitDiff('base-commit', 'target-commit')

    expect(diff).to.equal(expectedDiff)
    expect(execFileSyncStub).to.have.been.calledWith('git', [
      'diff',
      '-U0',
      '--word-diff=porcelain',
      'base-commit',
      'target-commit'
    ])
  })

  it('returns the diff between a commit and the current HEAD', () => {
    const expectedDiff = 'diff --git a/file.js b/file.js'
    execFileSyncStub.returns(expectedDiff)
    const diff = getGitDiff('base-commit')
    expect(diff).to.equal(expectedDiff)
    expect(execFileSyncStub).to.have.been.calledWith('git', ['diff', '-U0', '--word-diff=porcelain', 'base-commit'])
  })

  it('returns an empty string when git command fails because SHAs could not be found', () => {
    const logErrorSpy = sinon.spy()

    const { getGitDiff } = proxyquire('../../../src/plugins/util/git',
      {
        child_process: {
          execFileSync: execFileSyncStub
        },
        '../../log': {
          error: logErrorSpy
        }
      }
    )
    execFileSyncStub.throws(new Error('git command failed'))

    const diff = getGitDiff('base-commit', 'target-commit')

    expect(logErrorSpy).to.have.been.called
    expect(diff).to.equal('')
  })
})

describe('getGitRemoteName', () => {
  afterEach(() => {
    execFileSyncStub.reset()
  })

  it('returns upstream remote name when available', () => {
    execFileSyncStub.returns('origin/main')

    const { getGitRemoteName } = proxyquire('../../../src/plugins/util/git',
      {
        child_process: {
          execFileSync: execFileSyncStub
        }
      }
    )

    const remoteName = getGitRemoteName()
    expect(remoteName).to.equal('origin')
    expect(execFileSyncStub).to.have.been.calledWith('git',
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
  })

  it('returns first remote when upstream is not available', () => {
    execFileSyncStub
      .onCall(0).throws()
      .onCall(1).returns('upstream\norigin')

    const { getGitRemoteName } = proxyquire('../../../src/plugins/util/git',
      {
        child_process: {
          execFileSync: execFileSyncStub
        }
      }
    )

    const remoteName = getGitRemoteName()
    expect(remoteName).to.equal('upstream')
    expect(execFileSyncStub).to.have.been.calledWith('git', ['remote'])
  })

  it('returns origin when no remotes are available', () => {
    execFileSyncStub
      .onCall(0).throws()
      .onCall(1).returns('')

    const { getGitRemoteName } = proxyquire('../../../src/plugins/util/git',
      {
        child_process: {
          execFileSync: execFileSyncStub
        }
      }
    )

    const remoteName = getGitRemoteName()
    expect(remoteName).to.equal('origin')
  })
})

describe('getSourceBranch', () => {
  afterEach(() => {
    execFileSyncStub.reset()
  })

  it('returns the current branch name', () => {
    execFileSyncStub.returns('feature/my-branch')

    const { getSourceBranch } = proxyquire('../../../src/plugins/util/git',
      {
        child_process: {
          execFileSync: execFileSyncStub
        }
      }
    )

    const branch = getSourceBranch()
    expect(branch).to.equal('feature/my-branch')
    expect(execFileSyncStub).to.have.been.calledWith('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
  })

  it('returns empty string when git command fails', () => {
    execFileSyncStub.throws(new Error('git command failed'))

    const { getSourceBranch } = proxyquire('../../../src/plugins/util/git',
      {
        child_process: {
          execFileSync: execFileSyncStub
        }
      }
    )

    const branch = getSourceBranch()
    expect(branch).to.equal('')
  })
})

describe('checkAndFetchBranch', () => {
  afterEach(() => {
    execFileSyncStub.reset()
  })

  it('does nothing if the branch exists locally', () => {
    execFileSyncStub.returns('')
    const { checkAndFetchBranch } = proxyquire('../../../src/plugins/util/git', {
      child_process: { execFileSync: execFileSyncStub }
    })
    checkAndFetchBranch('my-branch', 'origin')
    expect(execFileSyncStub).to.have.been.calledWith(
      'git',
      ['show-ref', '--verify', '--quiet', 'refs/remotes/origin/my-branch']
    )
    expect(execFileSyncStub).not.to.have.been.calledWith(
      'git',
      ['ls-remote', '--heads', 'origin', 'my-branch'],
      { stdio: 'pipe', timeout: 2000 }
    )
    // Should not call fetch
    expect(execFileSyncStub).not.to.have.been.calledWith(
      'git',
      ['fetch', '--depth', '1', 'origin', 'my-branch'],
      { stdio: 'pipe', timeout: 5000 }
    )
  })

  it('fetches the branch if it does not exist locally but exists on remote', () => {
    execFileSyncStub
      .onCall(0).throws() // local check fails
      .onCall(1).returns('something') // remote check passes
      .onCall(2).returns('') // fetch
    const { checkAndFetchBranch } = proxyquire('../../../src/plugins/util/git', {
      child_process: { execFileSync: execFileSyncStub }
    })
    checkAndFetchBranch('my-branch', 'origin')
    expect(execFileSyncStub).to.have.been.calledWith(
      'git',
      ['show-ref', '--verify', '--quiet', 'refs/remotes/origin/my-branch']
    )
    expect(execFileSyncStub).to.have.been.calledWith(
      'git',
      ['ls-remote', '--heads', 'origin', 'my-branch'],
      { stdio: 'pipe', timeout: 2000 }
    )
    expect(execFileSyncStub).to.have.been.calledWith('git', ['fetch', '--depth', '1', 'origin', 'my-branch'])
  })

  it('does nothing if the branch does not exist locally or on remote', () => {
    execFileSyncStub
      .onCall(0).throws() // local check fails
      .onCall(1).returns('') // remote check fails
    const { checkAndFetchBranch } = proxyquire('../../../src/plugins/util/git', {
      child_process: { execFileSync: execFileSyncStub }
    })
    checkAndFetchBranch('my-branch', 'origin')
    expect(execFileSyncStub).to.have.been.calledWith(
      'git',
      ['show-ref', '--verify', '--quiet', 'refs/remotes/origin/my-branch']
    )
    expect(execFileSyncStub).to.have.been.calledWith(
      'git',
      ['ls-remote', '--heads', 'origin', 'my-branch'],
      { stdio: 'pipe', timeout: 2000 }
    )
    expect(execFileSyncStub).not.to.have.been.calledWith(
      'git',
      ['fetch', '--depth', '1', 'origin', 'my-branch'],
      { stdio: 'pipe', timeout: 5000 }
    )
  })

  it('does nothing if the remote does not exist', () => {
    execFileSyncStub
      .onCall(0).throws() // local check fails
      .onCall(1).throws('') // remote does not exist
    const { checkAndFetchBranch } = proxyquire('../../../src/plugins/util/git', {
      child_process: { execFileSync: execFileSyncStub }
    })
    checkAndFetchBranch('my-branch', 'origin')
    expect(execFileSyncStub).to.have.been.calledWith(
      'git',
      ['show-ref', '--verify', '--quiet', 'refs/remotes/origin/my-branch']
    )
    expect(execFileSyncStub).to.have.been.calledWith(
      'git',
      ['ls-remote', '--heads', 'origin', 'my-branch'],
      { stdio: 'pipe', timeout: 2000 }
    )
    expect(execFileSyncStub).not.to.have.been.calledWith(
      'git',
      ['fetch', '--depth', '1', 'origin', 'my-branch'],
      { stdio: 'pipe', timeout: 5000 }
    )
  })

  it('logs error if a command throws', () => {
    const logErrorSpy = sinon.spy()
    execFileSyncStub.throws(new Error('git command failed'))
    const { checkAndFetchBranch } = proxyquire('../../../src/plugins/util/git', {
      child_process: { execFileSync: execFileSyncStub },
      '../../log': { error: logErrorSpy }
    })
    checkAndFetchBranch('my-branch', 'origin')
    expect(logErrorSpy).to.have.been.called
  })
})

describe('getLocalBranches', () => {
  afterEach(() => {
    execFileSyncStub.reset()
  })

  it('returns a list of local branches', () => {
    execFileSyncStub.returns('branch1\nbranch2\nbranch3')
    const { getLocalBranches } = proxyquire('../../../src/plugins/util/git', {
      child_process: { execFileSync: execFileSyncStub }
    })
    const branches = getLocalBranches('my-origin')
    expect(branches).to.deep.equal(['branch1', 'branch2', 'branch3'])
    expect(execFileSyncStub).to.have.been.calledWith(
      'git',
      [
        'for-each-ref',
        '--format=%(refname:short)',
        'refs/remotes/my-origin'
      ]
    )
  })

  it('returns empty array if command throws and logs an error', () => {
    const logErrorSpy = sinon.spy()
    execFileSyncStub.throws(new Error('git command failed'))
    const { getLocalBranches } = proxyquire('../../../src/plugins/util/git', {
      child_process: { execFileSync: execFileSyncStub },
      '../../log': { error: logErrorSpy }
    })
    const branches = getLocalBranches('origin')
    expect(branches).to.deep.equal([])
    expect(logErrorSpy).to.have.been.called
  })
})

describe('getMergeBase', () => {
  afterEach(() => {
    execFileSyncStub.reset()
  })

  it('returns the merge base commit', () => {
    execFileSyncStub.returns('abc123')
    const { getMergeBase } = proxyquire('../../../src/plugins/util/git', {
      child_process: { execFileSync: execFileSyncStub }
    })
    const mergeBase = getMergeBase('main', 'feature')
    expect(mergeBase).to.equal('abc123')
    expect(execFileSyncStub).to.have.been.calledWith('git', ['merge-base', 'main', 'feature'])
  })

  it('returns empty string if command throws', () => {
    const logErrorSpy = sinon.spy()
    execFileSyncStub.throws(new Error('git command failed'))
    const { getMergeBase } = proxyquire('../../../src/plugins/util/git', {
      child_process: { execFileSync: execFileSyncStub },
      '../../log': { error: logErrorSpy }
    })
    const mergeBase = getMergeBase('main', 'feature')
    expect(mergeBase).to.equal('')
    expect(logErrorSpy).to.have.been.called
  })
})

describe('getCounts', () => {
  afterEach(() => {
    execFileSyncStub.reset()
  })

  it('returns the counts of commits ahead and behind', () => {
    execFileSyncStub.returns('38\t3')
    const { getCounts } = proxyquire('../../../src/plugins/util/git', {
      child_process: { execFileSync: execFileSyncStub }
    })
    const counts = getCounts('feature', 'main')
    expect(counts).to.deep.equal({ behind: 38, ahead: 3 })
    expect(execFileSyncStub).to.have.been.calledWith('git', ['rev-list', '--left-right', '--count', 'main...feature'])
  })

  it('returns object with empty values if command throws', () => {
    const logErrorSpy = sinon.spy()
    execFileSyncStub.throws(new Error('git command failed'))
    const { getCounts } = proxyquire('../../../src/plugins/util/git', {
      child_process: { execFileSync: execFileSyncStub },
      '../../log': { error: logErrorSpy }
    })
    const counts = getCounts('feature', 'main')
    expect(counts).to.deep.equal({ behind: null, ahead: null })
    expect(logErrorSpy).to.have.been.called
  })
})

describe('getGitInformationDiscrepancy', () => {
  const { getGitInformationDiscrepancy } = proxyquire('../../../src/plugins/util/git',
    {
      child_process: {
        execFileSync: execFileSyncStub
      }
    }
  )

  it('returns git repository URL and commit SHA', () => {
    execFileSyncStub
      .onCall(0).returns('https://github.com/datadog/safe-repository.git')
      .onCall(1).returns('abc123')

    const result = getGitInformationDiscrepancy()

    expect(result).to.eql({
      gitRepositoryUrl: 'https://github.com/datadog/safe-repository.git',
      gitCommitSHA: 'abc123'
    })

    expect(execFileSyncStub).to.have.been.calledWith('git', ['config', '--get', 'remote.origin.url'], { stdio: 'pipe' })
    expect(execFileSyncStub).to.have.been.calledWith('git', ['rev-parse', 'HEAD'])
  })

  it('returns empty strings when git commands fail', () => {
    execFileSyncStub.throws(new Error('git command failed'))

    const result = getGitInformationDiscrepancy()

    expect(result).to.eql({
      gitRepositoryUrl: '',
      gitCommitSHA: ''
    })
  })
})

describe('fetchHeadCommitSha', () => {
  const { fetchHeadCommitSha } = proxyquire('../../../src/plugins/util/git',
    {
      child_process: {
        execFileSync: execFileSyncStub
      }
    }
  )

  it('fetches the head commit SHA', () => {
    const headSha = 'abc123'
    const remoteName = 'origin'

    execFileSyncStub
      .onCall(0).returns(null)
      .onCall(1).returns(null)
      .onCall(2).returns('')

    fetchHeadCommitSha(headSha)

    expect(execFileSyncStub).to.have.been.calledWith(
      'git',
      [
        'fetch',
        '--update-shallow',
        '--filter=blob:none',
        '--recurse-submodules=no',
        '--no-write-fetch-head',
        remoteName,
        headSha
      ]
    )
  })
})
