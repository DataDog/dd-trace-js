'use strict'

const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const { reporters } = require('mocha')

const { collectFailure, specFile } = require('./known-failures')

module.exports = class BunPluginReporter extends reporters.Spec {
  /**
   * @param {import('mocha').Runner} runner
   * @param {import('mocha').MochaOptions} options
   */
  constructor (runner, options) {
    super(runner, options)
    const failures = {}
    const files = new Set()
    let hookFailed = false
    let known = 0
    runner.on('test end', test => files.add(specFile(test)))
    runner.on('pending', test => {
      if (test.title.includes('[known Bun failure:')) known++
    })
    runner.on('fail', (test, error) => {
      if (test.type !== 'test') {
        hookFailed = true
        return
      }
      collectFailure(failures, test, error)
    })
    runner.once('end', () => {
      const { passes, pending, failures: failed } = runner.stats
      process.stdout.write(`Bun: ${files.size} spec files, ${passes} passed, ${known} known failures, ` +
        `${pending - known} other pending, ${failed} failed\n`)
      if (!process.env.DD_BUN_GENERATE_FAILURES) return
      if (hookFailed || files.size === 0) {
        process.stderr.write('Refusing to generate known failures: a hook failed or no tests ran.\n')
        return
      }
      const filename = join(__dirname, 'known-failures.json')
      const baseline = JSON.parse(readFileSync(filename, 'utf8'))
      for (const file of files) delete baseline[file]
      Object.assign(baseline, failures)
      const sorted = Object.fromEntries(Object.keys(baseline).sort().map(file => [
        file, Object.fromEntries(Object.entries(baseline[file]).sort(([a], [b]) => a.localeCompare(b))),
      ]))
      writeFileSync(filename, `${JSON.stringify(sorted, null, 2)}\n`)
      process.stdout.write('Generated integration-tests/bun/known-failures.json; review before committing.\n')
    })
  }
}
