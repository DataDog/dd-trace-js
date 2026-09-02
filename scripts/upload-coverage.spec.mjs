import assert from 'node:assert/strict'

import { describe, it } from 'mocha'

import { codecovUploadArgs, flagOf, shouldNotifyCodecov } from './upload-coverage.mjs'

describe('upload-coverage', () => {
  describe('flagOf', () => {
    it('lowercases the workflow name', () => {
      assert.equal(flagOf('AppSec'), 'appsec')
    })

    it('replaces spaces with hyphens', () => {
      assert.equal(flagOf('Test Optimization'), 'test-optimization')
    })

    it('collapses a run of invalid characters into one hyphen', () => {
      assert.equal(flagOf('APM  Integrations!!'), 'apm-integrations')
    })

    it('strips leading and trailing hyphens left by stripped characters', () => {
      assert.equal(flagOf('  AI Guard  '), 'ai-guard')
    })

    it('caps the result at 45 characters, the length Codecov accepts', () => {
      const flag = flagOf('a'.repeat(50))
      assert.equal(flag.length, 45)
      assert.equal(flag, 'a'.repeat(45))
    })
  })

  describe('codecovUploadArgs', () => {
    it('tags the upload with the given flag', () => {
      const args = codecovUploadArgs('coverage-upload/42/lcov', 'appsec', {
        sha: 'abc123', eventName: 'push', baseRef: 'master',
      })
      assert.deepEqual(args, [
        'do-upload', '--sha', 'abc123', '--dir', 'coverage-upload/42/lcov', '-F', 'appsec', '--fail-on-error',
      ])
    })

    it('adds --pr when a PR number is given', () => {
      const args = codecovUploadArgs('dir', 'appsec', {
        sha: 'abc123', prNumber: '9197', eventName: 'push', baseRef: 'master',
      })
      assert.ok(args.includes('--pr'))
      assert.equal(args[args.indexOf('--pr') + 1], '9197')
    })

    it('adds the master-coverage flag only for a pull_request targeting master', () => {
      const args = codecovUploadArgs('dir', 'appsec', {
        sha: 'abc123', eventName: 'pull_request', baseRef: 'master',
      })
      const flags = args.filter((arg, i) => args[i - 1] === '-F')
      assert.deepEqual(flags, ['appsec', 'master-coverage'])
    })

    it('does not add master-coverage for a pull_request targeting another branch', () => {
      const args = codecovUploadArgs('dir', 'appsec', {
        sha: 'abc123', eventName: 'pull_request', baseRef: 'v5',
      })
      const flags = args.filter((arg, i) => args[i - 1] === '-F')
      assert.deepEqual(flags, ['appsec'])
    })

    it('does not add master-coverage for a push event', () => {
      const args = codecovUploadArgs('dir', 'appsec', {
        sha: 'abc123', eventName: 'push', baseRef: 'master',
      })
      const flags = args.filter((arg, i) => args[i - 1] === '-F')
      assert.deepEqual(flags, ['appsec'])
    })
  })

  describe('shouldNotifyCodecov', () => {
    const ready = {
      isGitHubActions: true,
      failedRunCount: 0,
      uploadFailed: false,
      processingFailed: false,
      hasCommit: true,
    }

    it('notifies when every workflow and upload completed successfully', () => {
      assert.equal(shouldNotifyCodecov(ready), true)
    })

    it('does not notify outside GitHub Actions', () => {
      assert.equal(shouldNotifyCodecov({ ...ready, isGitHubActions: false }), false)
    })

    it('does not notify when a workflow failed', () => {
      assert.equal(shouldNotifyCodecov({ ...ready, failedRunCount: 1 }), false)
    })

    it('does not notify when an upload failed', () => {
      assert.equal(shouldNotifyCodecov({ ...ready, uploadFailed: true }), false)
    })

    it('does not notify when run processing failed', () => {
      assert.equal(shouldNotifyCodecov({ ...ready, processingFailed: true }), false)
    })

    it('does not notify before a Codecov report exists', () => {
      assert.equal(shouldNotifyCodecov({ ...ready, hasCommit: false }), false)
    })
  })
})
