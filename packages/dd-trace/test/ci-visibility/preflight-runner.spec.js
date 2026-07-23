'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { runFrameworkPreflight } = require('../../../../ci/test-optimization-validation/preflight-runner')

describe('test optimization validation preflight runner', () => {
  it('selects the first successful whole-file candidate and does not run later candidates', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-preflight-'))
    const out = path.join(root, 'results')
    const marker = path.join(root, 'third-candidate-ran')
    const framework = getFramework(root, [
      getCandidate(root, 'first.test.js', 'console.log("0 passing")'),
      getCandidate(root, 'second.test.js', 'console.log("2 passing")'),
      getCandidate(root, 'third.test.js', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`),
    ])
    fs.mkdirSync(out)

    try {
      const result = await runFrameworkPreflight({
        framework,
        out,
        options: { repositoryRoot: root },
      })

      assert.strictEqual(result.ok, true)
      assert.strictEqual(result.preflight.selectedCandidateIndex, 1)
      assert.strictEqual(result.preflight.observedTestCount, 2)
      assert.strictEqual(result.preflight.attempts.length, 2)
      assert.deepStrictEqual(framework.existingTestCommand, framework.localTestCandidates[1].command)
      assert.strictEqual(fs.existsSync(marker), false)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('returns an incomplete adapter result after every approved candidate is rejected', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-preflight-'))
    const out = path.join(root, 'results')
    const framework = getFramework(root, [
      getCandidate(root, 'first.test.js', 'console.log("0 passing")'),
      getCandidate(root, 'second.test.js', 'console.log("Tests finished without a count")'),
    ])
    fs.mkdirSync(out)

    try {
      const result = await runFrameworkPreflight({
        framework,
        out,
        options: { repositoryRoot: root },
      })

      assert.strictEqual(result.ok, false)
      assert.strictEqual(result.failure.status, 'error')
      assert.strictEqual(result.failure.evidence.validationIncomplete, true)
      assert.strictEqual(result.failure.evidence.domain, 'validator_adapter')
      assert.strictEqual(result.failure.evidence.candidateAttempts.length, 2)
      assert.match(result.failure.diagnosis, /None of the 2 approved whole-file test candidates/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

/**
 * Creates a runnable framework fixture.
 *
 * @param {string} root repository root
 * @param {object[]} candidates local test candidates
 * @returns {object} framework fixture
 */
function getFramework (root, candidates) {
  return {
    id: 'mocha:root',
    framework: 'mocha',
    existingTestCommand: candidates[0].command,
    localTestCandidates: candidates,
    preflight: {
      status: 'pending',
      maxTestCount: 50,
    },
    project: { root },
  }
}

/**
 * Creates a whole-file candidate that prints deterministic test output.
 *
 * @param {string} root repository root
 * @param {string} sourceFile source file name
 * @param {string} source inline Node.js source
 * @returns {object} candidate fixture
 */
function getCandidate (root, sourceFile, source) {
  const absoluteSourceFile = path.join(root, sourceFile)
  fs.writeFileSync(absoluteSourceFile, '// candidate fixture\n')
  return {
    sourceFile: absoluteSourceFile,
    maxTestCount: 50,
    command: {
      cwd: root,
      argv: [process.execPath, '-e', source],
    },
  }
}
