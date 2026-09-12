import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

import { ESLint } from 'eslint'

const EXPECTED_IGNORED_TRACKED_FILES = [
  'integration-tests/ci-visibility/test-management/test-suite-failed-to-run-parse.js',
  'integration-tests/code-origin/typescript.js',
  'integration-tests/debugger/target-app/source-map-support/bundle.js',
  'integration-tests/debugger/target-app/source-map-support/hello/world.js',
  'integration-tests/debugger/target-app/source-map-support/minify.min.js',
  'integration-tests/debugger/target-app/source-map-support/typescript.js',
  'packages/datadog-plugin-graphql/src/tools/index.js',
]

const trackedFiles = execFileSync('git', [
  'ls-files',
  '-z',
  '--',
  '*.cjs',
  '*.js',
  '*.jsx',
  '*.mjs',
]).toString().split('\0')
trackedFiles.pop()

const eslint = new ESLint()
const ignoredTrackedFiles = []

for (const file of trackedFiles) {
  if (await eslint.isPathIgnored(file)) ignoredTrackedFiles.push(file)
}

assert.deepStrictEqual(ignoredTrackedFiles, EXPECTED_IGNORED_TRACKED_FILES)
