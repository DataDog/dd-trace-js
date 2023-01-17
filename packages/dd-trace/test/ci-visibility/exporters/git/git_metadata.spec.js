'use strict'
const nock = require('nock')
const os = require('os')
const fs = require('fs')

const proxyquire = require('proxyquire').noPreserveCache()

describe('git_metadata', () => {
  let gitMetadata

  const latestCommits = ['87ce64f636853fbebc05edfcefe9cccc28a7968b', 'cc424c261da5e261b76d982d5d361a023556e2aa']
  const temporaryPackFile = `${os.tmpdir()}/1111-87ce64f636853fbebc05edfcefe9cccc28a7968b.pack`
  const secondTemporaryPackFile = `${os.tmpdir()}/1111-cc424c261da5e261b76d982d5d361a023556e2aa.pack`

  let getLatestCommitsStub
  let getRepositoryUrlStub
  let getCommitsToUploadStub
  let generatePackFilesForCommitsStub

  before(() => {
    process.env.DD_API_KEY = 'api-key'
    fs.writeFileSync(temporaryPackFile, '')
    fs.writeFileSync(secondTemporaryPackFile, '')
  })

  after(() => {
    delete process.env.DD_API_KEY
    fs.unlinkSync(temporaryPackFile)
    fs.unlinkSync(secondTemporaryPackFile)
  })

  beforeEach(() => {
    getLatestCommitsStub = sinon.stub().returns(latestCommits)
    getCommitsToUploadStub = sinon.stub().returns(latestCommits)
    getRepositoryUrlStub = sinon.stub().returns('git@github.com:DataDog/dd-trace-js.git')

    generatePackFilesForCommitsStub = sinon.stub().returns([temporaryPackFile])

    gitMetadata = proxyquire('../../../../src/ci-visibility/exporters/git/git_metadata', {
      '../../../plugins/util/git': {
        getLatestCommits: getLatestCommitsStub,
        getRepositoryUrl: getRepositoryUrlStub,
        generatePackFilesForCommits: generatePackFilesForCommitsStub,
        getCommitsToUpload: getCommitsToUploadStub
      }
    })
  })

  afterEach(() => {
    nock.cleanAll()
  })

  it('should request to /api/v2/git/repository/search_commits and /api/v2/git/repository/packfile', (done) => {
    const scope = nock('https://api.test.com')
      .post('/api/v2/git/repository/search_commits')
      .reply(200, JSON.stringify({ data: [] }))
      .post('/api/v2/git/repository/packfile')
      .reply(204)

    gitMetadata.sendGitMetadata(new URL('https://api.test.com'), false, (err) => {
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

    getCommitsToUploadStub.returns([])

    gitMetadata.sendGitMetadata(new URL('https://api.test.com'), false, (err) => {
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

    gitMetadata.sendGitMetadata(new URL('https://api.test.com'), false, (err) => {
      // eslint-disable-next-line
      expect(err.message).to.contain('Error fetching commits to exclude: Error from https://api.test.com//api/v2/git/repository/search_commits: 404 Not Found. Response from the endpoint: "Not found SHA"')
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

    gitMetadata.sendGitMetadata(new URL('https://api.test.com'), false, (err) => {
      expect(err.message).to.contain("Can't parse commits to exclude response: Invalid commit type response")
      // to check that it is not called
      expect(scope.isDone()).to.be.false
      expect(scope.pendingMocks()).to.contain('POST https://api.test.com:443/api/v2/git/repository/packfile')
      done()
    })
  })

  it('should fail if the packfile request returns anything other than 204', (done) => {
    const scope = nock('https://api.test.com')
      .post('/api/v2/git/repository/search_commits')
      .reply(200, JSON.stringify({ data: latestCommits.map((sha) => ({ id: sha, type: 'commit' })) }))
      .post('/api/v2/git/repository/packfile')
      .reply(502)

    gitMetadata.sendGitMetadata(new URL('https://api.test.com'), false, (err) => {
      expect(err.message).to.contain('Could not upload packfiles: status code 502')
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

    gitMetadata.sendGitMetadata(new URL('https://api.test.com'), false, (err) => {
      expect(err).to.be.null
      expect(scope.isDone()).to.be.true
      done()
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

    gitMetadata.sendGitMetadata(new URL('https://api.test.com'), false, (err) => {
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

    gitMetadata.sendGitMetadata(new URL('https://api.test.com'), false, (err) => {
      expect(err.message).to.contain('Failed to generate packfiles')
      expect(scope.isDone()).to.be.false
      done()
    })
  })

  it('should not crash if git is missing', (done) => {
    const scope = nock('https://api.test.com')
      .post('/api/v2/git/repository/search_commits')
      .reply(200, JSON.stringify({ data: [] }))
      .post('/api/v2/git/repository/packfile')
      .reply(204)

    getRepositoryUrlStub.returns('')

    gitMetadata.sendGitMetadata(new URL('https://api.test.com'), false, (err) => {
      expect(err.message).to.contain('Repository URL is empty')
      expect(scope.isDone()).to.be.false
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

    gitMetadata.sendGitMetadata(new URL('https://api.test.com'), false, (err) => {
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

    gitMetadata.sendGitMetadata(new URL('https://api.test.com'), true, (err) => {
      expect(err).to.be.null
      expect(scope.isDone()).to.be.true
    })
  })
})
