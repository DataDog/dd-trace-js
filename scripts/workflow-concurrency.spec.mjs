import assert from 'node:assert/strict'
import fs from 'node:fs'

import { describe, it } from 'mocha'
import YAML from 'yaml'

/** @param {string} name */
function readWorkflow (name) {
  const url = new URL(`../.github/workflows/${name}.yml`, import.meta.url)
  return YAML.parse(fs.readFileSync(url, 'utf8'))
}

describe('workflow concurrency', () => {
  it('keeps Electron aligned with All Green on master', () => {
    const allGreen = readWorkflow('all-green')
    const electron = readWorkflow('electron')

    assert.strictEqual(electron.concurrency.group, allGreen.concurrency.group)
  })
})
