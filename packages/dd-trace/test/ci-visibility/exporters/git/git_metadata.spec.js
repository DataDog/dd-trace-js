'use strict'
const nock = require('nock')
const os = require('os')
const fs = require('fs')

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

    gitMetadata.sendGitMetadata('test.com', (err) => {
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

    gitMetadata.sendGitMetadata('test.com', (err) => {
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
      .reply(500)
      .post('/api/v2/git/repository/packfile')
      .reply(204)

    gitMetadata.sendGitMetadata('test.com', (err) => {
      expect(err.message).to.contain('Error getting commits: 500')
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

    gitMetadata.sendGitMetadata('test.com', (err) => {
      expect(err.message).to.contain("Can't parse response")
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

    gitMetadata.sendGitMetadata('test.com', (err) => {
      expect(err.message).to.contain('Error uploading packfiles: 502')
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

    gitMetadata.sendGitMetadata('test.com', (err) => {
      expect(err).to.be.null
      expect(scope.isDone()).to.be.true
      done()
    })
  })
})
