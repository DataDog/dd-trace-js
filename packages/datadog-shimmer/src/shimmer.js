'use strict'

const log = require('../../dd-trace/src/log')
const assert = require('assert')
const { types: { isAsyncFunction } } = require('node:util')

const NOT_STARTED = 0
const IN_PROGRESS = 1
const COMPLETED = 2

const skipMethods = new Set([
  // 'prototype', // We have to define the prototype on some methods. Figure out which ones.
  'caller',
  'arguments',
  'name',
  'length'
])

function copyProperties (original, wrapped) {
  if (original.constructor !== wrapped.constructor) {
    const proto = Object.getPrototypeOf(original)
    Object.setPrototypeOf(wrapped, proto)
  }

  const ownKeys = Reflect.ownKeys(original)
  if (original.length !== wrapped.length) {
    Object.defineProperty(wrapped, 'length', { value: original.length, configurable: true })
  }
  if (original.name !== wrapped.name) {
    Object.defineProperty(wrapped, 'name', { value: original.name, configurable: true })
  }
  if (ownKeys.length === 2) {
    return
  }
  for (const key of ownKeys) {
    if (skipMethods.has(key)) continue
    const descriptor = Object.getOwnPropertyDescriptor(original, key)
    try {
      Object.defineProperty(wrapped, key, descriptor)
    } catch {}
  }
}

function wrapFunction (original, wrapper) {
  if (typeof original === 'function') assertNotClass(original)

  const wrapped = safeMode
    ? safeWrapper(original, wrapper)
    : wrapper(original)

  if (typeof original === 'function') copyProperties(original, wrapped)

  return wrapped
}

function isPromise (obj) {
  return typeof obj?.then === 'function'
}

let safeMode = !!process.env.DD_INEJCTION_ENABLED
function setSafe (value) {
  safeMode = value
}

function wrap (target, name, wrapper, noAssert) {
  assert(typeof name !== 'function', 'Implementor error: wrap() name should not be a function')
  if (!noAssert) {
    assertMethod(target, name)
    if (typeof wrapper !== 'function') {
      throw new Error(wrapper ? 'Target is not a function.' : 'No function provided.')
    }
  }

  const original = target[name]
  const wrapped = safeMode && original
    ? safeWrapper(original, wrapper)
    : wrapper(original)

  if (typeof original === 'function') copyProperties(original, wrapped)

  const descriptor = Object.getOwnPropertyDescriptor(target, name)

  if (descriptor) {
    if (descriptor.get || descriptor.set) {
      // TODO(BridgeAR): What happens in case there is a setter? This seems wrong?
      // What happens in case the user does indeed set this to a different value?
      // In that case the getter would potentially return the wrong value?
      descriptor.get = () => wrapped
    } else {
      descriptor.value = wrapped
    }

    // TODO: create a single object for multiple wrapped methods
    if (descriptor.configurable === false) {
      return Object.create(target, {
        [name]: descriptor
      })
    }
  } else { // no descriptor means original was on the prototype
    target[name] = wrapped
    return target
  }

  Object.defineProperty(target, name, descriptor)

  return target
}

