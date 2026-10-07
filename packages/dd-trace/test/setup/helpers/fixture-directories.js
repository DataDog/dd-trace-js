'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const FIXTURE_ROOT_ENV = 'DD_TEST_FIXTURE_ROOT'

class FixtureDirectories {
  #roots = new Set()

  createRunRoot () {
    const prefix = path.join(os.tmpdir(), 'dd-trace-fixtures-')
    try {
      const root = fs.mkdtempSync(prefix)
      this.#roots.add(root)
      return root
    } catch (error) {
      throw directoryError(error, prefix)
    }
  }

  /**
   * The parent owns every child through the filesystem, including worker allocations and failed copies.
   * Only explicitly named sources are copied; generated dependency and build trees are not fixture sources.
   *
   * @param {string|undefined} root
   * @param {string} label
   * @param {string} source
   * @param {string[]} names
   */
  createFixture (root, label, source, names) {
    if (!root || !/^[\w.-]+$/.test(label)) throw new Error('Invalid fixture allocation')
    const directory = fs.mkdtempSync(path.join(root, `${label}-`))
    for (const name of names) {
      if (!name || name === '.' || name === '..' || path.basename(name) !== name) {
        throw new Error('Fixture sources must be direct children')
      }
      fs.cpSync(path.join(source, name), path.join(directory, name), { recursive: true })
    }
    return directory
  }

  async cleanup () {
    const failures = []
    await Promise.all([...this.#roots].map(async root => {
      try {
        // A replaced root must be unlinked, not traversed into an unowned symlink target.
        if (!(await fs.promises.lstat(root)).isDirectory()) {
          await fs.promises.rm(root, { force: true })
          this.#roots.delete(root)
          return
        }
        const entries = await fs.promises.readdir(root)
        const results = await Promise.allSettled(entries.map(async entry => {
          const target = path.join(root, entry)
          try {
            await fs.promises.rm(target, { recursive: true, force: true })
          } catch (error) {
            throw directoryError(error, target)
          }
        }))
        for (const result of results) {
          if (result.status === 'rejected') failures.push(result.reason)
        }
        // Do not recursively retry failed children when removing their parent.
        await fs.promises.rmdir(root)
        this.#roots.delete(root)
      } catch (error) {
        if (error.code === 'ENOENT') {
          this.#roots.delete(root)
        } else {
          failures.push(directoryError(error, root))
        }
      }
    }))
    if (failures.length) throw new AggregateError(failures, 'Fixture directory cleanup failed')
  }
}

/**
 * @param {Error & {code?: string}} error
 * @param {string} target
 */
function directoryError (error, target) {
  const code = /^[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : 'UNKNOWN'
  return Object.assign(new Error(`code=${code} path=${JSON.stringify(target)}`), { code, path: target })
}

module.exports = { FixtureDirectories, FIXTURE_ROOT_ENV }
