'use strict'

const assert = require('node:assert/strict')
const { execFileSync, execSync } = require('node:child_process')
const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const { describe, it, afterEach, beforeEach } = require('mocha')
const nock = require('nock')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

const { assertObjectContains } = require('../../../../../integration-tests/helpers')
require('../../setup/core')
const { GIT_REV_LIST_MAX_BUFFER, isGitAvailable } = require('../../../src/plugins/util/git')

const cachedExecStub = sinon.stub().returns('')

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
  GIT_COMMIT_HEAD_COMMITTER_NAME,
} = require('../../../src/plugins/util/tags')

const {
  getGitMetadata,
  unshallowRepository,
  getGitDiff,
  isGitAvailable: isGitAvailableWithStub,
} = proxyquire('../../../src/plugins/util/git', {
  './git-cache': {
    cachedExec: cachedExecStub,
  },
})

function getFakeDirectory () {
  if (os.platform() === 'win32') {
    return `C:${path.sep}tmp`
  }
  return '/tmp'
}

describe('git', () => {
  afterEach(() => {
    cachedExecStub.reset()
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
      headCommitSha: 'headCommitSha',
    }
    const metadata = getGitMetadata(ciMetadata)

    assertObjectContains(metadata, {
      [GIT_COMMIT_SHA]: 'ciSHA',
      [GIT_BRANCH]: 'myBranch',
      [GIT_COMMIT_MESSAGE]: 'myCommitMessage',
      [GIT_COMMIT_AUTHOR_NAME]: 'ciAuthorName',
      [CI_WORKSPACE_PATH]: 'ciWorkspacePath',
    })
    assert.notStrictEqual(metadata[GIT_REPOSITORY_URL], 'ciRepositoryUrl')
    sinon.assert.calledWith(cachedExecStub, 'git', ['ls-remote', '--get-url'])
    sinon.assert.calledWith(cachedExecStub, 'git', ['show', '-s', '--format=%an,%ae,%aI,%cn,%ce,%cI'])
    sinon.assert.neverCalledWith(cachedExecStub, 'git', ['show', '-s', '--format=%B'])
    sinon.assert.neverCalledWith(cachedExecStub, 'git', ['rev-parse', 'HEAD'])
    sinon.assert.neverCalledWith(cachedExecStub, 'git', ['rev-parse', '--abbrev-ref', 'HEAD'])
    sinon.assert.neverCalledWith(cachedExecStub, 'git', ['rev-parse', '--show-toplevel'])
    sinon.assert.calledWith(cachedExecStub,
      'git',
      ['show', '-s', '--format=\'%H","%aI","%an","%ae","%cI","%cn","%ce","%B\'', ciMetadata.headCommitSha]
    )
  })

  it('does not crash if git is not available', () => {
    cachedExecStub.returns('')
    const ciMetadata = { repositoryUrl: 'https://github.com/datadog/safe-repository.git' }
    const metadata = getGitMetadata(ciMetadata)

    assert.deepStrictEqual(metadata, {
      [GIT_BRANCH]: '',
      [GIT_COMMIT_MESSAGE]: '',
      [GIT_COMMIT_SHA]: '',
      [GIT_REPOSITORY_URL]: 'https://github.com/datadog/safe-repository.git',
      [CI_WORKSPACE_PATH]: '',
    })
  })

  it('returns all git metadata is git is available', () => {
    const commitMessage = `multi line
      commit message`
    const headCommitMessage = `multi line
      head commit message`

    cachedExecStub
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

    assert.deepStrictEqual(metadata, {
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
      [CI_WORKSPACE_PATH]: 'ciWorkspacePath',
    })

    sinon.assert.calledWith(cachedExecStub, 'git', ['show', '-s', '--format=%B'])
    sinon.assert.calledWith(cachedExecStub, 'git', ['show', '-s', '--format=%an,%ae,%aI,%cn,%ce,%cI'])
    sinon.assert.calledWith(cachedExecStub, 'git', ['rev-parse', 'HEAD'])
    sinon.assert.calledWith(cachedExecStub, 'git', ['rev-parse', '--abbrev-ref', 'HEAD'])
    sinon.assert.calledWith(cachedExecStub, 'git', ['rev-parse', '--show-toplevel'])
    sinon.assert.calledWith(cachedExecStub, 'git', ['ls-remote', '--get-url'])
  })
})

