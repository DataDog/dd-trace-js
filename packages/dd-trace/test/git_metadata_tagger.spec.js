'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach, afterEach } = require('tap').mocha

require('./setup/tap')

const agent = require('./plugins/agent')
const { SCI_COMMIT_SHA, SCI_REPOSITORY_URL } = require('../src/constants')

const DUMMY_GIT_SHA = '13851f2b092e97acebab1b73f6c0e7818e795b50'
const DUMMY_REPOSITORY_URL = 'git@github.com:DataDog/sci_git_example.git'

const oldEnv = process.env

describe('git metadata tagging', () => {
  let tracer

  beforeEach(() => {
    process.env = {
      ...oldEnv,
      DD_GIT_COMMIT_SHA: DUMMY_GIT_SHA,
      DD_TAGS: `git.repository_url:${DUMMY_REPOSITORY_URL}`
    }
    tracer = require('../')
    return agent.load()
  })

  afterEach(() => {
    agent.close()
  })

  afterEach(() => {
    process.env = oldEnv
  })

  it('should include git metadata when using DD_GIT_* tags and DD_TAGS', async () => {
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
})
