'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach, afterEach, before, after } = require('tap').mocha
const sinon = require('sinon')
const proxyquire = require('proxyquire').noPreserveCache()
const nock = require('nock')
const fs = require('node:fs')
const os = require('node:os')

require('../../../../../dd-trace/test/setup/core')

const { validateGitRepositoryUrl, validateGitCommitSha } = require('../../../../src/plugins/util/user-provided-git')

describe('git-metadata', () => {
  let gitMetadata

  const latestCommits = ['87ce64f636853fbebc05edfcefe9cccc28a7968b', 'cc424c261da5e261b76d982d5d361a023556e2aa']
  // same character range but invalid length
  const badLatestCommits = [
    '87ce64f636853fbebc05edfcefe9cccc28a7968b8b',
    'cc424c261da5e261b76d982d5d361a023556e2aacc424c261da5e261b76d982d5d361a023556e2aa'
  ]

  const temporaryPackFile = `${os.tmpdir()}/1111-87ce64f636853fbebc05edfcefe9cccc28a7968b.pack`
  const secondTemporaryPackFile = `${os.tmpdir()}/1111-cc424c261da5e261b76d982d5d361a023556e2aa.pack`

  let getLatestCommitsStub
  let getRepositoryUrlStub
  let getCommitsRevListStub
  let generatePackFilesForCommitsStub
  let isShallowRepositoryStub
  let unshallowRepositoryStub

  before(() => {
    process.env.DD_API_KEY = 'api-key'
    fs.writeFileSync(temporaryPackFile, '')
    fs.writeFileSync(secondTemporaryPackFile, '')
  })

  after(() => {
    delete process.env.DD_API_KEY
    delete process.env.DD_CIVISIBILITY_GIT_UNSHALLOW_ENABLED
    fs.unlinkSync(temporaryPackFile)
    fs.unlinkSync(secondTemporaryPackFile)
  })

  beforeEach(() => {
    getLatestCommitsStub = sinon.stub().returns(latestCommits)
    getCommitsRevListStub = sinon.stub().returns(latestCommits)
    getRepositoryUrlStub = sinon.stub().returns('git@github.com:DataDog/dd-trace-js.git')
    isShallowRepositoryStub = sinon.stub().returns(false)
    unshallowRepositoryStub = sinon.stub()

    generatePackFilesForCommitsStub = sinon.stub().returns([temporaryPackFile])

    gitMetadata = proxyquire('../../../../src/ci-visibility/exporters/git/git-metadata', {
      '../../../plugins/util/git': {
        getLatestCommits: getLatestCommitsStub,
        getRepositoryUrl: getRepositoryUrlStub,
        generatePackFilesForCommits: generatePackFilesForCommitsStub,
        getCommitsRevList: getCommitsRevListStub,
        isShallowRepository: isShallowRepositoryStub,
        unshallowRepository: unshallowRepositoryStub
      }
    })
  })

  afterEach(() => {
    nock.cleanAll()
  })

  it('does not unshallow if every commit is already in backend', (done) => {
    const scope = nock('https://api.test.com')
      .post('/api/v2/git/repository/search_commits')
      .reply(200, JSON.stringify({ data: latestCommits.map((sha) => ({ id: sha, type: 'commit' })) }))

    isShallowRepositoryStub.returns(true)
    gitMetadata.sendGitMetadata(new URL('https://api.test.com'), { isEvpProxy: false }, '', (err) => {
      expect(unshallowRepositoryStub).not.to.have.been.called
      expect(err).to.be.null
      expect(scope.isDone()).to.be.true
      done()
    })
  })

  it('should unshallow if the repo is shallow and not every commit is in the backend', (done) => {
    const scope = nock('https://api.test.com')
      .post('/api/v2/git/repository/search_commits')
      .reply(200, JSON.stringify({ data: [] }))
      .post('/api/v2/git/repository/search_commits') // calls a second time after unshallowing
      .reply(200, JSON.stringify({ data: [] }))
      .post('/api/v2/git/repository/packfile')
      .reply(204)

    isShallowRepositoryStub.returns(true)
    gitMetadata.sendGitMetadata(new URL('https://api.test.com'), { isEvpProxy: false }, '', (err) => {
      expect(unshallowRepositoryStub).to.have.been.called
      expect(err).to.be.null
      expect(scope.isDone()).to.be.true
      done()
    })
  })

  it('should not unshallow if the parameter to enable unshallow is false', (done) => {
    process.env.DD_CIVISIBILITY_GIT_UNSHALLOW_ENABLED = false
    const scope = nock('https://api.test.com')
      .post('/api/v2/git/repository/search_commits')
      .reply(200, JSON.stringify({ data: [] }))
      .post('/api/v2/git/repository/search_commits') // calls a second time after unshallowing
      .reply(200, JSON.stringify({ data: [] }))
      .post('/api/v2/git/repository/packfile')
      .reply(204)

    isShallowRepositoryStub.returns(true)
    gitMetadata.sendGitMetadata(new URL('https://api.test.com'), { isEvpProxy: false }, '', (err) => {
      expect(unshallowRepositoryStub).not.to.have.been.called
      expect(err).to.be.null
      expect(scope.isDone()).to.be.true
      done()
    })
  })

  it('should request to /api/v2/git/repository/search_commits and /api/v2/git/repository/packfile', (done) => {
    const scope = nock('https://api.test.com')
      .post('/api/v2/git/repository/search_commits')
      .reply(200, JSON.stringify({ data: [] }))
      .post('/api/v2/git/repository/packfile')
      .reply(204)

    gitMetadata.sendGitMetadata(new URL('https://api.test.com'), { isEvpProxy: false }, '', (err) => {
      expect(err).to.be.null
      expect(scope.isDone()).to.be.true
      done()
    })
  })

  it('should not request to /api/v2/git/repository/packfile if the backend has the commit info', (done) => {
    const scope = nock('https://api.test.com')
      .post('/api/v2/git/repository/search_commits')
      .reply(200, JSON.stringify({ data: latestCommits.map((sha) => ({ id: sha, type: 'commit' })) }))
      .post('/api/v2/git/repository/packfile')
      .reply(204)

    getCommitsRevListStub.returns([])

    gitMetadata.sendGitMetadata(new URL('https://api.test.com'), { isEvpProxy: false }, '', (err) => {
      expect(err).to.be.null
      // to check that it is not called
      expect(scope.isDone()).to.be.false
      expect(scope.pendingMocks()).to.contain('POST https://api.test.com:443/api/v2/git/repository/packfile')
      done()
    })
  })

  it('should fail and not continue if first query results in anything other than 200', (done) => {
    const scope = nock('https://api.test.com')
      .post('/api/v2/git/repository/search_commits')
      .reply(404, 'Not found SHA')
      .post('/api/v2/git/repository/packfile')
      .reply(204)

    gitMetadata.sendGitMetadata(new URL('https://api.test.com'), { isEvpProxy: false }, '', (err) => {
      expect(err.message).to.contain('Error fetching commits to exclude: Error from https://api.test.com/api/v2/git/repository/search_commits: 404 Not Found. Response from the endpoint: "Not found SHA"')
      // to check that it is not called
      expect(scope.isDone()).to.be.false
      expect(scope.pendingMocks()).to.contain('POST https://api.test.com:443/api/v2/git/repository/packfile')
      done()
    })
  })

  it('should fail and not continue if the response are not correct commits', (done) => {
    const scope = nock('https://api.test.com')
      .post('/api/v2/git/repository/search_commits')
      .reply(200, JSON.stringify({ data: ['; rm -rf ;'] }))
      .post('/api/v2/git/repository/packfile')
      .reply(204)

    gitMetadata.sendGitMetadata(new URL('https://api.test.com'), { isEvpProxy: false }, '', (err) => {
      expect(err.message).to.contain("Can't parse commits to exclude response: Invalid commit type response")
      // to check that it is not called
      expect(scope.isDone()).to.be.false
      expect(scope.pendingMocks()).to.contain('POST https://api.test.com:443/api/v2/git/repository/packfile')
      done()
    })
  })

  it('should fail and not continue if the response are badly formatted commits', (done) => {
    const scope = nock('https://api.test.com')
      .post('/api/v2/git/repository/search_commits')
      .reply(200, JSON.stringify({ data: badLatestCommits.map((sha) => ({ id: sha, type: 'commit' })) }))
      .post('/api/v2/git/repository/packfile')
      .reply(204)

    gitMetadata.sendGitMetadata(new URL('https://api.test.com'), { isEvpProxy: false }, '', (err) => {
      expect(err.message).to.contain("Can't parse commits to exclude response: Invalid commit format")
      // to check that it is not called
      expect(scope.isDone()).to.be.false
      expect(scope.pendingMocks()).to.contain('POST https://api.test.com:443/api/v2/git/repository/packfile')
      done()
    })
  })

  it('should fail if the packfile request returns anything other than 204', (done) => {
    const scope = nock('https://api.test.com')
      .post('/api/v2/git/repository/search_commits')
      .reply(200, JSON.stringify({ data: [] }))
      .post('/api/v2/git/repository/packfile')
      .reply(502)

    gitMetadata.sendGitMetadata(new URL('https://api.test.com'), { isEvpProxy: false }, '', (err) => {
      expect(err.message).to.contain('Could not upload packfiles: status code 502')
      expect(scope.isDone()).to.be.true
      done()
    })
  })

  it('should fail if the getCommitsRevList fails because the repository is too big', (done) => {
    // returning null means that the git rev-list failed
    getCommitsRevListStub.returns(null)
    const scope = nock('https://api.test.com')
      .post('/api/v2/git/repository/search_commits')
      .reply(200, JSON.stringify({ data: [] }))

    gitMetadata.sendGitMetadata(new URL('https://api.test.com'), { isEvpProxy: false }, '', (err) => {
      expect(err.message).to.contain('git rev-list failed')
      expect(scope.isDone()).to.be.true
      done()
    })
  })

  it('should fire a request per packfile', (done) => {
    const scope = nock('https://api.test.com')
      .post('/api/v2/git/repository/search_commits')
      .reply(200, JSON.stringify({ data: [] }))
      .post('/api/v2/git/repository/packfile')
      .reply(204)
      .post('/api/v2/git/repository/packfile')
      .reply(204)
      .post('/api/v2/git/repository/packfile')
      .reply(204)
      .post('/api/v2/git/repository/packfile')
      .reply(204)

    generatePackFilesForCommitsStub.returns([
      temporaryPackFile,
      secondTemporaryPackFile,
      temporaryPackFile,
      secondTemporaryPackFile
    ])

    gitMetadata.sendGitMetadata(new URL('https://api.test.com'), { isEvpProxy: false }, '', (err) => {
      expect(err).to.be.null
      expect(scope.isDone()).to.be.true
      done()
    })
  })

  describe('validateGitRepositoryUrl', () => {
    it('should return false if Git repository URL is invalid', () => {
      const invalidUrls = [
        'www.test.com/repo/dummy.git',
        'test.com/repo/dummy.git',
        'test.com/repo/dummy'
      ]
      invalidUrls.forEach((invalidUrl) => {
        expect(validateGitRepositoryUrl(invalidUrl), `${invalidUrl} is a valid URL`).to.be.false
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
        'git@github.com:user/repo'
      ]

      validUrls.forEach((validUrl) => {
        expect(validateGitRepositoryUrl(validUrl), `${validUrl} is an invalid URL`).to.be.true
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
        expect(validateGitCommitSha(invalidSha)).to.be.false
      })
    })

    it('should return true if Git commit SHA is valid', () => {
      const validSha1 = 'cb466452bfe18d4f6be2836c2a5551843013cf38'
      const validSha2 = 'cb466452bfe18d4f6be2836c2a5551843013cf381234223920318230492823f3'

      const validShas = [validSha1, validSha2]
      validShas.forEach((validSha) => {
        expect(validateGitCommitSha(validSha)).to.be.true
      })
    })
  })

  it('should not crash if packfiles can not be accessed', (done) => {
    const scope = nock('https://api.test.com')
      .post('/api/v2/git/repository/search_commits')
      .reply(200, JSON.stringify({ data: [] }))
      .post('/api/v2/git/repository/packfile')
      .reply(204)

    generatePackFilesForCommitsStub.returns([
      'not-there',
      'not there either'
    ])

    gitMetadata.sendGitMetadata(new URL('https://api.test.com'), { isEvpProxy: false }, '', (err) => {
      expect(err.message).to.contain('Could not read "not-there"')
      expect(scope.isDone()).to.be.false
      done()
    })
  })

  it('should not crash if generatePackFiles returns an empty array', (done) => {
    const scope = nock('https://api.test.com')
      .post('/api/v2/git/repository/search_commits')
      .reply(200, JSON.stringify({ data: [] }))
      .post('/api/v2/git/repository/packfile')
      .reply(204)

    generatePackFilesForCommitsStub.returns([])

    gitMetadata.sendGitMetadata(new URL('https://api.test.com'), { isEvpProxy: false }, '', (err) => {
      expect(err.message).to.contain('Failed to generate packfiles')
      expect(scope.isDone()).to.be.false
      done()
    })
  })

  it('should not crash if git is missing', (done) => {
    const oldPath = process.env.PATH
    // git will not be found
    process.env.PATH = ''

    const scope = nock('https://api.test.com')
      .post('/api/v2/git/repository/search_commits')
      .reply(200, JSON.stringify({ data: [] }))
      .post('/api/v2/git/repository/packfile')
      .reply(204)

    gitMetadata.sendGitMetadata(new URL('https://api.test.com'), { isEvpProxy: false }, '', (err) => {
      expect(err.message).to.contain('Git is not available')
      expect(scope.isDone()).to.be.false
      process.env.PATH = oldPath
      done()
    })
  })

  it('should retry if backend temporarily fails', (done) => {
    const scope = nock('https://api.test.com')
      .post('/api/v2/git/repository/search_commits')
      .replyWithError('Server unavailable')
      .post('/api/v2/git/repository/search_commits')
      .reply(200, JSON.stringify({ data: [] }))
      .post('/api/v2/git/repository/packfile')
      .replyWithError('Server unavailable')
      .post('/api/v2/git/repository/packfile')
      .reply(204)

    gitMetadata.sendGitMetadata(new URL('https://api.test.com'), { isEvpProxy: false }, '', (err) => {
      expect(err).to.be.null
      expect(scope.isDone()).to.be.true
      done()
    })
  })

  it('should append evp proxy prefix if configured', (done) => {
    const scope = nock('https://api.test.com')
      .post('/evp_proxy/v2/api/v2/git/repository/search_commits')
      .reply(200, JSON.stringify({ data: [] }))
      .post('/evp_proxy/v2/api/v2/git/repository/packfile')
      .reply(204, function (uri, body) {
        expect(this.req.headers['x-datadog-evp-subdomain']).to.equal('api')
        done()
      })

    gitMetadata.sendGitMetadata(
      new URL('https://api.test.com'),
      { isEvpProxy: true, evpProxyPrefix: '/evp_proxy/v2' },
      '',
      (err) => {
        expect(err).to.be.null
        expect(scope.isDone()).to.be.true
      })
  })

  it('should use the input repository url and not call getRepositoryUrl', (done) => {
    let resolvePromise
    const requestPromise = new Promise(resolve => {
      resolvePromise = resolve
    })
    const scope = nock('https://api.test.com')
      .post('/evp_proxy/v2/api/v2/git/repository/search_commits')
      .reply(200, function () {
        const { meta: { repository_url: repositoryUrl } } = JSON.parse(this.req.requestBodyBuffers.toString())
        resolvePromise(repositoryUrl)
        return JSON.stringify({ data: [] })
      })
      .post('/evp_proxy/v2/api/v2/git/repository/packfile')
      .reply(204)

    gitMetadata.sendGitMetadata(
      new URL('https://api.test.com'),
      { isEvpProxy: true, evpProxyPrefix: '/evp_proxy/v2' },
      'https://custom-git@datadog.com',
      (err) => {
        expect(err).to.be.null
        expect(scope.isDone()).to.be.true
        requestPromise.then((repositoryUrl) => {
          expect(getRepositoryUrlStub).not.to.have.been.called
          expect(repositoryUrl).to.equal('https://custom-git@datadog.com')
          done()
        })
      })
  })
})
