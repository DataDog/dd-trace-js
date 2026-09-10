'use strict'

const assert = require('node:assert/strict')

const { channel } = require('dc-polyfill')

const finishCh = channel('dd-trace:span:finish')

/** @typedef {{ id: number, label: string, parent?: SpanLeakScope }} SpanLeakScope */
/**
 * @typedef {{
 *   group: string,
 *   integrationName?: string,
 *   name?: string,
 *   scope: SpanLeakScope,
 *   sequence: number
 * }} SpanLeakDetails
 */

// Finalization callbacks run after collection. Repeat GC and event-loop drains
// so one delayed callback does not make the test result nondeterministic.
const MAX_GC_CYCLES = 10
// Bound existing test-runtime retention without per-integration allowlists.
const MAX_RETAINED_PER_VERSION = 64
const MIN_TRACKED_FOR_MAJORITY = 3

const gc = typeof global.gc === 'function' ? global.gc : undefined
/** @type {SpanLeakScope} */
const ROOT_SCOPE = { id: 0, label: 'root' }

class SpanLeakDetector {
  /** @type {FinalizationRegistry<number> | undefined} */
  #registry
  #trackedCount = 0
  #nextId = 0
  #nextScopeId = 0
  /** @type {Map<number, SpanLeakDetails>} */
  #retained = new Map()
  /** @type {Map<SpanLeakScope, Map<string, number>>} */
  #trackedByScope = new Map()
  #armed = false
  #scope = ROOT_SCOPE

  /** @param {import('../../src/opentracing/span')} span */
  #onFinish = span => {
    // Propagation tests can retain their manual parents. Instrumentation spans are the leak signal.
    if (span._integrationName === 'opentracing') return

    const id = ++this.#nextId
    const sequence = ++this.#trackedCount
    const integrationName = span._integrationName
    const name = span._name
    const group = `${integrationName ?? 'unknown'}/${name ?? 'unknown'}`
    let trackedGroups = this.#trackedByScope.get(this.#scope)
    if (trackedGroups === undefined) {
      trackedGroups = new Map()
      this.#trackedByScope.set(this.#scope, trackedGroups)
    }
    trackedGroups.set(group, (trackedGroups.get(group) ?? 0) + 1)
    this.#retained.set(id, {
      group,
      integrationName,
      name,
      scope: this.#scope,
      sequence,
    })
    this.#registry.register(span, id)
  }

  /**
   * @param {string} label
   * @returns {SpanLeakScope}
   */
  enterScope (label) {
    const scope = {
      id: ++this.#nextScopeId,
      label,
      parent: this.#scope,
    }
    this.#scope = scope
    return scope
  }

  /**
   * @param {SpanLeakScope} scope
   * @returns {void}
   */
  leaveScope (scope) {
    if (scope !== this.#scope) {
      throw new Error(`Cannot leave span-leak scope ${scope.label}: another scope is active`)
    }
    this.#scope = scope.parent ?? ROOT_SCOPE
  }

  /** @returns {void} */
  arm () {
    if (gc === undefined || this.#armed) return

    this.#registry ??= new FinalizationRegistry(id => {
      this.#retained.delete(id)
    })
    finishCh.subscribe(this.#onFinish)
    this.#armed = true
  }

  /**
   * Assert after Mocha releases its suite graph. Test callbacks and Sinon call
   * history can hold finished spans until the runner itself becomes collectible.
   *
   * @returns {Promise<void>}
   */
  async assertNoRetainedSpans () {
    if (!this.#armed) return

    finishCh.unsubscribe(this.#onFinish)
    this.#armed = false

    if (this.#trackedCount === 0) {
      this.#reset()
      return
    }

    for (let cycle = 0; cycle < MAX_GC_CYCLES && this.#hasExcessRetention(); cycle++) {
      await new Promise(resolve => setImmediate(resolve))
      gc()
    }
    await new Promise(resolve => setImmediate(resolve))

    const retainedScopes = this.#getRetainedScopes()
    const leakingScopes = retainedScopes.filter(([scope, spans]) => this.#isLeakingScope(scope, spans))
    const retained = this.#retained.size
    const tracked = this.#trackedCount
    const details = this.#formatRetainedScopes(leakingScopes)
    this.#reset()

    assert.strictEqual(
      leakingScopes.length,
      0,
      `${retained} of ${tracked} finished integration spans were still reachable after Mocha released its suite ` +
      `graph and ${MAX_GC_CYCLES} GC cycles. Scopes above their limits: ${details}`
    )
  }

  /** @returns {boolean} */
  #hasExcessRetention () {
    return this.#getRetainedScopes().some(([scope, spans]) => this.#isLeakingScope(scope, spans))
  }

  /**
   * @param {SpanLeakScope} scope
   * @param {SpanLeakDetails[]} spans
   * @returns {boolean}
   */
  #isLeakingScope (scope, spans) {
    if (scope === ROOT_SCOPE || spans.length > MAX_RETAINED_PER_VERSION) return true

    const trackedGroups = this.#trackedByScope.get(scope)
    /** @type {Map<string, number>} */
    const retainedGroups = new Map()
    for (const { group } of spans) {
      retainedGroups.set(group, (retainedGroups.get(group) ?? 0) + 1)
    }
    return [...retainedGroups].some(([group, retained]) => {
      const tracked = trackedGroups.get(group)
      return tracked >= MIN_TRACKED_FOR_MAJORITY && retained * 2 > tracked
    })
  }

  /** @returns {Array<[SpanLeakScope, SpanLeakDetails[]]>} */
  #getRetainedScopes () {
    /** @type {Map<SpanLeakScope, SpanLeakDetails[]>} */
    const scopes = new Map()

    for (const span of this.#retained.values()) {
      const spans = scopes.get(span.scope)

      if (spans === undefined) {
        scopes.set(span.scope, [span])
      } else {
        spans.push(span)
      }
    }

    return [...scopes]
  }

  /**
   * @param {Array<[SpanLeakScope, SpanLeakDetails[]]>} scopes
   * @returns {string}
   */
  #formatRetainedScopes (scopes) {
    return scopes.map(([scope, spans]) => {
      /** @type {Map<string, number[]>} */
      const groups = new Map()

      for (const { group, sequence } of spans) {
        const sequences = groups.get(group)

        if (sequences === undefined) {
          groups.set(group, [sequence])
        } else {
          sequences.push(sequence)
        }
      }

      const trackedGroups = this.#trackedByScope.get(scope)
      const details = [...groups].map(([group, sequences]) => {
        return `${group} [${sequences.join(', ')}] (${sequences.length} of ${trackedGroups.get(group)})`
      }).join('; ')
      const limit = scope === ROOT_SCOPE ? 0 : MAX_RETAINED_PER_VERSION
      return `${scope.label} (limit ${limit} or retained majority after ${MIN_TRACKED_FOR_MAJORITY} spans): ${details}`
    }).join(' | ')
  }

  #reset () {
    this.#trackedCount = 0
    this.#retained.clear()
    this.#trackedByScope.clear()
  }
}

module.exports = new SpanLeakDetector()
