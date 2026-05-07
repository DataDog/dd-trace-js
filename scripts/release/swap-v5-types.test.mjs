import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const here = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = join(here, '..', '..')
const scriptPath = join(repoRoot, 'scripts', 'release', 'swap-v5-types.js')

/**
 * @param {{ index: string, v5: string }} files
 */
function setup ({ index, v5 }) {
  const root = mkdtempSync(join(tmpdir(), 'swap-v5-types-'))
  mkdirSync(join(root, 'scripts', 'release'), { recursive: true })
  writeFileSync(join(root, 'index.d.ts'), index)
  if (v5 !== null) writeFileSync(join(root, 'index.d.v5.ts'), v5)
  writeFileSync(join(root, 'scripts', 'release', 'swap-v5-types.js'), readFileSync(scriptPath))
  return root
}

test('makes index.d.ts byte-equal to index.d.v5.ts', () => {
  const root = setup({ index: 'V6 SURFACE\n', v5: 'V5 SURFACE\n' })
  try {
    execFileSync(process.execPath, [join(root, 'scripts', 'release', 'swap-v5-types.js')], { cwd: root })
    assert.strictEqual(
      readFileSync(join(root, 'index.d.ts'), 'utf8'),
      readFileSync(join(root, 'index.d.v5.ts'), 'utf8')
    )
    assert.strictEqual(readFileSync(join(root, 'index.d.ts'), 'utf8'), 'V5 SURFACE\n')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('is idempotent', () => {
  const root = setup({ index: 'V6\n', v5: 'V5\n' })
  try {
    execFileSync(process.execPath, [join(root, 'scripts', 'release', 'swap-v5-types.js')], { cwd: root })
    execFileSync(process.execPath, [join(root, 'scripts', 'release', 'swap-v5-types.js')], { cwd: root })
    assert.strictEqual(readFileSync(join(root, 'index.d.ts'), 'utf8'), 'V5\n')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('exits non-zero when index.d.v5.ts is missing', () => {
  const root = setup({ index: 'V6\n', v5: null })
  try {
    assert.throws(() => {
      execFileSync(process.execPath, [join(root, 'scripts', 'release', 'swap-v5-types.js')], {
        cwd: root,
        stdio: 'pipe',
      })
    }, /Command failed/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