function safeWrapper (original, wrapper) {
  // In this mode, we make a best-effort attempt to handle errors that are thrown
  // by us, rather than wrapped code. With such errors, we log them, and then attempt
  // to return the result as if no wrapping was done at all.
  //
  // Caveats:
  //   * If the original function is called in a later iteration of the event loop,
  //     and we throw _then_, then it won't be caught by this. In practice, we always call
  //     the original function synchronously, so this is not a problem.
  //   * While async errors are dealt with here, errors in callbacks are not. This
  //     is because we don't necessarily know _for sure_ that any function arguments
  //     are wrapped by us. We could wrap them all anyway and just make that assumption,
  //     or just assume that the last argument is always a callback set by us if it's a
  //     function, but those don't seem like things we can rely on. We could add a
  //     `shimmer.markCallbackAsWrapped()` function that's a no-op outside safe-mode,
  //     but that means modifying every instrumentation. Even then, the complexity of
  //     this code increases because then we'd need to effectively do the reverse of
  //     what we're doing for synchronous functions. This is a TODO.

  // We're going to hold on to current callState in this variable in this scope,
  // which is fine because any time we reference it, we're referencing it synchronously.
  // We'll use it in the our wrapper (which, again, is called synchronously), and in the
  // errorHandler, which will already have been bound to this callState.
  let currentCallState

  // Rather than calling the original function directly from the shim wrapper, we wrap
  // it again so that we can track if it was called and if it returned. This is because
  // we need to know if an error was thrown by the original function, or by us.
  // We could do this inside the `wrapper` function defined below, which would simplify
  // managing the callState, but then we'd be calling `wrapper` on each invocation, so
  // instead we do it here, once.
  let innerWrapped
  // Fast path for async methods. Those are always returning promises, so need
  // to check for that. That also prevents the need to change the prototype later.
  if (isAsyncFunction(original)) {
    innerWrapped = wrapper(function (...args) {
      // This is only used in safe mode. It's a simple state machine to track if the
      // original method was called and if it returned. We need this to determine if
      // an error was thrown by the original method, or by us. We'll use one of these
      // per call to a wrapped method.
      // We need to stash the callState here because of recursion.
      const callState = currentCallState
      callState[0] = IN_PROGRESS
      return original.apply(this, args).then((value) => {
        callState[0] = COMPLETED
        callState[1] = value
        return value
      })
    })
  } else {
    innerWrapped = wrapper(function (...args) {
      // This is only used in safe mode. It's a simple state machine to track if the
      // original method was called and if it returned. We need this to determine if
      // an error was thrown by the original method, or by us. We'll use one of these
      // per call to a wrapped method.
      // We need to stash the callState here because of recursion.
      const callState = currentCallState
      callState[0] = IN_PROGRESS
      const retVal = original.apply(this, args)
      if (isPromise(retVal)) {
        return retVal.then((value) => {
          callState[0] = COMPLETED
          callState[1] = value
          return value
        })
      }
      callState[0] = COMPLETED
      callState[1] = retVal
      return retVal
    })
  }

  // The wrapped function is the one that will be called by the user.
  // It calls our version of the original function, which manages the
  // callState. That way when we use the errorHandler, it can tell where
  // the error originated.
  if (isAsyncFunction(original)) {
    // Fast path for async methods. Those are always returning promises, so need
    // to check for that. That also prevents the need to change the prototype later.
    // TODO(BridgeAR): Check if the overhead with async hooks and the async methods
    // is higher than the overhead of the prototype change. That way it's possible
    // to check for the async methods in copyProperties and skip the prototype change.
    return function (...args) {
      currentCallState = [NOT_STARTED, undefined]
      const callState = currentCallState

      return innerWrapped.apply(this, args).catch((error) => {
        if (callState[0] !== IN_PROGRESS) {
          if (callState[0] === NOT_STARTED) {
            // error was thrown before original function was called, so
            // it was us. log it.
            log.error('Shimmer error was thrown before original function was called', error)
            // original never ran. call it unwrapped.
            return original.apply(this, args)
          }
          // error was thrown after original function returned/resolved, so
          // it was us. log it.
          log.error('Shimmer error was thrown after original function returned/resolved', error)
          // original ran and returned something. return it.
          return callState[1]
        }

        // error was thrown during original function execution, so
        // it was them. throw.
        throw error
      })
    }
  }

  // This is the crux of what we're doing in safe mode. It handles errors
  // that _we_ cause, by logging them, and transparently providing results
  // as if no wrapping was done at all. That means detecting (via callState)
  // whether the function has already run or not, and if it has, returning
  // the result, and otherwise calling the original function unwrapped.
  const handleError = function (args, callState, error) {
    if (callState[0] !== IN_PROGRESS) {
      if (callState[0] === NOT_STARTED) {
        // error was thrown before original function was called, so
        // it was us. log it.
        log.error('Shimmer error was thrown before original function was called', error)
        // original never ran. call it unwrapped.
        return original.apply(this, args)
      }
      // error was thrown after original function returned/resolved, so
      // it was us. log it.
      log.error('Shimmer error was thrown after original function returned/resolved', error)
      // original ran and returned something. return it.
      return callState[1]
    }

    // error was thrown during original function execution, so
    // it was them. throw.
    throw error
  }
  return function (...args) {
    currentCallState = [NOT_STARTED, undefined]
    const errorHandler = handleError.bind(this, args, currentCallState)

    try {
      const retVal = innerWrapped.apply(this, args)
      return isPromise(retVal) ? retVal.catch(errorHandler) : retVal
    } catch (e) {
      return errorHandler(e)
    }
  }
}

function massWrap (targets, names, wrapper) {
  targets = toArray(targets)
  names = toArray(names)

  for (const target of targets) {
    for (const name of names) {
      wrap(target, name, wrapper)
    }
  }
}

function toArray (maybeArray) {
  return Array.isArray(maybeArray) ? maybeArray : [maybeArray]
}

function assertMethod (target, name) {
  if (typeof target?.[name] !== 'function') {
    let message = 'No target object provided.'

    if (target) {
      if (typeof target !== 'object' && typeof target !== 'function') {
        message = 'Invalid target.'
      } else {
        message = target[name] ? `Original method ${name} is not a function.` : `No original method ${name}.`
      }
    }

    throw new Error(message)
  }
}

function assertNotClass (target) {
  if (Function.prototype.toString.call(target).startsWith('class')) {
    throw new Error('Target is a native class constructor and cannot be wrapped.')
  }
}

module.exports = {
  wrap,
  wrapFunction,
  massWrap,
  setSafe
}
