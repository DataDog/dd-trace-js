import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, it } from 'mocha'

import junitFile from './junit-file.js'

const { getJunitFile, sanitizeName } = junitFile
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

describe('JUnit report filenames', () => {
  it('creates portable suite-specific filenames', () => {
    assert.strictEqual(sanitizeName('test:plugins / latest'), 'test-plugins-latest')
    assert.strictEqual(
      getJunitFile('test:plugins / latest', '24.1.0'),
      './node-24.1.0-test-plugins-latest-junit.xml'
    )
  })

  it('keeps reports from sequential npm suites separate', () => {
    const command = "process.stdout.write(require('./.mochamultireporterrc')" +
      '.scriptsJunitReporterJsReporterOptions.mochaFile)'
    const first = execFileSync(process.execPath, ['-e', command], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, CI: 'true', npm_lifecycle_event: 'test:first' },
    })
    const second = execFileSync(process.execPath, ['-e', command], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, CI: 'true', npm_lifecycle_event: 'test:second' },
    })

    assert.match(first, /test-first-junit[.]xml$/)
    assert.match(second, /test-second-junit[.]xml$/)
    assert.notStrictEqual(first, second)
  })
})
