import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, it } from 'mocha'

const repositoryDirectory = dirname(dirname(fileURLToPath(import.meta.url)))
const checkerPath = join(repositoryDirectory, 'scripts', 'check-agents-md-size.js')

describe('check-agents-md-size', () => {
  let temporaryDirectory

  beforeEach(() => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'dd-trace-agents-md-'))
  })

  afterEach(() => {
    rmSync(temporaryDirectory, { recursive: true, force: true })
  })

  function runChecker (lineCount) {
    const content = Array.from({ length: lineCount }, (_, index) => `line ${index + 1}`).join('\n') + '\n'
    writeFileSync(join(temporaryDirectory, 'AGENTS.md'), content)

    return spawnSync(process.execPath, [checkerPath], {
      cwd: temporaryDirectory,
      encoding: 'utf8',
    })
  }

  it('accepts an AGENTS.md file with 200 lines', () => {
    const result = runChecker(200)

    assert.strictEqual(result.status, 0)
    assert.strictEqual(result.stderr, '')
  })

  it('rejects an AGENTS.md file with more than 200 lines', () => {
    const result = runChecker(201)

    assert.strictEqual(result.status, 1)
    assert.match(result.stderr, /AGENTS\.md has 201 lines/)
    assert.match(result.stderr, /Keep AGENTS\.md at 200 lines or fewer/)
    assert.match(result.stderr, /added content can become a skill of its own/)
  })
})
