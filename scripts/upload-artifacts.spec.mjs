import assert from 'node:assert/strict'
import fs from 'node:fs'

import { describe, it } from 'mocha'
import YAML from 'yaml'

const actions = new Map([
  ['coverage', '../.github/actions/upload-coverage-artifact/action.yml'],
  ['JUnit', '../.github/actions/upload-junit-artifacts/action.yml'],
])

for (const [name, path] of actions) {
  describe(`${name} artifact upload`, () => {
    const action = YAML.parse(fs.readFileSync(new URL(path, import.meta.url), 'utf8'))

    it('retries under a distinct name after a failed upload', () => {
      const uploads = action.runs.steps.filter(step => step.uses?.startsWith('actions/upload-artifact@'))

      assert.strictEqual(uploads.length, 2)
      assert.strictEqual(uploads[0]['continue-on-error'], true)
      assert.strictEqual(uploads[1].if.includes("steps.upload.outcome == 'failure'"), true)
      assert.strictEqual(uploads[1]['continue-on-error'], undefined)
      assert.strictEqual(uploads[1].with.name, `${uploads[0].with.name}-retry-\${{ github.run_attempt }}`)
      assert.strictEqual(uploads[1].with.overwrite, undefined)
    })
  })
}
