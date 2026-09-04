import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { describe, it } from 'mocha'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const lintScript = path.join(repositoryRoot, 'scripts/lint.mjs')
const carrierFieldsRule = pathToFileURL(path.join(repositoryRoot, 'eslint-rules/eslint-carrier-fields.mjs')).href

/**
 * @param {string} source
 * @param {boolean} [ignored]
 * @returns {Promise<string>}
 */
async function createLintFixture (source, ignored = false) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'dd-trace-lint-'))
  const sourceDirectory = path.join(cwd, 'packages/example/src')
  await mkdir(sourceDirectory, { recursive: true })
  await writeFile(path.join(sourceDirectory, 'index.cjs'), source)
  await writeFile(path.join(cwd, 'eslint.config.mjs'), `
    import carrierFieldsRule from ${JSON.stringify(carrierFieldsRule)}

    export default [{
      ignores: ${JSON.stringify(ignored ? ['packages/example/src/index.cjs'] : [])},
    }, {
      files: ['packages/*/src/**/*.{js,mjs,cjs}'],
      languageOptions: {
        ecmaVersion: 2022,
        sourceType: 'commonjs',
      },
      plugins: {
        'eslint-rules': {
          rules: { 'eslint-carrier-fields': carrierFieldsRule },
        },
      },
      rules: {
        'eslint-rules/eslint-carrier-fields': 'error',
        'no-unused-vars': 'warn',
      },
    }]
  `)
  return cwd
}

/**
 * @param {string} cwd
 * @returns {import('node:child_process').SpawnSyncReturns<string>}
 */
function runLint (cwd) {
  return spawnSync(process.execPath, [lintScript], {
    cwd,
    encoding: 'utf8',
    env: process.env,
  })
}

describe('lint', () => {
  it('promotes carrier violations suppressed by a named directive', async () => {
    const cwd = await createLintFixture(`
      // eslint-disable-next-line eslint-rules/eslint-carrier-fields
      carrier['x-datadog-trace-id'] = value
    `)

    try {
      const result = runLint(cwd)

      assert.strictEqual(result.status, 1, result.stderr)
      assert.match(result.stdout, /Use the matching named operation from carrier\.js/)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('promotes carrier violations suppressed by a bare directive', async () => {
    const cwd = await createLintFixture(`
      // eslint-disable-next-line
      carrier['x-datadog-trace-id'] = value
    `)

    try {
      const result = runLint(cwd)

      assert.strictEqual(result.status, 1, result.stderr)
      assert.match(result.stdout, /Use the matching named operation from carrier\.js/)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('checks files that turn off the carrier rule with inline configuration', async () => {
    const cwd = await createLintFixture(`
      /* eslint eslint-rules/eslint-carrier-fields: off */
      carrier['x-datadog-trace-id'] = value
    `)

    try {
      const result = runLint(cwd)

      assert.strictEqual(result.status, 1, result.stderr)
      assert.match(result.stdout, /Use the matching named operation from carrier\.js/)
      await assert.rejects(access(path.join(cwd, '.eslintcache-carrier-fields')), { code: 'ENOENT' })
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('checks escaped carrier rule names in inline configuration', async () => {
    const cwd = await createLintFixture(String.raw`
      /* eslint "eslint-rules\/eslint-carrier-fields": off */
      carrier['x-datadog-trace-id'] = value
    `)

    try {
      const result = runLint(cwd)

      assert.strictEqual(result.status, 1, result.stderr)
      assert.match(result.stdout, /Use the matching named operation from carrier\.js/)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('checks globally ignored carrier files', async () => {
    const cwd = await createLintFixture(`
      carrier['x-datadog-trace-id'] = value
    `, true)

    try {
      const result = runLint(cwd)

      assert.strictEqual(result.status, 1, result.stderr)
      assert.match(result.stdout, /Use the matching named operation from carrier\.js/)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('restores carrier error severity without dropping other warnings', async () => {
    const cwd = await createLintFixture(`
      /* eslint eslint-rules/eslint-carrier-fields: warn */
      carrier['x-datadog-trace-id'] = value
      const unused = true
    `)

    try {
      const result = runLint(cwd)

      assert.strictEqual(result.status, 1, result.stderr)
      assert.match(result.stdout, /Use the matching named operation from carrier\.js/)
      assert.match(result.stdout, /'unused' is assigned a value but never used/)
      assert.match(result.stdout, /2 problems \(1 error, 1 warning\)/)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('does not reject harmless carrier rule text', async () => {
    const cwd = await createLintFixture(`
      module.exports = 'eslint-rules/eslint-carrier-fields'
    `)

    try {
      const result = runLint(cwd)

      assert.strictEqual(result.status, 0, result.stderr)
      assert.strictEqual(result.stdout, '')
      await assert.rejects(access(path.join(cwd, '.eslintcache-carrier-fields')), { code: 'ENOENT' })
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('retains violations in files with harmless carrier rule text', async () => {
    const cwd = await createLintFixture(`
      const unused = 'eslint-rules/eslint-carrier-fields'; carrier['x-datadog-trace-id'] = value
    `)

    try {
      const result = runLint(cwd)

      assert.strictEqual(result.status, 1, result.stderr)
      assert.match(result.stdout, /Use the matching named operation from carrier\.js/)
      assert.match(result.stdout, /'unused' is assigned a value but never used/)
      assert.match(result.stdout, /2 problems \(1 error, 1 warning\)/)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('keeps unrelated rule suppressions effective', async () => {
    const cwd = await createLintFixture(`
      // eslint-disable-next-line no-unused-vars
      const unused = true
      module.exports = true
    `)

    try {
      const result = runLint(cwd)

      assert.strictEqual(result.status, 0, result.stderr)
      assert.strictEqual(result.stdout, '')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('fails when warnings exceed the zero-warning limit', async () => {
    const cwd = await createLintFixture(`
      const unused = true
    `)

    try {
      const result = runLint(cwd)

      assert.strictEqual(result.status, 1, result.stderr)
      assert.match(result.stdout, /'unused' is assigned a value but never used/)
      assert.match(result.stdout, /1 problem \(0 errors, 1 warning\)/)
      assert.match(result.stderr, /ESLint found too many warnings \(maximum: 0\)/)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
