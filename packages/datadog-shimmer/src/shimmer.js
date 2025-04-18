'use strict'

const log = require('../../dd-trace/src/log')

function copyProperties (original, wrapped) {
  if (original.constructor !== Function) {
    const proto = Object.getPrototypeOf(original)
    if (proto !== Function.prototype) {
      Object.setPrototypeOf(wrapped, proto)
    }
  }

  const descriptors = Object.getOwnPropertyDescriptors(original)

  try {
    // Fast path
    Object.defineProperties(wrapped, descriptors)
  } catch {
    // Fallback for non-configurable properties
    for (const [key, value] of Object.entries(descriptors)) {
      if (value.configurable) {
        Object.defineProperty(wrapped, key, value)
      }
    }
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

const wrapFn = function (original, delegate) {
  throw new Error('calling `wrap()` with 2 args is deprecated. Use wrapFunction instead.')
}

function isPromise (obj) {
  return typeof obj?.then === 'function'
}

let safeMode = !!process.env.DD_INEJCTION_ENABLED
function setSafe (value) {
  safeMode = value
}

function wrapMethod (target, name, wrapper, noAssert) {
  if (!noAssert) {
    assertMethod(target, name)
    assertFunction(wrapper)
  }

  const original = target[name]
  const wrapped = safeMode && original
    ? safeWrapper(original, wrapper)
    : wrapper(original)

  const descriptor = Object.getOwnPropertyDescriptor(target, name)

  if (typeof original === 'function') copyProperties(original, wrapped)

  if (descriptor) {
    if (descriptor.get || descriptor.set) {
      // TODO(BridgeAR): What happens in case there is only a setter? This seems wrong?
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
  const innerWrapped = wrapper(function (...args) {
    // This is only used in safe mode. It's a simple state machine to track if the
    // original method was called and if it returned. We need this to determine if
    // an error was thrown by the original method, or by us. We'll use one of these
    // per call to a wrapped method.
    // We need to stash the callState here because of recursion.
    const callState = currentCallState
    callState[0] = 1
    const retVal = original.apply(this, args)
    if (isPromise(retVal)) {
      // TODO: should this not be consistently be either a promise or not? I
      // would expect we only have to check once and can safe that state.
      retVal.then((value) => {
        callState[0] = 2
        callState[1] = value
      })
    } else {
      callState[0] = 2
      callState[1] = retVal
    }
    return retVal
  })

  // This is the crux of what we're doing in safe mode. It handles errors
  // that _we_ cause, by logging them, and transparently providing results
  // as if no wrapping was done at all. That means detecting (via callState)
  // whether the function has already run or not, and if it has, returning
  // the result, and otherwise calling the original function unwrapped.
  const handleError = function (args, callState, error) {
    if (callState[0] !== 1) {
      if (callState[0] === 0) {
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

  // The wrapped function is the one that will be called by the user.
  // It calls our version of the original function, which manages the
  // callState. That way when we use the errorHandler, it can tell where
  // the error originated.
  return function (...args) {
    currentCallState = [0, undefined]
    const errorHandler = handleError.bind(this, args, currentCallState)

    try {
      const retVal = innerWrapped.apply(this, args)
      return isPromise(retVal) ? retVal.catch(errorHandler) : retVal
    } catch (e) {
      return errorHandler(e)
    }
  }
}

function wrap (target, name, wrapper) {
  return typeof name === 'function'
    ? wrapFn(target, name)
    : wrapMethod(target, name, wrapper)
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
  if (!target) {
    throw new Error('No target object provided.')
  }

  if (typeof target !== 'object' && typeof target !== 'function') {
    throw new Error('Invalid target.')
  }

  if (typeof target[name] !== 'function') {
    if (!target[name]) {
      throw new Error(`No original method ${name}.`)
    }
    throw new Error(`Original method ${name} is not a function.`)
  }
}

function assertFunction (target) {
  if (typeof target !== 'function') {
    if (!target) {
      throw new Error('No function provided.')
    }
    throw new Error('Target is not a function.')
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
