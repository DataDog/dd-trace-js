import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, it } from 'mocha'

import { groupJunitReports, junitUploadEnv } from './upload-junit.mjs'

/**
 * @param {string | undefined} runAttempt
 */
function report (runAttempt) {
  const attempt = runAttempt ? `<property name="GITHUB_RUN_ATTEMPT" value="${runAttempt}"/>` : ''
  return '<testsuites><testsuite name="suite"><properties>' +
    `<property name="node_version" value="22.0.0"/>${attempt}` +
    '</properties><testcase name="test"/></testsuite></testsuites>'
}

describe('upload-junit', () => {
  describe('groupJunitReports', () => {
    let dir

    /**
     * @param {string} relativePath
     * @param {string} content
     */
    function writeReport (relativePath, content) {
      const path = join(dir, relativePath)
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, content)
      return path
    }

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'upload-junit-'))
    })

    afterEach(() => {
      rmSync(dir, { force: true, recursive: true })
    })

    it('groups reports by run id and stamped run attempt', () => {
      const a = writeReport('111/junit-a/node-22.0.0-junit.xml', report('1'))
      const b = writeReport('111/junit-b/node-22.0.0-junit.xml', report('1'))
      const rerun = writeReport('111/junit-c-retry-2/node-22.0.0-junit.xml', report('2'))
      const otherRun = writeReport('222/junit-a/node-22.0.0-junit.xml', report('1'))

      const groups = groupJunitReports(dir)

      assert.deepEqual(new Set(groups.map(group => ({ ...group, files: new Set(group.files) }))), new Set([
        { runId: '111', runAttempt: '1', files: new Set([a, b]) },
        { runId: '111', runAttempt: '2', files: new Set([rerun]) },
        { runId: '222', runAttempt: '1', files: new Set([otherRun]) },
      ]))
    })

    it('keeps reports without a stamped run attempt in their own group', () => {
      const stamped = writeReport('111/junit-a/node-22.0.0-junit.xml', report('1'))
      const unstamped = writeReport('111/junit-b/node-20.0.0-junit.xml', report())

      const groups = groupJunitReports(dir)

      assert.deepEqual(new Set(groups), new Set([
        { runId: '111', runAttempt: '1', files: [stamped] },
        { runId: '111', runAttempt: undefined, files: [unstamped] },
      ]))
    })

    it('ignores files that are not junit reports', () => {
      const junit = writeReport('111/junit-a/node-22.0.0-junit.xml', report('1'))
      writeReport('111/junit-a/coverage.xml', report('1'))
      writeReport('111/junit-a/notes.txt', 'not a report')

      assert.deepEqual(groupJunitReports(dir), [
        { runId: '111', runAttempt: '1', files: [junit] },
      ])
    })
  })

  describe('junitUploadEnv', () => {
    it('sets the run id and attempt for a stamped group', () => {
      assert.deepEqual(junitUploadEnv({ runId: '111', runAttempt: '2' }), {
        GITHUB_WORKFLOW: '',
        GITHUB_JOB: '',
        GITHUB_RUN_ID: '111',
        GITHUB_RUN_NUMBER: '',
        JOB_CHECK_RUN_ID: '',
        GITHUB_RUN_ATTEMPT: '2',
      })
    })

    it('leaves the run id blank for a group without a stamped attempt', () => {
      assert.deepEqual(junitUploadEnv({ runId: '111', runAttempt: undefined }), {
        GITHUB_WORKFLOW: '',
        GITHUB_JOB: '',
        GITHUB_RUN_ID: '',
        GITHUB_RUN_NUMBER: '',
        JOB_CHECK_RUN_ID: '',
      })
    })
  })
})
