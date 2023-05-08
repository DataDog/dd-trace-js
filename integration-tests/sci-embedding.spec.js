'use strict'

const {
  FakeAgent,
  spawnProc,
  createSandbox,
  curlAndAssertMessage
} = require('./helpers')
const path = require('path')
const { assert } = require('chai')
const { SCI_COMMIT_SHA, SCI_REPOSITORY_URL } = require('../packages/dd-trace/src/constants')

const DUMMY_GIT_SHA = '13851f2b092e97acebab1b73f6c0e7818e795b50'
const DUMMY_REPOSITORY_URL = 'git@github.com:DataDog/sci_git_example.git'

describe('sci embedding', function () {
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
    it('shows in the first span', async () => {
      proc = await spawnProc(path.join(cwd, 'sci-embedding/index.js'), {
        cwd,
        env: {
          AGENT_PORT: agent.port,
          DD_GIT_REPOSITORY_URL: DUMMY_REPOSITORY_URL,
          DD_GIT_COMMIT_SHA: DUMMY_GIT_SHA
        },
        stdio: 'inherit'
      })
      return curlAndAssertMessage(agent, proc, ({ payload }) => {
        const firstSpan = payload[0][0]
        assert.equal(firstSpan.meta[SCI_COMMIT_SHA], DUMMY_GIT_SHA)
        assert.equal(firstSpan.meta[SCI_REPOSITORY_URL], DUMMY_REPOSITORY_URL)

        const secondSpan = payload[0][1]
        assert.notExists(secondSpan.meta[SCI_COMMIT_SHA])
        assert.notExists(secondSpan.meta[SCI_REPOSITORY_URL])
      })
    })
  })
  context('via DD_TAGS', () => {
    it('shows in the first span', async () => {
      proc = await spawnProc(path.join(cwd, 'sci-embedding/index.js'), {
        cwd,
        env: {
          AGENT_PORT: agent.port,
          DD_TAGS: `git.repository_url:${DUMMY_REPOSITORY_URL},git.commit.sha:${DUMMY_GIT_SHA}`
        },
        stdio: 'inherit'
      })
      return curlAndAssertMessage(agent, proc, ({ payload }) => {
        const firstSpan = payload[0][0]
        assert.equal(firstSpan.meta[SCI_COMMIT_SHA], DUMMY_GIT_SHA)
        assert.equal(firstSpan.meta[SCI_REPOSITORY_URL], DUMMY_REPOSITORY_URL)

        const secondSpan = payload[0][1]
        assert.notExists(secondSpan.meta[SCI_COMMIT_SHA])
        assert.notExists(secondSpan.meta[SCI_REPOSITORY_URL])
      })
    })
  })
})
