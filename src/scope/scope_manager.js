'use strict'

const asyncHooks = require('./async_hooks')
const Scope = require('./scope')
const Context = require('./context')
const ContextExecution = require('./context_execution')

let singleton = null

/**
 * The Datadog Scope Manager. This is used for context propagation.
 *
 * @hideconstructor
 */
class ScopeManager {
  constructor () {
    if (singleton) {
      return singleton
    }

    singleton = this

    const execution = new ContextExecution()

    this._active = execution
    this._stack = []
    this._contexts = new Map()
    this._executions = new Map()

    this._hook = asyncHooks.createHook({
      init: this._init.bind(this),
      before: this._before.bind(this),
      after: this._after.bind(this),
      destroy: this._destroy.bind(this),
      promiseResolve: this._destroy.bind(this)
    })

    this._enable()

    return this
  }

  /**
   * Get the current active scope or null if there is none.
   *
   * @returns {Scope} The active scope.
   */
  active () {
    let execution = this._active

    while (execution !== null) {
      if (execution.scope()) {
        return execution.scope()
      }

      execution = execution.parent()
    }

    return null
  }

  /**
   * Activate a new scope wrapping the provided span.
   *
   * @param {external:"opentracing.Span"} span The span for which to activate the new scope.
   * @param {?Boolean} [finishSpanOnClose=false] Whether to automatically finish the span when the scope is closed.
   * @returns {Scope} The newly created and now active scope.
   */
  activate (span, finishSpanOnClose) {
    const execution = this._active
    const scope = new Scope(span, execution, finishSpanOnClose)

    execution.add(scope)

    return scope
  }

  _init (asyncId) {
    const context = new Context()

    context.link(this._active)
    context.retain()

    this._contexts.set(asyncId, context)
  }

  _before (asyncId) {
    const context = this._contexts.get(asyncId)

    if (context) {
      const execution = new ContextExecution(context)

      execution.retain()

      this._stack.push(this._active)
      this._executions.set(asyncId, execution)
      this._active = execution
    }
  }

  _after (asyncId) {
    const execution = this._executions.get(asyncId)

    if (execution) {
      execution.exit()
      execution.release()

      this._active = this._stack.pop()
      this._executions.delete(asyncId)
    }
  }

  _destroy (asyncId) {
    const context = this._contexts.get(asyncId)

    if (context) {
      this._contexts.delete(asyncId)
      context.release()
    }
  }

  _enable () {
    this._hook.enable()
  }

  _disable () {
    this._hook.disable()
  }
}

module.exports = ScopeManager