describe('getCommitsRevList', () => {
  it('gets the commits to upload if the repository is smaller than the limit', () => {
    const logErrorSpy = sinon.spy()

    const { getCommitsRevList } = proxyquire('../../../src/plugins/util/git',
      {
        './git-cache': {
          cachedExec: (command, flags, options) =>
            execSync(`head -c ${Math.floor(GIT_REV_LIST_MAX_BUFFER * 0.9)} /dev/zero`, options),
        },
        '../../log': {
          error: logErrorSpy,
        },
      }
    )
    getCommitsRevList([], [])
    sinon.assert.notCalled(logErrorSpy)
  })

  it('does not crash and logs the error if the repository is bigger than the limit', () => {
    const logErrorSpy = sinon.spy()

    const { getCommitsRevList } = proxyquire('../../../src/plugins/util/git',
      {
        './git-cache': {
          cachedExec: (command, flags, options) =>
            execSync(`head -c ${GIT_REV_LIST_MAX_BUFFER * 2} /dev/zero`, options),
        },
        '../../log': {
          error: logErrorSpy,
        },
      }
    )
    getCommitsRevList([], [])
    sinon.assert.called(logErrorSpy)
  })

  it('returns null if the repository is bigger than the limit', () => {
    const { getCommitsRevList } = proxyquire('../../../src/plugins/util/git',
      {
        './git-cache': {
          cachedExec: (command, flags, options) =>
            execSync(`head -c ${GIT_REV_LIST_MAX_BUFFER * 2} /dev/zero`, options),
        },
      }
    )
    const commitsToUpload = getCommitsRevList([], [])
    assert.strictEqual(commitsToUpload, null)
  })

  it('returns null if execFileSync fails for whatever reason', () => {
    const { getCommitsRevList } = proxyquire('../../../src/plugins/util/git',
      {
        './git-cache': {
          cachedExec: () => { throw new Error('error!') },
        },
      }
    )
    const commitsToUpload = getCommitsRevList([], [])
    assert.strictEqual(commitsToUpload, null)
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
        './git-cache': {
          cachedExec: execFileSyncSpy,
        },
      }
    )

    const temporaryPath = path.join(fakeDirectory, '1234')
    const packFilesToUpload = generatePackFilesForCommits(['commitSHA'])
    assert.deepStrictEqual(packFilesToUpload, [`${temporaryPath}-commitSHA.pack`])
  })

  it('creates pack files in cwd if the temporary path fails', () => {
    const execFileSyncSpy = sinon.stub().onCall(0).throws().onCall(1).returns(['commitSHA'])

    const cwdPath = path.join('cwd', '1234')

    const { generatePackFilesForCommits } = proxyquire('../../../src/plugins/util/git',
      {
        './git-cache': {
          cachedExec: execFileSyncSpy,
        },
      }
    )

    const packFilesToUpload = generatePackFilesForCommits(['commitSHA'])
    assert.deepStrictEqual(packFilesToUpload, [`${cwdPath}-commitSHA.pack`])
  })

  it('does not work if tmpdir does not return a folder', () => {
    tmpdirStub.restore()
    statSyncStub.restore()
    sinon.stub(os, 'tmpdir').returns('; echo hey')
    const execFileSyncSpy = sinon.stub().onCall(0).throws().onCall(1).returns(['commitSHA'])

    const { generatePackFilesForCommits } = proxyquire('../../../src/plugins/util/git',
      {
        './git-cache': {
          cachedExec: execFileSyncSpy,
        },
      }
    )
    const packFilesToUpload = generatePackFilesForCommits(['commitSHA'])
    assert.deepStrictEqual(packFilesToUpload, [])
  })
})

describe('unshallowRepository', () => {
  afterEach(() => {
    cachedExecStub.reset()
  })

  it('works for the usual case', () => {
    cachedExecStub
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
      'daede5785233abb1a3cb76b9453d4eb5b98290b3',
    ]

    unshallowRepository(false)
    sinon.assert.calledWith(cachedExecStub, 'git', options)
  })

  it('works for the usual case with parentOnly', () => {
    cachedExecStub
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
      'daede5785233abb1a3cb76b9453d4eb5b98290b3',
    ]

    unshallowRepository(true)
    sinon.assert.calledWith(cachedExecStub, 'git', options)
  })

  it('works if the local HEAD is a commit that has not been pushed to the remote', () => {
    cachedExecStub
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
      'origin/master',
    ]

    unshallowRepository(false)
    sinon.assert.calledWith(cachedExecStub, 'git', options)
  })

  it('works if the CI is working on a detached HEAD or branch tracking hasn’t been set up', () => {
    cachedExecStub
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
      'origin',
    ]

    unshallowRepository(false)
    sinon.assert.calledWith(cachedExecStub, 'git', options)
  })
})

