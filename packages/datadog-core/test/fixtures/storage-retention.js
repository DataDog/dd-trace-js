'use strict'

const assert = require('node:assert/strict')
const { AsyncLocalStorage } = require('node:async_hooks')
const { readFileSync } = require('node:fs')
const { setImmediate } = require('node:timers/promises')
const { runInNewContext } = require('node:vm')

const source = readFileSync(require.resolve('../../src/storage'), 'utf8')

function load () {
  return runInNewContext(`
    const module = { exports: {} };
    ${source}
    if (createNamespace) module.exports.storage('unused');
    new WeakRef(globalThis);
  `, { require, WeakRef, createNamespace: process.argv[2] === 'namespace' })
}

async function main () {
  const references = [load(), load(), load()]
  const propagate = AsyncLocalStorage.prototype._propagate
  await setImmediate()
  global.gc()
  for (const reference of references) {
    assert.strictEqual(reference.deref(), undefined, 'storage must release the importing VM context')
  }
  load()
  assert.strictEqual(AsyncLocalStorage.prototype._propagate, propagate, 'the hook must be installed only once')
}

main().catch(error => {
  process.stderr.write(error.stack + '\n')
  process.exitCode = 1
})
