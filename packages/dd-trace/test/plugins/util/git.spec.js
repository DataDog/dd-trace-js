'use strict'

const t = require('tap')
require('../../setup/core')

const { execSync } = require('child_process')
const os = require('os')
const fs = require('fs')
const path = require('path')

const { GIT_REV_LIST_MAX_BUFFER, isGitAvailable } = require('../../../src/plugins/util/git')
const proxyquire = require('proxyquire')
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

t.test('git', t => {
  t.afterEach(() => {
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

  t.test('returns ci metadata if it is present and does not call git for those parameters', t => {
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
    expect(execFileSyncStub).to.have.been.calledWith('git', ['ls-remote', '--get-url'])
    expect(execFileSyncStub).to.have.been.calledWith('git', ['show', '-s', '--format=%an,%ae,%aI,%cn,%ce,%cI'])
    expect(execFileSyncStub).not.to.have.been.calledWith('git', ['show', '-s', '--format=%B'])
    expect(execFileSyncStub).not.to.have.been.calledWith('git', ['rev-parse', 'HEAD'])
    expect(execFileSyncStub).not.to.have.been.calledWith('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
    expect(execFileSyncStub).not.to.have.been.calledWith('git', ['rev-parse', '--show-toplevel'])
    t.end()
  })

  t.test('does not crash if git is not available', t => {
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
    t.end()
  })

  t.test('returns all git metadata is git is available', t => {
    const commitMessage = `multi line
      commit message`

    execFileSyncStub
      .onCall(0).returns(
        'git author,git.author@email.com,2022-02-14T16:22:03-05:00,' +
        'git committer,git.committer@email.com,2022-02-14T16:23:03-05:00'
      )
      .onCall(1).returns(commitMessage)
      .onCall(2).returns('gitBranch')
      .onCall(3).returns('gitCommitSHA')
      .onCall(4).returns('ciWorkspacePath')
      .onCall(5).returns('https://github.com/datadog/safe-repository.git')

    const metadata = getGitMetadata({ tag: 'ciTag' })

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
      [CI_WORKSPACE_PATH]: 'ciWorkspacePath'
    })

    expect(execFileSyncStub).to.have.been.calledWith('git', ['show', '-s', '--format=%B'])
    expect(execFileSyncStub).to.have.been.calledWith('git', ['show', '-s', '--format=%an,%ae,%aI,%cn,%ce,%cI'])
    expect(execFileSyncStub).to.have.been.calledWith('git', ['rev-parse', 'HEAD'])
    expect(execFileSyncStub).to.have.been.calledWith('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
    expect(execFileSyncStub).to.have.been.calledWith('git', ['rev-parse', '--show-toplevel'])
    expect(execFileSyncStub).to.have.been.calledWith('git', ['ls-remote', '--get-url'])
    t.end()
  })
  t.end()
})

t.test('getCommitsRevList', t => {
  t.test('gets the commits to upload if the repository is smaller than the limit', t => {
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
    t.end()
  })

  t.test('does not crash and logs the error if the repository is bigger than the limit', t => {
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
    t.end()
  })

  t.test('returns null if the repository is bigger than the limit', t => {
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
    t.end()
  })

  t.test('returns null if execFileSync fails for whatever reason', t => {
    const { getCommitsRevList } = proxyquire('../../../src/plugins/util/git',
      {
        child_process: {
          execFileSync: () => { throw new Error('error!') }
        }
      }
    )
    const commitsToUpload = getCommitsRevList([], [])
    expect(commitsToUpload).to.be.null
    t.end()
  })
  t.end()
})

t.test('generatePackFilesForCommits', t => {
  let tmpdirStub, statSyncStub
  const fakeDirectory = getFakeDirectory()

  t.beforeEach(() => {
    sinon.stub(Math, 'random').returns('0.1234')
    tmpdirStub = sinon.stub(os, 'tmpdir').returns(fakeDirectory)
    sinon.stub(process, 'cwd').returns('cwd')
    statSyncStub = sinon.stub(fs, 'statSync').returns({ isDirectory: () => true })
  })

  t.afterEach(() => {
    sinon.restore()
  })

  t.test('creates pack files in temporary path', t => {
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
    t.end()
  })

  t.test('creates pack files in cwd if the temporary path fails', t => {
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
    t.end()
  })

  t.test('does not work if tmpdir does not return a folder', t => {
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
    t.end()
  })
  t.end()
})

t.test('unshallowRepository', t => {
  t.afterEach(() => {
    execFileSyncStub.reset()
  })

  t.test('works for the usual case', t => {
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

    unshallowRepository()
    expect(execFileSyncStub).to.have.been.calledWith('git', options)
    t.end()
  })

  t.test('works if the local HEAD is a commit that has not been pushed to the remote', t => {
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

    unshallowRepository()
    expect(execFileSyncStub).to.have.been.calledWith('git', options)
    t.end()
  })

  t.test('works if the CI is working on a detached HEAD or branch tracking hasn’t been set up', t => {
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

    unshallowRepository()
    expect(execFileSyncStub).to.have.been.calledWith('git', options)
    t.end()
  })
  t.end()
})

t.test('user credentials', t => {
  t.afterEach(() => {
    execFileSyncStub.reset()
    execFileSyncStub.reset()
  })

  t.test('scrubs https user credentials', t => {
    execFileSyncStub
      .onCall(0).returns(
        'git author,git.author@email.com,2022-02-14T16:22:03-05:00,' +
        'git committer,git.committer@email.com,2022-02-14T16:23:03-05:00'
      )
      .onCall(5).returns('https://x-oauth-basic:ghp_safe_characters@github.com/datadog/safe-repository.git')

    const metadata = getGitMetadata({})
    expect(metadata[GIT_REPOSITORY_URL])
      .to.equal('https://github.com/datadog/safe-repository.git')
    t.end()
  })

  t.test('scrubs ssh user credentials', t => {
    execFileSyncStub
      .onCall(0).returns(
        'git author,git.author@email.com,2022-02-14T16:22:03-05:00,' +
        'git committer,git.committer@email.com,2022-02-14T16:23:03-05:00'
      )
      .onCall(5).returns('ssh://username@host.xz:port/path/to/repo.git/')

    const metadata = getGitMetadata({})
    expect(metadata[GIT_REPOSITORY_URL])
      .to.equal('ssh://host.xz:port/path/to/repo.git/')
    t.end()
  })
  t.end()
})

t.test('isGitAvailable', t => {
  let originalPath

  t.beforeEach(() => {
    originalPath = process.env.PATH
  })

  t.afterEach(() => {
    process.env.PATH = originalPath
  })

  t.test('returns true if git is available', t => {
    expect(isGitAvailable()).to.be.true
    t.end()
  })

  t.test('returns false if git is not available', t => {
    process.env.PATH = ''

    expect(isGitAvailable()).to.be.false
    t.end()
  })
  t.end()
})

t.test('getGitDiff', t => {
  t.afterEach(() => {
    execFileSyncStub.reset()
  })

  t.test('returns the diff between two commits', t => {
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
    t.end()
  })

  t.test('returns the diff between a commit and the current HEAD', t => {
    const expectedDiff = 'diff --git a/file.js b/file.js'
    execFileSyncStub.returns(expectedDiff)
    const diff = getGitDiff('base-commit')
    expect(diff).to.equal(expectedDiff)
    expect(execFileSyncStub).to.have.been.calledWith('git', ['diff', '-U0', '--word-diff=porcelain', 'base-commit'])
    t.end()
  })

  t.test('returns an empty string when git command fails because SHAs could not be found', t => {
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
    t.end()
  })
  t.end()
})

t.test('getGitRemoteName', t => {
  t.afterEach(() => {
    execFileSyncStub.reset()
  })

  t.test('returns upstream remote name when available', t => {
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
    t.end()
  })

  t.test('returns first remote when upstream is not available', t => {
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
    t.end()
  })

  t.test('returns origin when no remotes are available', t => {
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
    t.end()
  })
  t.end()
})

t.test('getSourceBranch', t => {
  t.afterEach(() => {
    execFileSyncStub.reset()
  })

  t.test('returns the current branch name', t => {
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
    t.end()
  })

  t.test('returns empty string when git command fails', t => {
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
    t.end()
  })
  t.end()
})

t.test('checkAndFetchBranch', t => {
  t.afterEach(() => {
    execFileSyncStub.reset()
  })

  t.test('does nothing if the branch exists locally', t => {
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
    t.end()
  })

  t.test('fetches the branch if it does not exist locally but exists on remote', t => {
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
    t.end()
  })

  t.test('does nothing if the branch does not exist locally or on remote', t => {
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
    t.end()
  })

  t.test('does nothing if the remote does not exist', t => {
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
    t.end()
  })

  t.test('logs error if a command throws', t => {
    const logErrorSpy = sinon.spy()
    execFileSyncStub.throws(new Error('git command failed'))
    const { checkAndFetchBranch } = proxyquire('../../../src/plugins/util/git', {
      child_process: { execFileSync: execFileSyncStub },
      '../../log': { error: logErrorSpy }
    })
    checkAndFetchBranch('my-branch', 'origin')
    expect(logErrorSpy).to.have.been.called
    t.end()
  })
  t.end()
})

t.test('getLocalBranches', t => {
  t.afterEach(() => {
    execFileSyncStub.reset()
  })

  t.test('returns a list of local branches', t => {
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
    t.end()
  })

  t.test('returns empty array if command throws and logs an error', t => {
    const logErrorSpy = sinon.spy()
    execFileSyncStub.throws(new Error('git command failed'))
    const { getLocalBranches } = proxyquire('../../../src/plugins/util/git', {
      child_process: { execFileSync: execFileSyncStub },
      '../../log': { error: logErrorSpy }
    })
    const branches = getLocalBranches('origin')
    expect(branches).to.deep.equal([])
    expect(logErrorSpy).to.have.been.called
    t.end()
  })
  t.end()
})

t.test('getMergeBase', t => {
  t.afterEach(() => {
    execFileSyncStub.reset()
  })

  t.test('returns the merge base commit', t => {
    execFileSyncStub.returns('abc123')
    const { getMergeBase } = proxyquire('../../../src/plugins/util/git', {
      child_process: { execFileSync: execFileSyncStub }
    })
    const mergeBase = getMergeBase('main', 'feature')
    expect(mergeBase).to.equal('abc123')
    expect(execFileSyncStub).to.have.been.calledWith('git', ['merge-base', 'main', 'feature'])
    t.end()
  })

  t.test('returns empty string if command throws', t => {
    const logErrorSpy = sinon.spy()
    execFileSyncStub.throws(new Error('git command failed'))
    const { getMergeBase } = proxyquire('../../../src/plugins/util/git', {
      child_process: { execFileSync: execFileSyncStub },
      '../../log': { error: logErrorSpy }
    })
    const mergeBase = getMergeBase('main', 'feature')
    expect(mergeBase).to.equal('')
    expect(logErrorSpy).to.have.been.called
    t.end()
  })
  t.end()
})

t.test('getCounts', t => {
  t.afterEach(() => {
    execFileSyncStub.reset()
  })

  t.test('returns the counts of commits ahead and behind', t => {
    execFileSyncStub.returns('38\t3')
    const { getCounts } = proxyquire('../../../src/plugins/util/git', {
      child_process: { execFileSync: execFileSyncStub }
    })
    const counts = getCounts('feature', 'main')
    expect(counts).to.deep.equal({ behind: 38, ahead: 3 })
    expect(execFileSyncStub).to.have.been.calledWith('git', ['rev-list', '--left-right', '--count', 'main...feature'])
    t.end()
  })

  t.test('returns object with empty values if command throws', t => {
    const logErrorSpy = sinon.spy()
    execFileSyncStub.throws(new Error('git command failed'))
    const { getCounts } = proxyquire('../../../src/plugins/util/git', {
      child_process: { execFileSync: execFileSyncStub },
      '../../log': { error: logErrorSpy }
    })
    const counts = getCounts('feature', 'main')
    expect(counts).to.deep.equal({ behind: null, ahead: null })
    expect(logErrorSpy).to.have.been.called
    t.end()
  })
  t.end()
})

t.test('getGitInformationDiscrepancy', t => {
  const { getGitInformationDiscrepancy } = proxyquire('../../../src/plugins/util/git',
    {
      child_process: {
        execFileSync: execFileSyncStub
      }
    }
  )

  t.test('returns git repository URL and commit SHA', t => {
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
    t.end()
  })

  t.test('returns empty strings when git commands fail', t => {
    execFileSyncStub.throws(new Error('git command failed'))

    const result = getGitInformationDiscrepancy()

    expect(result).to.eql({
      gitRepositoryUrl: '',
      gitCommitSHA: ''
    })
    t.end()
  })
  t.end()
})
