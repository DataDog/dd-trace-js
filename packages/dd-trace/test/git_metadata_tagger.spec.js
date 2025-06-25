'use strict'

const t = require('tap')
require('./setup/core')

const agent = require('./plugins/agent')
const { SCI_COMMIT_SHA, SCI_REPOSITORY_URL } = require('../src/constants')

const DUMMY_GIT_SHA = '13851f2b092e97acebab1b73f6c0e7818e795b50'
const DUMMY_REPOSITORY_URL = 'git@github.com:DataDog/sci_git_example.git'

const oldEnv = process.env

t.test('git metadata tagging', t => {
  let tracer

  t.beforeEach(() => {
    process.env = {
      ...oldEnv,
      DD_GIT_COMMIT_SHA: DUMMY_GIT_SHA,
      DD_TAGS: `git.repository_url:${DUMMY_REPOSITORY_URL}`
    }
    tracer = require('../')
    return agent.load()
  })

  t.afterEach(() => {
    agent.close()
  })

  t.afterEach(() => {
    process.env = oldEnv
  })

  t.test('should include git metadata when using DD_GIT_* tags and DD_TAGS', () => {
    const span = tracer.startSpan('hello', {
      tags: {
        'resource.name': '/hello/:name'
      }
    })

    const childSpan = tracer.startSpan('world', {
      childOf: span
    })

    childSpan.finish()
    span.finish()

    return agent.assertSomeTraces((payload) => {
      const firstSpan = payload[0][0]
      expect(firstSpan.meta[SCI_COMMIT_SHA]).to.equal(DUMMY_GIT_SHA)
      expect(firstSpan.meta[SCI_REPOSITORY_URL]).to.equal(DUMMY_REPOSITORY_URL)

      const secondSpan = payload[0][1]
      expect(secondSpan.meta[SCI_COMMIT_SHA]).not.to.exist
      expect(secondSpan.meta[SCI_REPOSITORY_URL]).not.to.exist
    })
  })
  t.end()
})