describe('user credentials', () => {
  afterEach(() => {
    cachedExecStub.reset()
    cachedExecStub.reset()
  })

  it('scrubs https user credentials', () => {
    cachedExecStub
      .onCall(0).returns(
        'git author,git.author@email.com,2022-02-14T16:22:03-05:00,' +
        'git committer,git.committer@email.com,2022-02-14T16:23:03-05:00'
      )
      .onCall(5).returns('https://x-oauth-basic:ghp_safe_characters@github.com/datadog/safe-repository.git')

    const metadata = getGitMetadata({})
    assert.strictEqual(metadata[GIT_REPOSITORY_URL], 'https://github.com/datadog/safe-repository.git')
  })

  it('scrubs ssh user credentials', () => {
    cachedExecStub
      .onCall(0).returns(
        'git author,git.author@email.com,2022-02-14T16:22:03-05:00,' +
        'git committer,git.committer@email.com,2022-02-14T16:23:03-05:00'
      )
      .onCall(5).returns('ssh://username@host.xz:port/path/to/repo.git/')

    const metadata = getGitMetadata({})
    assert.strictEqual(metadata[GIT_REPOSITORY_URL], 'ssh://host.xz:port/path/to/repo.git/')
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
    assert.strictEqual(isGitAvailable(), true)
  })

  it('checks whether git can be executed directly', () => {
    assert.strictEqual(isGitAvailableWithStub(), true)
    sinon.assert.calledOnceWithExactly(cachedExecStub, 'git', ['--version'])
  })

  it('returns false if git is not available', () => {
    process.env.PATH = ''

    assert.strictEqual(isGitAvailable(), false)
  })
})

describe('getGitDiff', () => {
  afterEach(() => {
    cachedExecStub.reset()
  })

  it('returns the diff between two commits', () => {
    const expectedDiff = 'diff --git a/file.js b/file.js'
    cachedExecStub.returns(expectedDiff)

    const diff = getGitDiff('base-commit', 'target-commit')

    assert.strictEqual(diff, expectedDiff)
    sinon.assert.calledWith(cachedExecStub, 'git', [
      'diff',
      '-U0',
      '--word-diff=porcelain',
      'base-commit',
      'target-commit',
    ])
  })

  it('returns the diff between a commit and the current HEAD', () => {
    const expectedDiff = 'diff --git a/file.js b/file.js'
    cachedExecStub.returns(expectedDiff)
    const diff = getGitDiff('base-commit')
    assert.strictEqual(diff, expectedDiff)
    sinon.assert.calledWith(cachedExecStub, 'git', ['diff', '-U0', '--word-diff=porcelain', 'base-commit'])
  })

  it('returns an empty string when git command fails because SHAs could not be found', () => {
    const logErrorSpy = sinon.spy()

    const { getGitDiff } = proxyquire('../../../src/plugins/util/git',
      {
        './git-cache': {
          cachedExec: cachedExecStub,
        },
        '../../log': {
          error: logErrorSpy,
        },
      }
    )
    cachedExecStub.throws(new Error('git command failed'))

    const diff = getGitDiff('base-commit', 'target-commit')

    sinon.assert.called(logErrorSpy)
    assert.strictEqual(diff, '')
  })
})

