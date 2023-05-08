'use strict'

const {
  FakeAgent,
  spawnProc,
  createSandbox,
  curlAndAssertMessage
} = require('./helpers')
const path = require('path')
const { assert } = require('chai')

describe(`sci embedding`, function () {
  let agent
  let proc
  let sandbox
  let cwd

  before(async () => {
    sandbox = await createSandbox(['express'])
    cwd = sandbox.folder
  })

  after(async () => {
    await sandbox.remove()
  })

  beforeEach(async () => {
    agent = await new FakeAgent().start()
  })

  afterEach(async () => {
    proc && proc.kill()
    await agent.stop()
  })

  context('via DD_GIT_* tags', () => {
    it('in the first span', async () => {
      proc = await spawnProc(path.join(cwd, 'sci-embedding/express.js'), {
        cwd,
        env: {
          AGENT_PORT: agent.port,
          DD_GIT_REPOSITORY_URL: 'git@github.com:DataDog/sci_git_example.git',
          DD_GIT_COMMIT_SHA: '13851f2b092e97acebab1b73f6c0e7818e795b50'
        }
      })
      return curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
        const firstSpan = payload[0][0]
        assert.equal(firstSpan.meta['_dd.git.commit.sha'], '13851f2b092e97acebab1b73f6c0e7818e795b50')
        assert.equal(firstSpan.meta['_dd.git.repository_url'], 'git@github.com:DataDog/sci_git_example.git')

        const secondSpan = payload[0][1]
        assert.notExists(secondSpan.meta['_dd.git.commit.sha'])
        assert.notExists(secondSpan.meta['_dd.git.repository_url'])
      })
    })
  })
  context('via DD_TAGS', () => {
    it('in the first span', async () => {
      proc = await spawnProc(path.join(cwd, 'sci-embedding/express.js'), {
        cwd,
        env: {
          AGENT_PORT: agent.port,
          DD_TAGS: 'git.repository_url:git@github.com:DataDog/sci_git_example.git,' +
           'git.commit.sha:13851f2b092e97acebab1b73f6c0e7818e795b50'
        }
      })
      return curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
        const firstSpan = payload[0][0]
        assert.equal(firstSpan.meta['_dd.git.commit.sha'], '13851f2b092e97acebab1b73f6c0e7818e795b50')
        assert.equal(firstSpan.meta['_dd.git.repository_url'], 'git@github.com:DataDog/sci_git_example.git')

        const secondSpan = payload[0][1]
        assert.notExists(secondSpan.meta['_dd.git.commit.sha'])
        assert.notExists(secondSpan.meta['_dd.git.repository_url'])
      })
    })
  })
})
