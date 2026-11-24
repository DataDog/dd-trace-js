import assert from 'node:assert/strict'

import { test } from 'vitest'

assert.ok(globalThis._ddtrace)
for (const method of ['each', 'for', 'extend', 'skipIf', 'runIf']) {
  assert.strictEqual(test[method], test.fn[method], method)
}

test('keeps native declarations under ordinary tracing', () => {
  assert.strictEqual(test.fn.call, Function.prototype.call)
  assert.strictEqual(test.fn.apply, Function.prototype.apply)
})
