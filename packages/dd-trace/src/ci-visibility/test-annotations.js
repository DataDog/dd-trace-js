'use strict'

// Symbols cross Jest's VM/module-registry boundary without initializing the tracer.
const annotationsKey = Symbol.for('dd-trace:test-annotations')
/** @type {{ mustFail: boolean, noAutoRetry: boolean, source?: Function }} */
const emptyAnnotations = Object.freeze({ mustFail: false, noAutoRetry: false })

/** @param {Function|undefined} fn */
function getTestAnnotations (fn) {
  return (fn && fn[annotationsKey]) || emptyAnnotations
}

/**
 * @param {Function|undefined} source
 * @param {Function} target
 */
function copyTestAnnotations (source, target) {
  const annotations = source && source[annotationsKey]
  if (annotations && target[annotationsKey] !== annotations) {
    Object.defineProperty(target, annotationsKey, { value: annotations, configurable: true })
  }
}

/**
 * @template {Function} T
 * @param {T} fn
 * @param {'mustFail'|'noAutoRetry'} annotation
 * @returns {T}
 */
function annotate (fn, annotation) {
  if (typeof fn !== 'function') throw new TypeError('Test annotations require a test callback')
  const inherited = getTestAnnotations(fn)
  const annotated = function (...args) {
    return fn.apply(this, args)
  }
  Object.setPrototypeOf(annotated, Object.getPrototypeOf(fn))
  Object.defineProperties(annotated, {
    ...Object.getOwnPropertyDescriptors(fn),
    length: { value: fn.length },
    name: { value: fn.name },
    toString: { value: () => fn.toString() },
    [annotationsKey]: {
      value: Object.freeze({
        ...inherited,
        [annotation]: true,
        source: inherited.source || fn,
      }),
    },
  })
  if (Object.isFrozen(fn)) Object.freeze(annotated)
  return /** @type {T} */ (/** @type {unknown} */ (annotated))
}

/**
 * @template {Function} T
 * @param {T} fn
 * @returns {T}
 */
function preventFailureSuppression (fn) {
  return annotate(fn, 'mustFail')
}

/**
 * @template {Function} T
 * @param {T} fn
 * @returns {T}
 */
function noAutoRetry (fn) {
  return annotate(fn, 'noAutoRetry')
}

module.exports = { preventFailureSuppression, noAutoRetry, getTestAnnotations, copyTestAnnotations }
