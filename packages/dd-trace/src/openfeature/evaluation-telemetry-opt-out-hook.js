'use strict'

const PARAMETER = 'dd_evaluation_telemetry_opt_out'

/** Gates an owned finally-only telemetry hook without changing evaluation or exposure handling. */
class EvaluationTelemetryOptOutHook {
  #delegate
  #decisions = new WeakMap()

  /** @param {import('@openfeature/server-sdk').Hook} delegate */
  constructor (delegate) {
    this.#delegate = delegate
  }

  /** @param {import('@openfeature/core').HookContext} hookContext */
  before (hookContext) {
    // Hook context identity is stable across stages, including each MultiProvider branch.
    this.#decisions.set(hookContext, isOptedOut(hookContext.context))
  }

  /** @param {import('@openfeature/core').HookContext} hookContext */
  error (hookContext) {
    // A customer before hook can fail before this hook runs. Capture before customer error hooks mutate consent.
    if (!this.#decisions.has(hookContext)) {
      this.#decisions.set(hookContext, isOptedOut(hookContext.context))
    }
  }

  /**
   * @param {import('@openfeature/core').HookContext} hookContext
   * @param {import('@openfeature/core').EvaluationDetails<import('@openfeature/core').FlagValue>} evaluationDetails
   * @param {import('@openfeature/core').HookHints} [hints]
   */
  finally (hookContext, evaluationDetails, hints) {
    const optedOut = this.#decisions.get(hookContext) === true || isOptedOut(hookContext.context)
    this.#decisions.delete(hookContext)
    if (!optedOut) return this.#delegate.finally?.(hookContext, evaluationDetails, hints)
  }
}

/** @param {import('@openfeature/core').EvaluationContext} context */
function isOptedOut (context) {
  try {
    return context?.[PARAMETER] === true
  } catch {
    // An unreadable attribute is not boolean true and must not change the evaluation result.
    return false
  }
}

module.exports = EvaluationTelemetryOptOutHook
