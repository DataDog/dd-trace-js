'use strict'

const assert = require('node:assert/strict')

const { channel } = require('dc-polyfill')
const { describe, it } = require('mocha')

const detector = require('./span-leak-detector')

const finishCh = channel('dd-trace:span:finish')

if (typeof global.gc !== 'function') {
  throw new Error('span-leak-detector.spec.js requires --expose-gc')
}

async function forceGc () {
  for (let cycle = 0; cycle < 10; cycle++) {
    await new Promise(resolve => setImmediate(resolve))
    global.gc()
  }
}

/**
 * @param {number} count
 * @returns {Array<{ _integrationName: string, _name: string }>}
 */
function publishRetained (count) {
  const spans = []

  for (let index = 0; index < count; index++) {
    const span = {
      _integrationName: 'test',
      _name: 'retained.span',
    }
    spans.push(span)
    finishCh.publish(span)
  }

  return spans
}

describe('span-leak-detector', () => {
  it('is a no-op when never armed', async () => {
    await detector.assertNoRetainedSpans()
  })

  it('reports one retained finished span', async () => {
    detector.arm()
    const retainedSpans = publishRetained(1)

    await assert.rejects(
      () => detector.assertNoRetainedSpans(),
      /1 of 1 finished integration spans were still reachable.*test\/retained\.span \[1\]/
    )
    assert.strictEqual(retainedSpans.length, 1)
  })

  it('accepts a finished span after its last strong reference is released', async () => {
    detector.arm()
    ;(() => finishCh.publish({ _integrationName: 'test', _name: 'collectible.span' }))()

    await forceGc()
    await detector.assertNoRetainedSpans()
  })

  it('allows 64 retained spans for one dependency version', async () => {
    detector.arm()
    const scope = detector.enterScope('library@1.0.0')
    const retainedSpans = publishRetained(64)
    ;(() => publishRetained(64))()
    detector.leaveScope(scope)

    await forceGc()
    await detector.assertNoRetainedSpans()
    assert.strictEqual(retainedSpans.length, 64)
  })

  it('reports a 65th retained span for one dependency version', async () => {
    detector.arm()
    const scope = detector.enterScope('library@1.0.0')
    const retainedSpans = publishRetained(65)
    ;(() => publishRetained(65))()
    detector.leaveScope(scope)

    await forceGc()
    await assert.rejects(
      () => detector.assertNoRetainedSpans(),
      /65 of 130.*library@1\.0\.0 \(limit 64 or retained majority after 3 spans\).*\(65 of 130\)/
    )
    assert.strictEqual(retainedSpans.length, 65)
  })

  it('reports a retained majority for one span name', async () => {
    detector.arm()
    const scope = detector.enterScope('library@1.0.0')
    const retainedSpans = publishRetained(2)
    ;(() => publishRetained(1))()
    detector.leaveScope(scope)

    await forceGc()
    await assert.rejects(
      () => detector.assertNoRetainedSpans(),
      /2 of 3.*test\/retained\.span.*\(2 of 3\)/
    )
    assert.strictEqual(retainedSpans.length, 2)
  })

  it('allows a retained majority before three spans finish', async () => {
    detector.arm()
    const scope = detector.enterScope('library@1.0.0')
    const retainedSpans = publishRetained(2)
    detector.leaveScope(scope)

    await detector.assertNoRetainedSpans()
    assert.strictEqual(retainedSpans.length, 2)
  })

  it('rejects scopes left out of order', async () => {
    detector.arm()
    const outerScope = detector.enterScope('outer')
    const innerScope = detector.enterScope('inner')

    assert.throws(
      () => detector.leaveScope(outerScope),
      /Cannot leave span-leak scope outer: another scope is active/
    )
    detector.leaveScope(innerScope)
    detector.leaveScope(outerScope)
    await detector.assertNoRetainedSpans()
  })

  it('ignores manually created parent spans', async () => {
    detector.arm()
    const parentSpan = { _integrationName: 'opentracing', _name: 'parent' }
    finishCh.publish(parentSpan)

    await detector.assertNoRetainedSpans()
    assert.strictEqual(parentSpan._name, 'parent')
  })

  it('is a no-op when armed but nothing finishes', async () => {
    detector.arm()

    await detector.assertNoRetainedSpans()
  })

  it('does not double-count spans after repeated arm calls', async () => {
    detector.arm()
    detector.arm()
    const retainedSpans = publishRetained(1)

    await assert.rejects(
      () => detector.assertNoRetainedSpans(),
      /1 of 1 finished integration spans were still reachable/
    )
    assert.strictEqual(retainedSpans.length, 1)
  })
})
