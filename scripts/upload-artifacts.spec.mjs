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

    it('recovers a failed retry only when the artifact can be downloaded', () => {
      const uploads = action.runs.steps.filter(step => step.uses?.startsWith('actions/upload-artifact@'))
      const downloads = action.runs.steps.filter(step => step.uses?.startsWith('actions/download-artifact@'))

      assert.strictEqual(uploads.length, 2)
      assert.strictEqual(uploads[0].id, 'upload')
      assert.strictEqual(uploads[0]['continue-on-error'], true)
      assert.match(uploads[1].if, /steps\.upload\.outcome == 'failure'/)
      assert.strictEqual(uploads[1].id, 'retry')
      assert.strictEqual(uploads[1]['continue-on-error'], true)
      assert.strictEqual(uploads[1].with.overwrite, true)

      assert.strictEqual(downloads.length, 1)
      assert.match(downloads[0].if, /steps\.retry\.outcome == 'failure'/)
      assert.strictEqual(downloads[0].with.name, uploads[0].with.name)
      assert.strictEqual(downloads[0].with.name, uploads[1].with.name)
      assert.match(downloads[0].with.path, /\$\{\{ runner\.temp \}\}/)
      assert.strictEqual(downloads[0]['continue-on-error'], undefined)
    })
  })
}