describe('getGitRemoteName', () => {
  afterEach(() => {
    cachedExecStub.reset()
  })

  it('returns upstream remote name when available', () => {
    cachedExecStub.returns('origin/main')

    const { getGitRemoteName } = proxyquire('../../../src/plugins/util/git',
      {
        './git-cache': {
          cachedExec: cachedExecStub,
        },
      }
    )

    const remoteName = getGitRemoteName()
    assert.strictEqual(remoteName, 'origin')
    sinon.assert.calledWith(cachedExecStub, 'git',
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
  })

  it('returns first remote when upstream is not available', () => {
    cachedExecStub
      .onCall(0).throws()
      .onCall(1).returns('upstream\norigin')

    const { getGitRemoteName } = proxyquire('../../../src/plugins/util/git',
      {
        './git-cache': {
          cachedExec: cachedExecStub,
        },
      }
    )

    const remoteName = getGitRemoteName()
    assert.strictEqual(remoteName, 'upstream')
    sinon.assert.calledWith(cachedExecStub, 'git', ['remote'])
  })

  it('returns origin when no remotes are available', () => {
    cachedExecStub
      .onCall(0).throws()
      .onCall(1).returns('')

    const { getGitRemoteName } = proxyquire('../../../src/plugins/util/git',
      {
        './git-cache': {
          cachedExec: cachedExecStub,
        },
      }
    )

    const remoteName = getGitRemoteName()
    assert.strictEqual(remoteName, 'origin')
  })
})

describe('getSourceBranch', () => {
  afterEach(() => {
    cachedExecStub.reset()
  })

  it('returns the current branch name', () => {
    cachedExecStub.returns('feature/my-branch')

    const { getSourceBranch } = proxyquire('../../../src/plugins/util/git',
      {
        './git-cache': {
          cachedExec: cachedExecStub,
        },
      }
    )

    const branch = getSourceBranch()
    assert.strictEqual(branch, 'feature/my-branch')
    sinon.assert.calledWith(cachedExecStub, 'git', ['rev-parse', '--abbrev-ref', 'HEAD'])
  })

  it('returns empty string when git command fails', () => {
    cachedExecStub.throws(new Error('git command failed'))

    const { getSourceBranch } = proxyquire('../../../src/plugins/util/git',
      {
        './git-cache': {
          cachedExec: cachedExecStub,
        },
      }
    )

    const branch = getSourceBranch()
    assert.strictEqual(branch, '')
  })
})

describe('checkAndFetchBranch', () => {
  afterEach(() => {
    cachedExecStub.reset()
  })

  it('does nothing if the branch exists locally', () => {
    cachedExecStub.returns('')
    const { checkAndFetchBranch } = proxyquire('../../../src/plugins/util/git', {
      './git-cache': { cachedExec: cachedExecStub },
    })
    checkAndFetchBranch('my-branch', 'origin')
    sinon.assert.calledWith(cachedExecStub,
      'git',
      ['show-ref', '--verify', '--quiet', 'refs/remotes/origin/my-branch']
    )
    sinon.assert.neverCalledWith(cachedExecStub,
      'git',
      ['ls-remote', '--heads', 'origin', 'my-branch'],
      { stdio: 'pipe', timeout: 2000 }
    )
    // Should not call fetch
    sinon.assert.neverCalledWith(cachedExecStub,
      'git',
      ['fetch', '--depth', '1', 'origin', 'my-branch'],
      { stdio: 'pipe', timeout: 5000 }
    )
  })

  it('fetches the branch if it does not exist locally but exists on remote', () => {
    cachedExecStub
      .onCall(0).throws() // local check fails
      .onCall(1).returns('something') // remote check passes
      .onCall(2).returns('') // fetch
    const { checkAndFetchBranch } = proxyquire('../../../src/plugins/util/git', {
      './git-cache': { cachedExec: cachedExecStub },
    })
    checkAndFetchBranch('my-branch', 'origin')
    sinon.assert.calledWith(cachedExecStub,
      'git',
      ['show-ref', '--verify', '--quiet', 'refs/remotes/origin/my-branch']
    )
    sinon.assert.calledWith(cachedExecStub,
      'git',
      ['ls-remote', '--heads', 'origin', 'my-branch'],
      { stdio: 'pipe', timeout: 2000 }
    )
    sinon.assert.calledWith(cachedExecStub, 'git', ['fetch', '--depth', '1', 'origin', 'my-branch'])
  })

  it('does nothing if the branch does not exist locally or on remote', () => {
    cachedExecStub
      .onCall(0).throws() // local check fails
      .onCall(1).returns('') // remote check fails
    const { checkAndFetchBranch } = proxyquire('../../../src/plugins/util/git', {
      './git-cache': { cachedExec: cachedExecStub },
    })
    checkAndFetchBranch('my-branch', 'origin')
    sinon.assert.calledWith(cachedExecStub,
      'git',
      ['show-ref', '--verify', '--quiet', 'refs/remotes/origin/my-branch']
    )
    sinon.assert.calledWith(cachedExecStub,
      'git',
      ['ls-remote', '--heads', 'origin', 'my-branch'],
      { stdio: 'pipe', timeout: 2000 }
    )
    sinon.assert.neverCalledWith(cachedExecStub,
      'git',
      ['fetch', '--depth', '1', 'origin', 'my-branch'],
      { stdio: 'pipe', timeout: 5000 }
    )
  })

  it('does nothing if the remote does not exist', () => {
    cachedExecStub
      .onCall(0).throws() // local check fails
      .onCall(1).throws('') // remote does not exist
    const { checkAndFetchBranch } = proxyquire('../../../src/plugins/util/git', {
      './git-cache': { cachedExec: cachedExecStub },
    })
    checkAndFetchBranch('my-branch', 'origin')
    sinon.assert.calledWith(cachedExecStub,
      'git',
      ['show-ref', '--verify', '--quiet', 'refs/remotes/origin/my-branch']
    )
    sinon.assert.calledWith(cachedExecStub,
      'git',
      ['ls-remote', '--heads', 'origin', 'my-branch'],
      { stdio: 'pipe', timeout: 2000 }
    )
    sinon.assert.neverCalledWith(cachedExecStub,
      'git',
      ['fetch', '--depth', '1', 'origin', 'my-branch'],
      { stdio: 'pipe', timeout: 5000 }
    )
  })

  it('logs debug if a command throws', () => {
    const logDebugSpy = sinon.spy()
    cachedExecStub.throws(new Error('git command failed'))
    const { checkAndFetchBranch } = proxyquire('../../../src/plugins/util/git', {
      './git-cache': { cachedExec: cachedExecStub },
      '../../log': { debug: logDebugSpy },
    })
    checkAndFetchBranch('my-branch', 'origin')
    sinon.assert.called(logDebugSpy)
  })
})

describe('getLocalBranches', () => {
  afterEach(() => {
    cachedExecStub.reset()
  })

  it('returns a list of local branches', () => {
    cachedExecStub.returns('branch1\nbranch2\nbranch3')
    const { getLocalBranches } = proxyquire('../../../src/plugins/util/git', {
      './git-cache': { cachedExec: cachedExecStub },
    })
    const branches = getLocalBranches('my-origin')
    assert.deepStrictEqual(branches, ['branch1', 'branch2', 'branch3'])
    sinon.assert.calledWith(cachedExecStub,
      'git',
      [
        'for-each-ref',
        '--format=%(refname:short)',
        'refs/remotes/my-origin',
      ]
    )
  })

  it('returns empty array if command throws and logs an error', () => {
    const logErrorSpy = sinon.spy()
    cachedExecStub.throws(new Error('git command failed'))
    const { getLocalBranches } = proxyquire('../../../src/plugins/util/git', {
      './git-cache': { cachedExec: cachedExecStub },
      '../../log': { error: logErrorSpy },
    })
    const branches = getLocalBranches('origin')
    assert.deepStrictEqual(branches, [])
    sinon.assert.called(logErrorSpy)
  })
})

describe('getMergeBase', () => {
  afterEach(() => {
    cachedExecStub.reset()
  })

  it('returns the merge base commit', () => {
    cachedExecStub.returns('abc123')
    const { getMergeBase } = proxyquire('../../../src/plugins/util/git', {
      './git-cache': { cachedExec: cachedExecStub },
    })
    const mergeBase = getMergeBase('main', 'feature')
    assert.strictEqual(mergeBase, 'abc123')
    sinon.assert.calledWith(cachedExecStub, 'git', ['merge-base', 'main', 'feature'])
  })

  it('returns empty string if command throws', () => {
    const logErrorSpy = sinon.spy()
    cachedExecStub.throws(new Error('git command failed'))
    const { getMergeBase } = proxyquire('../../../src/plugins/util/git', {
      './git-cache': { cachedExec: cachedExecStub },
      '../../log': { error: logErrorSpy },
    })
    const mergeBase = getMergeBase('main', 'feature')
    assert.strictEqual(mergeBase, '')
    sinon.assert.called(logErrorSpy)
  })
})

describe('getCounts', () => {
  afterEach(() => {
    cachedExecStub.reset()
  })

  it('returns the counts of commits ahead and behind', () => {
    cachedExecStub.returns('38\t3')
    const { getCounts } = proxyquire('../../../src/plugins/util/git', {
      './git-cache': { cachedExec: cachedExecStub },
    })
    const counts = getCounts('feature', 'main')
    assert.deepStrictEqual(counts, { behind: 38, ahead: 3 })
    sinon.assert.calledWith(cachedExecStub, 'git', ['rev-list', '--left-right', '--count', 'main...feature'])
  })

  it('returns object with empty values if command throws', () => {
    const logErrorSpy = sinon.spy()
    cachedExecStub.throws(new Error('git command failed'))
    const { getCounts } = proxyquire('../../../src/plugins/util/git', {
      './git-cache': { cachedExec: cachedExecStub },
      '../../log': { error: logErrorSpy },
    })
    const counts = getCounts('feature', 'main')
    assert.deepStrictEqual(counts, { behind: null, ahead: null })
    sinon.assert.called(logErrorSpy)
  })
})

describe('getGitInformationDiscrepancy', () => {
  const { getGitInformationDiscrepancy } = proxyquire('../../../src/plugins/util/git',
    {
      './git-cache': {
        cachedExec: cachedExecStub,
      },
    }
  )

  it('returns git repository URL and commit SHA', () => {
    cachedExecStub
      .onCall(0).returns('https://github.com/datadog/safe-repository.git')
      .onCall(1).returns('abc123')

    const result = getGitInformationDiscrepancy()

    assert.deepStrictEqual(result, {
      gitRepositoryUrl: 'https://github.com/datadog/safe-repository.git',
      gitCommitSHA: 'abc123',
    })

    sinon.assert.calledWith(cachedExecStub, 'git', ['config', '--get', 'remote.origin.url'], { stdio: 'pipe' })
    sinon.assert.calledWith(cachedExecStub, 'git', ['rev-parse', 'HEAD'])
  })

  it('returns empty strings when git commands fail', () => {
    cachedExecStub.throws(new Error('git command failed'))

    const result = getGitInformationDiscrepancy()

    assert.deepStrictEqual(result, {
      gitRepositoryUrl: '',
      gitCommitSHA: '',
    })
  })
})

describe('fetchHeadCommitSha', () => {
  const cachedExecStub = sinon.stub()
  const logErrorSpy = sinon.spy()
  const environment = {
    PATH: '/test/bin',
    GIT_SSH_COMMAND: 'ssh -F test-config',
    GIT_NO_LAZY_FETCH: '0',
    GIT_ALLOW_PROTOCOL: 'https',
  }
  const { fetchHeadCommitSha } = proxyquire('../../../src/plugins/util/git',
    {
      './git-cache': {
        cachedExec: cachedExecStub,
      },
      '../../log': { error: logErrorSpy },
      '../../config/helper': { getEnvironmentVariables: () => environment },
    }
  )

  afterEach(() => {
    cachedExecStub.reset()
    logErrorSpy.resetHistory()
  })

  it('preserves the original fetch for a commit that is already available locally', () => {
    cachedExecStub.returns('')

    fetchHeadCommitSha('abc123')

    sinon.assert.calledWithExactly(cachedExecStub, 'git', ['cat-file', '-e', 'abc123'], {
      stdio: 'pipe',
      env: { ...environment, GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '' },
    })
    sinon.assert.calledWith(cachedExecStub, 'git', [
      'fetch',
      '--update-shallow',
      '--filter=blob:none',
      '--recurse-submodules=no',
      '--no-write-fetch-head',
      'origin',
      'abc123',
    ])
  })

  it('fetches only the missing head commit', () => {
    const headSha = 'abc123'
    const remoteName = 'origin'

    cachedExecStub
      .returns('')
      .onCall(0).throws(new Error('Commit is missing'))

    fetchHeadCommitSha(headSha)

    sinon.assert.calledWith(cachedExecStub,
      'git',
      [
        'fetch',
        '--depth=1',
        '--update-shallow',
        '--filter=blob:none',
        '--recurse-submodules=no',
        '--no-write-fetch-head',
        remoteName,
        headSha,
      ]
    )
  })

  it('logs a failed fetch without throwing', () => {
    cachedExecStub.throws(new Error('Git command failed'))

    fetchHeadCommitSha('abc123')

    sinon.assert.called(logErrorSpy)
    assert.ok(cachedExecStub.getCalls().some(call => call.args[1][0] === 'fetch'))
  })
})

describe('PR head metadata in shallow repositories', () => {
  let directory
  let checkout
  let remote
  let headSha
  let baseSha
  let getGitMetadata
  let getGitDiff
  let cachedExecSpy

  /**
   * @param {string} cwd
   * @param {string[]} flags
   * @param {import('node:child_process').ExecFileSyncOptions} [options]
   */
  function git (cwd, flags, options = {}) {
    return execFileSync('git', flags, { ...options, cwd, stdio: 'pipe' }).toString().trim()
  }

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-trace-pr-head-'))
    remote = path.join(directory, 'remote.git')
    checkout = path.join(directory, 'checkout')
    git(directory, ['init', '--bare', remote])
    git(remote, ['config', 'uploadpack.allowFilter', 'true'])
    git(remote, ['fast-import', '--quiet'], {
      input: `commit refs/heads/juan-fernandez/head
mark :1
committer Test Author <author@example.com> 1700000000 +0000
data 4
root
M 100644 inline history.txt
data 4
root

commit refs/heads/juan-fernandez/head
mark :2
author PR Author <pr-author@example.com> 1700000001 +0000
committer PR Committer <pr-committer@example.com> 1700000002 +0000
data 17
PR head DD_abc123
from :1
M 100644 inline history.txt
data 4
head

commit refs/heads/juan-fernandez/merge
mark :3
committer Test Author <author@example.com> 1700000003 +0000
data 4
base
from :1

commit refs/heads/juan-fernandez/merge
committer Test Author <author@example.com> 1700000004 +0000
data 5
merge
from :3
merge :2

done
`,
    })
    headSha = git(remote, ['rev-parse', 'refs/heads/juan-fernandez/head'])
    baseSha = git(remote, ['rev-parse', `${headSha}^`])
    git(directory, [
      'clone', '--depth=1', '--no-checkout', '--branch', 'juan-fernandez/merge',
      pathToFileURL(remote).href, checkout,
    ])
    git(checkout, ['update-ref', '--no-deref', 'HEAD', git(checkout, ['rev-parse', 'HEAD'])])
    cachedExecSpy = sinon.spy((command, flags, options) =>
      execFileSync(command, flags, { stdio: 'pipe', ...options, cwd: checkout }))
    const gitUtils = proxyquire('../../../src/plugins/util/git', {
      './git-cache': { cachedExec: cachedExecSpy },
    })
    getGitMetadata = gitUtils.getGitMetadata
    getGitDiff = gitUtils.getGitDiff
  })

  afterEach(() => {
    nock.cleanAll()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  it('fetches head metadata without its ancestors or changing the checkout', () => {
    const originalHead = git(checkout, ['rev-parse', 'HEAD'])
    const originalRefs = git(checkout, ['show-ref'])
    const fetchHeadPath = path.join(checkout, '.git', 'FETCH_HEAD')
    fs.writeFileSync(fetchHeadPath, 'unchanged\n')

    const metadata = getGitMetadata({ headCommitSha: headSha })

    assertObjectContains(metadata, {
      [GIT_COMMIT_HEAD_MESSAGE]: "PR head DD_abc123'\n",
      [GIT_COMMIT_HEAD_AUTHOR_NAME]: 'PR Author',
      [GIT_COMMIT_HEAD_AUTHOR_EMAIL]: 'pr-author@example.com',
      [GIT_COMMIT_HEAD_COMMITTER_NAME]: 'PR Committer',
      [GIT_COMMIT_HEAD_COMMITTER_EMAIL]: 'pr-committer@example.com',
    })
    assert.strictEqual(new Date(metadata[GIT_COMMIT_HEAD_AUTHOR_DATE]).toISOString(), '2023-11-14T22:13:21.000Z')
    assert.strictEqual(new Date(metadata[GIT_COMMIT_HEAD_COMMITTER_DATE]).toISOString(), '2023-11-14T22:13:22.000Z')
    assert.strictEqual(git(checkout, ['rev-list', '--count', headSha]), '1')
    assert.strictEqual(git(checkout, ['rev-parse', 'HEAD']), originalHead)
    assert.strictEqual(git(checkout, ['show-ref']), originalRefs)
    assert.strictEqual(fs.readFileSync(fetchHeadPath, 'utf8'), 'unchanged\n')
  })

  it('preserves available head history', () => {
    git(checkout, ['fetch', '--depth=2', 'origin', headSha])

    const metadata = getGitMetadata({ headCommitSha: headSha })

    assert.strictEqual(metadata[GIT_COMMIT_HEAD_AUTHOR_NAME], 'PR Author')
    assert.strictEqual(git(checkout, ['rev-list', '--count', headSha]), '2')
  })

  for (const missingObject of ['parent', 'tree']) {
    it(`recovers head metadata and its Test Management marker with a missing ${missingObject}`, (done) => {
      const commits = missingObject === 'parent' ? [headSha] : [headSha, baseSha]
      for (const sha of commits) {
        const object = execFileSync('git', ['cat-file', 'commit', sha], { cwd: remote, stdio: 'pipe' })
        git(checkout, ['hash-object', '-t', 'commit', '-w', '--stdin'], { input: object })
      }
      git(checkout, ['cat-file', '-e', headSha])
      assert.throws(() => git(checkout, ['show', '-s', '--format=%B', headSha]), { status: 128 })

      const metadata = getGitMetadata({ headCommitSha: headSha })

      assertObjectContains(metadata, {
        [GIT_COMMIT_HEAD_MESSAGE]: "PR head DD_abc123'\n",
        [GIT_COMMIT_HEAD_AUTHOR_NAME]: 'PR Author',
        [GIT_COMMIT_HEAD_AUTHOR_EMAIL]: 'pr-author@example.com',
        [GIT_COMMIT_HEAD_COMMITTER_NAME]: 'PR Committer',
        [GIT_COMMIT_HEAD_COMMITTER_EMAIL]: 'pr-committer@example.com',
      })

      const { getTestManagementTests } = proxyquire(
        '../../../src/ci-visibility/test-management/get-test-management-tests', {
          '../requests/fs-cache': { withCache: (key, fetch, callback) => fetch(null, callback) },
        })
      const scope = nock('http://localhost:8126')
        .post('/evp_proxy/v2/api/v2/test/libraries/test-management/tests', body =>
          body.data.attributes.sha === headSha &&
          body.data.attributes.commit_message === "PR head DD_abc123'\n")
        .reply(200, { data: { attributes: { modules: {} } } })

      getTestManagementTests({
        url: 'http://localhost:8126',
        isEvpProxy: true,
        evpProxyPrefix: '/evp_proxy/v2',
        repositoryUrl: 'https://example.com/repository',
        commitHeadSha: headSha,
        commitHeadMessage: metadata[GIT_COMMIT_HEAD_MESSAGE],
        commitMessage: metadata[GIT_COMMIT_MESSAGE],
        sha: metadata[GIT_COMMIT_SHA],
      }, err => {
        assert.ifError(err)
        assert.ok(scope.isDone())
        done()
      })
    })
  }

  it('can still retrieve a PR diff when the local shallow head has a missing base', () => {
    git(checkout, ['fetch', '--depth=1', 'origin', headSha])
    git(checkout, ['checkout', '--detach', headSha])
    assert.throws(() => git(checkout, ['cat-file', '-e', baseSha]), { status: 1 })

    const metadata = getGitMetadata({ headCommitSha: headSha })
    const diff = getGitDiff(baseSha, headSha)

    assert.strictEqual(metadata[GIT_COMMIT_HEAD_AUTHOR_NAME], 'PR Author')
    assert.match(diff, /diff --git a\/history\.txt b\/history\.txt/)
    assert.match(diff, /-root/)
    assert.match(diff, /\+head/)
  })

  for (const legacyGit of [false, true]) {
    const suffix = legacyGit ? ' without GIT_NO_LAZY_FETCH support' : ''
    it(`does not lazily fetch head history in a shallow partial clone${suffix}`, () => {
      fs.rmSync(checkout, { recursive: true, force: true })
      git(directory, [
        'clone', '--depth=1', '--filter=blob:none', '--no-checkout', '--branch', 'juan-fernandez/merge',
        pathToFileURL(remote).href, checkout,
      ])
      assert.strictEqual(git(checkout, ['config', '--get', 'remote.origin.promisor']), 'true')
      if (legacyGit) {
        // Simulate Git versions predating GIT_NO_LAZY_FETCH; the transport guard must still prevent lazy downloads.
        getGitMetadata = proxyquire('../../../src/plugins/util/git', {
          './git-cache': {
            cachedExec: (command, flags, options) => cachedExecSpy(command, flags, {
              ...options,
              env: { ...process.env, ...options?.env, GIT_NO_LAZY_FETCH: '0' },
            }),
          },
        }).getGitMetadata
      }

      const metadata = getGitMetadata({ headCommitSha: headSha })

      assert.strictEqual(metadata[GIT_COMMIT_HEAD_AUTHOR_NAME], 'PR Author')
      assert.strictEqual(git(checkout, ['rev-list', '--count', headSha]), '1')
      const fetchedCommits = git(checkout, ['cat-file', '--batch-all-objects', '--batch-check=%(objecttype)'])
        .split('\n').filter(type => type === 'commit')
      assert.strictEqual(fetchedCommits.length, 2)
    })
  }
})
