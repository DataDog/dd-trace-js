'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')

const { describe, it, beforeEach, afterEach, before, after } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire').noPreserveCache()
const nock = require('nock')

const { assertObjectContains } = require('../../../../../../integration-tests/helpers')
require('../../../../../dd-trace/test/setup/core')
const { validateGitRepositoryUrl, validateGitCommitSha } = require('../../../../src/plugins/util/user-provided-git')

describe('git_metadata', () => {
  let gitMetadata
  // Used only by the retry test, which must exercise request.js retry logic end-to-end.
  let gitMetadataWithFastRequest
  let requestStub

  const latestCommits = ['87ce64f636853fbebc05edfcefe9cccc28a7968b', 'cc424c261da5e261b76d982d5d361a023556e2aa']
  // same character range but invalid length
  const badLatestCommits = [
    '87ce64f636853fbebc05edfcefe9cccc28a7968b8b',
    'cc424c261da5e261b76d982d5d361a023556e2aacc424c261da5e261b76d982d5d361a023556e2aa',
  ]

  const temporaryPackFile = `${os.tmpdir()}/1111-87ce64f636853fbebc05edfcefe9cccc28a7968b.pack`
  const secondTemporaryPackFile = `${os.tmpdir()}/1111-cc424c261da5e261b76d982d5d361a023556e2aa.pack`

  let getLatestCommitsStub
  let getRepositoryUrlStub
  let getCommitsRevListStub
  let generatePackFilesForCommitsStub
  let isShallowRepositoryStub
  let unshallowRepositoryStub
  let fakeConfig

  before(() => {
    fs.writeFileSync(temporaryPackFile, '')
    fs.writeFileSync(secondTemporaryPackFile, '')
    // The retry test uses nock; disableNetConnect ensures escaped requests fail
    // immediately rather than hanging for the 15 s request timeout.
    nock.disableNetConnect()
  })

  after(() => {
    fs.unlinkSync(temporaryPackFile)
    fs.unlinkSync(secondTemporaryPackFile)
    nock.enableNetConnect()
  })

  beforeEach(() => {
    getLatestCommitsStub = sinon.stub().returns(latestCommits)
    getCommitsRevListStub = sinon.stub().returns(latestCommits)
    getRepositoryUrlStub = sinon.stub().returns('git@github.com:DataDog/dd-trace-js.git')
    isShallowRepositoryStub = sinon.stub().returns(false)
    unshallowRepositoryStub = sinon.stub()

    generatePackFilesForCommitsStub = sinon.stub().returns([temporaryPackFile])

    fakeConfig = { apiKey: 'api-key', DD_CIVISIBILITY_GIT_UNSHALLOW_ENABLED: true }

    // Most tests inject requestStub directly so they never touch nock or the
    // real HTTP stack. This avoids the Windows CI hang caused by nock's
    // process.nextTick-based connectSocket() being skipped when the request is
    // considered destroyed before the tick fires, leaving done() uncalled.
    requestStub = sinon.stub()

    const gitStubs = {
      getLatestCommits: getLatestCommitsStub,
      getRepositoryUrl: getRepositoryUrlStub,
      generatePackFilesForCommits: generatePackFilesForCommitsStub,
      getCommitsRevList: getCommitsRevListStub,
      isShallowRepository: isShallowRepositoryStub,
      unshallowRepository: unshallowRepositoryStub,
    }

    gitMetadata = proxyquire('../../../../src/ci-visibility/exporters/git/git_metadata', {
      '../../../plugins/util/git': gitStubs,
      '../../../config': () => fakeConfig,
      '../../../exporters/common/request': requestStub,
    })

    // gitMetadataWithFastRequest keeps the real request.js (including retry
    // logic) wired through nock for the one test that validates retry behaviour.
    const fastRequest = proxyquire('../../../../src/exporters/common/request', {
      './retry': {
        ...require('../../../../src/exporters/common/retry'),
        getRetryDelay: () => 0,
      },
    })

    gitMetadataWithFastRequest = proxyquire('../../../../src/ci-visibility/exporters/git/git_metadata', {
      '../../../plugins/util/git': gitStubs,
      '../../../config': () => fakeConfig,
      '../../../exporters/common/request': fastRequest,
    })
  })

  afterEach(() => {
    nock.cleanAll()
  })

  it('does not unshallow if every commit is already in backend', (done) => {
    requestStub.callsArgWith(2, null,
      JSON.stringify({ data: latestCommits.map((sha) => ({ id: sha, type: 'commit' })) }),
      200)

    isShallowRepositoryStub.returns(true)
    gitMetadata.sendGitMetadata(new URL('https://api.test.com'), { isEvpProxy: false }, '', (err) => {
      sinon.assert.notCalled(unshallowRepositoryStub)
      assert.strictEqual(err, null)
      sinon.assert.calledOnce(requestStub)
      done()
    })
  })

  it('should unshallow if the repo is shallow and not every commit is in the backend', (done) => {
    requestStub.onCall(0).callsArgWith(2, null, JSON.stringify({ data: [] }), 200)
    requestStub.onCall(1).callsArgWith(2, null, JSON.stringify({ data: [] }), 200)
    requestStub.onCall(2).callsArgWith(2, null, '', 204)

    isShallowRepositoryStub.returns(true)
    gitMetadata.sendGitMetadata(new URL('https://api.test.com'), { isEvpProxy: false }, '', (err) => {
      sinon.assert.called(unshallowRepositoryStub)
      assert.strictEqual(err, null)
      sinon.assert.calledThrice(requestStub)
      done()
    })
  })

  it('should not unshallow if the parameter to enable unshallow is false', (done) => {
    fakeConfig.DD_CIVISIBILITY_GIT_UNSHALLOW_ENABLED = false
    requestStub.onCall(0).callsArgWith(2, null, JSON.stringify({ data: [] }), 200)
    requestStub.onCall(1).callsArgWith(2, null, JSON.stringify({ data: [] }), 200)
    requestStub.onCall(2).callsArgWith(2, null, '', 204)

    isShallowRepositoryStub.returns(true)
    gitMetadata.sendGitMetadata(new URL('https://api.test.com'), { isEvpProxy: false }, '', (err) => {
      sinon.assert.notCalled(unshallowRepositoryStub)
      assert.strictEqual(err, null)
      sinon.assert.calledThrice(requestStub)
      done()
    })
  })

  it('should request to /api/v2/git/repository/search_commits and /api/v2/git/repository/packfile', (done) => {
    requestStub.onCall(0).callsArgWith(2, null, JSON.stringify({ data: [] }), 200)
    requestStub.onCall(1).callsArgWith(2, null, '', 204)

    gitMetadata.sendGitMetadata(new URL('https://api.test.com'), { isEvpProxy: false }, '', (err) => {
      assert.strictEqual(err, null)
      sinon.assert.calledTwice(requestStub)
      assert.match(requestStub.getCall(0).args[1].path, /\/api\/v2\/git\/repository\/search_commits/)
      assert.match(requestStub.getCall(1).args[1].path, /\/api\/v2\/git\/repository\/packfile/)
      done()
    })
  })

  it('should not request to /api/v2/git/repository/packfile if the backend has the commit info', (done) => {
    requestStub.callsArgWith(2, null,
      JSON.stringify({ data: latestCommits.map((sha) => ({ id: sha, type: 'commit' })) }),
      200)

    getCommitsRevListStub.returns([])

    gitMetadata.sendGitMetadata(new URL('https://api.test.com'), { isEvpProxy: false }, '', (err) => {
      assert.strictEqual(err, null)
      sinon.assert.calledOnce(requestStub)
      done()
    })
  })

  it('should fail and not continue if first query results in anything other than 200', (done) => {
    const requestErr = Object.assign(
      new Error(
        'Error from https://api.test.com/api/v2/git/repository/search_commits: ' +
        '404 Not Found. Response from the endpoint: "Not found SHA"'
      ),
      { status: 404 }
    )
    requestStub.callsArgWith(2, requestErr, null, 404)

    gitMetadata.sendGitMetadata(new URL('https://api.test.com'), { isEvpProxy: false }, '', (err) => {
      assertObjectContains(err.message,
        'Error fetching commits to exclude: Error from https://api.test.com/' +
        'api/v2/git/repository/search_commits: 404 Not Found. ' +
        'Response from the endpoint: "Not found SHA"')
      sinon.assert.calledOnce(requestStub)
      done()
    })
  })

  it('should fail and not continue if the response are not correct commits', (done) => {
    requestStub.callsArgWith(2, null, JSON.stringify({ data: ['; rm -rf ;'] }), 200)

    gitMetadata.sendGitMetadata(new URL('https://api.test.com'), { isEvpProxy: false }, '', (err) => {
      assertObjectContains(err.message, "Can't parse commits to exclude response: Invalid commit type response")
      sinon.assert.calledOnce(requestStub)
      done()
    })
  })

  it('should fail and not continue if the response are badly formatted commits', (done) => {
    requestStub.callsArgWith(2, null,
      JSON.stringify({ data: badLatestCommits.map((sha) => ({ id: sha, type: 'commit' })) }),
      200)

    gitMetadata.sendGitMetadata(new URL('https://api.test.com'), { isEvpProxy: false }, '', (err) => {
      assertObjectContains(err.message, "Can't parse commits to exclude response: Invalid commit format")
      sinon.assert.calledOnce(requestStub)
      done()
    })
  })

  it('should fail if the packfile request returns anything other than 204', (done) => {
    requestStub.onCall(0).callsArgWith(2, null, JSON.stringify({ data: [] }), 200)
    requestStub.onCall(1).callsArgWith(2, Object.assign(new Error('502 Bad Gateway'), { status: 502 }), null, 502)

    gitMetadata.sendGitMetadata(new URL('https://api.test.com'), { isEvpProxy: false }, '', (err) => {
      assert.match(err.message, /Could not upload packfiles: status code 502/)
      sinon.assert.calledTwice(requestStub)
      done()
    })
  })

  it('should fail if the getCommitsRevList fails because the repository is too big', (done) => {
    // returning null means that the git rev-list failed
    getCommitsRevListStub.returns(null)
    requestStub.callsArgWith(2, null, JSON.stringify({ data: [] }), 200)

    gitMetadata.sendGitMetadata(new URL('https://api.test.com'), { isEvpProxy: false }, '', (err) => {
      assert.match(err.message, /git rev-list failed/)
      sinon.assert.calledOnce(requestStub)
      done()
    })
  })

  it('should fire a request per packfile', (done) => {
    requestStub.onCall(0).callsArgWith(2, null, JSON.stringify({ data: [] }), 200)
    requestStub.onCall(1).callsArgWith(2, null, '', 204)
    requestStub.onCall(2).callsArgWith(2, null, '', 204)
    requestStub.onCall(3).callsArgWith(2, null, '', 204)
    requestStub.onCall(4).callsArgWith(2, null, '', 204)

    generatePackFilesForCommitsStub.returns([
      temporaryPackFile,
      secondTemporaryPackFile,
      temporaryPackFile,
      secondTemporaryPackFile,
    ])

    gitMetadata.sendGitMetadata(new URL('https://api.test.com'), { isEvpProxy: false }, '', (err) => {
      assert.strictEqual(err, null)
      sinon.assert.callCount(requestStub, 5)
      done()
    })
  })

  describe('validateGitRepositoryUrl', () => {
    it('should return false if Git repository URL is invalid', () => {
      const invalidUrls = [
        'www.test.com/repo/dummy.git',
        'test.com/repo/dummy.git',
        'test.com/repo/dummy',
      ]
      invalidUrls.forEach((invalidUrl) => {
        assert.strictEqual(validateGitRepositoryUrl(invalidUrl), false)
      })
    })

    it('should return true if Git repository URL is valid', () => {
      const validUrls = [
        'https://test.com',
        'https://test.com/repo/dummy.git',
        'http://test.com/repo/dummy.git',
        'https://github.com/DataDog/dd-trace-js.git',
        'https://github.com/DataDog/dd-trace-js',
        'git@github.com:DataDog/dd-trace-js.git',
        'git@github.com:user/repo.git',
        'git@github.com:user/repo',
      ]

      validUrls.forEach((validUrl) => {
        assert.strictEqual(validateGitRepositoryUrl(validUrl), true)
      })
    })
  })

  describe('validateGitCommitSha', () => {
    it('should return false if Git commit SHA is invalid', () => {
      const invalidSha1 = 'cb466452bfe18d4f6be2836c2a5551843013cf382'
      const invalidSha2 = 'cb466452bfe18d4f6be2836c2a5551843013cf3!'
      const invalidSha3 = ''
      const invalidSha4 = 'test'
      const invalidSha5 = 'cb466452bfe18d4f6be2836c2a5551843013cf382cb466452bfe18d4f6be2836c2a5551843013cf382'
      const invalidSha6 = 'cb466452bfe18d4f6be2836c2a5551843013cf2'
      const invalidSha7 = 'cb466452bfe18d4f6be2836c2a5551843013cf3812342239203182304928'
      const invalidShas = [invalidSha1, invalidSha2, invalidSha3, invalidSha4, invalidSha5, invalidSha6, invalidSha7]
      invalidShas.forEach((invalidSha) => {
        assert.strictEqual(validateGitCommitSha(invalidSha), false)
      })
    })

    it('should return true if Git commit SHA is valid', () => {
      const validSha1 = 'cb466452bfe18d4f6be2836c2a5551843013cf38'
      const validSha2 = 'cb466452bfe18d4f6be2836c2a5551843013cf381234223920318230492823f3'

      const validShas = [validSha1, validSha2]
      validShas.forEach((validSha) => {
        assert.strictEqual(validateGitCommitSha(validSha), true)
      })
    })
  })

  it('should not crash if packfiles can not be accessed', (done) => {
    requestStub.callsArgWith(2, null, JSON.stringify({ data: [] }), 200)

    generatePackFilesForCommitsStub.returns([
      'not-there',
      'not there either',
    ])

    gitMetadata.sendGitMetadata(new URL('https://api.test.com'), { isEvpProxy: false }, '', (err) => {
      assert.match(err.message, /Could not read "not-there"/)
      sinon.assert.calledOnce(requestStub)
      done()
    })
  })

  it('should not crash if generatePackFiles returns an empty array', (done) => {
    requestStub.callsArgWith(2, null, JSON.stringify({ data: [] }), 200)

    generatePackFilesForCommitsStub.returns([])

    gitMetadata.sendGitMetadata(new URL('https://api.test.com'), { isEvpProxy: false }, '', (err) => {
      assert.match(err.message, /Failed to generate packfiles/)
      sinon.assert.calledOnce(requestStub)
      done()
    })
  })

  it('should not crash if git is missing', (done) => {
    const oldPath = process.env.PATH
    // git will not be found
    process.env.PATH = ''

    gitMetadata.sendGitMetadata(new URL('https://api.test.com'), { isEvpProxy: false }, '', (err) => {
      assert.match(err.message, /Git is not available/)
      sinon.assert.notCalled(requestStub)
      process.env.PATH = oldPath
      done()
    })
  })

  it('should retry if backend temporarily fails', (done) => {
    // This test exercises request.js retry logic end-to-end, so it uses the
    // real request module (gitMetadataWithFastRequest) backed by nock.
    // The shared retry helper only treats network errors with a transient `code`
    // (`ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, …) as retriable; uncoded errors
    // are no longer retried, matching real production failure modes.
    const transientError = Object.assign(new Error('Server unavailable'), { code: 'ECONNRESET' })

    const scope = nock('https://api.test.com')
      .post('/api/v2/git/repository/search_commits')
      .replyWithError(transientError)
      .post('/api/v2/git/repository/search_commits')
      .reply(200, JSON.stringify({ data: [] }))
      .post('/api/v2/git/repository/packfile')
      .replyWithError(transientError)
      .post('/api/v2/git/repository/packfile')
      .reply(204)

    gitMetadataWithFastRequest.sendGitMetadata(new URL('https://api.test.com'), { isEvpProxy: false }, '', (err) => {
      assert.strictEqual(err, null)
      assert.strictEqual(scope.isDone(), true)
      done()
    })
  })

  it('should append evp proxy prefix if configured', (done) => {
    requestStub.onCall(0).callsArgWith(2, null, JSON.stringify({ data: [] }), 200)
    requestStub.onCall(1).callsArgWith(2, null, '', 204)

    gitMetadata.sendGitMetadata(
      new URL('https://api.test.com'),
      { isEvpProxy: true, evpProxyPrefix: '/evp_proxy/v2' },
      '',
      (err) => {
        assert.strictEqual(err, null)
        sinon.assert.calledTwice(requestStub)
        assert.match(
          requestStub.getCall(0).args[1].path,
          /\/evp_proxy\/v2\/api\/v2\/git\/repository\/search_commits/
        )
        assert.strictEqual(requestStub.getCall(1).args[1].headers['X-Datadog-EVP-Subdomain'], 'api')
        assert.match(
          requestStub.getCall(1).args[1].path,
          /\/evp_proxy\/v2\/api\/v2\/git\/repository\/packfile/
        )
        done()
      })
  })

  it('should use the input repository url and not call getRepositoryUrl', (done) => {
    requestStub.onCall(0).callsArgWith(2, null, JSON.stringify({ data: [] }), 200)
    requestStub.onCall(1).callsArgWith(2, null, '', 204)

    gitMetadata.sendGitMetadata(
      new URL('https://api.test.com'),
      { isEvpProxy: true, evpProxyPrefix: '/evp_proxy/v2' },
      'https://custom-git@datadog.com',
      (err) => {
        assert.strictEqual(err, null)
        sinon.assert.notCalled(getRepositoryUrlStub)
        const { meta: { repository_url: repositoryUrl } } = JSON.parse(requestStub.getCall(0).args[0])
        assert.strictEqual(repositoryUrl, 'https://custom-git@datadog.com')
        done()
      })
  })
})
