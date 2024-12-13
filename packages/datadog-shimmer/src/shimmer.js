'use strict'

const log = require('../../dd-trace/src/log')

// Use a weak map to avoid polluting the wrapped function/method.
const unwrappers = new WeakMap()

function copyProperties (original, wrapped) {
  // TODO getPrototypeOf is not fast. Should we instead do this in specific
  // instrumentations where needed?
  const proto = Object.getPrototypeOf(original)
  if (proto !== Function.prototype) {
    Object.setPrototypeOf(wrapped, proto)
  }
  const props = Object.getOwnPropertyDescriptors(original)
  const keys = Reflect.ownKeys(props)

  for (const key of keys) {
    try {
      Object.defineProperty(wrapped, key, props[key])
    } catch (e) {
      // TODO: figure out how to handle this without a try/catch
    }
  }
}

function wrapFunction (original, wrapper) {
  if (typeof original === 'function') assertNotClass(original)
  // TODO This needs to be re-done so that this and wrapMethod are distinct.
  const target = { func: original }
  wrapMethod(target, 'func', wrapper, typeof original !== 'function')
  let delegate = target.func

  const shim = function shim () {
    return delegate.apply(this, arguments)
  }

  unwrappers.set(shim, () => {
    delegate = original
  })

  if (typeof original === 'function') copyProperties(original, shim)

  return shim
}

const wrapFn = function (original, delegate) {
  throw new Error('calling `wrap()` with 2 args is deprecated. Use wrapFunction instead.')
}

// This is only used in safe mode. It's a simple state machine to track if the
// original method was called and if it returned. We need this to determine if
// an error was thrown by the original method, or by us. We'll use one of these
// per call to a wrapped method.
class CallState {
  constructor () {
    this.called = false
    this.completed = false
    this.retVal = undefined
  }

  startCall () {
    this.called = true
  }

  endCall (retVal) {
    this.completed = true
    this.retVal = retVal
  }
}

function isPromise (obj) {
  return obj && typeof obj === 'object' && typeof obj.then === 'function'
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
  let wrapped

  if (safeMode && original) {
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
    // We'll use it in the our wrapper (which, again, is called syncrhonously), and in the
    // errorHandler, which will already have been bound to this callState.
    let currentCallState

    // Rather than calling the original function directly from the shim wrapper, we wrap
    // it again so that we can track if it was called and if it returned. This is because
    // we need to know if an error was thrown by the original function, or by us.
    // We could do this inside the `wrapper` function defined below, which would simplify
    // managing the callState, but then we'd be calling `wrapper` on each invocation, so
    // instead we do it here, once.
    const innerWrapped = wrapper(function (...args) {
      // We need to stash the callState here because of recursion.
      const callState = currentCallState
      callState.startCall()
      const retVal = original.apply(this, args)
      if (isPromise(retVal)) {
        retVal.then(callState.endCall.bind(callState))
      } else {
        callState.endCall(retVal)
      }
      return retVal
    })

    // This is the crux of what we're doing in safe mode. It handles errors
    // that _we_ cause, by logging them, and transparently providing results
    // as if no wrapping was done at all. That means detecting (via callState)
    // whether the function has already run or not, and if it has, returning
    // the result, and otherwise calling the original function unwrapped.
    const handleError = function (args, callState, e) {
      if (callState.completed) {
        // error was thrown after original function returned/resolved, so
        // it was us. log it.
        log.error('Shimmer error was thrown after original function returned/resolved', e)
        // original ran and returned something. return it.
        return callState.retVal
      }

      if (!callState.called) {
        // error was thrown before original function was called, so
        // it was us. log it.
        log.error('Shimmer error was thrown before original function was called', e)
        // original never ran. call it unwrapped.
        return original.apply(this, args)
      }

      // error was thrown during original function execution, so
      // it was them. throw.
      throw e
    }

    // The wrapped function is the one that will be called by the user.
    // It calls our version of the original function, which manages the
    // callState. That way when we use the errorHandler, it can tell where
    // the error originated.
    wrapped = function (...args) {
      currentCallState = new CallState()
      const errorHandler = handleError.bind(this, args, currentCallState)

      try {
        const retVal = innerWrapped.apply(this, args)
        return isPromise(retVal) ? retVal.catch(errorHandler) : retVal
      } catch (e) {
        return errorHandler(e)
      }
    }
  } else {
    // In non-safe mode, we just wrap the original function directly.
    wrapped = wrapper(original)
  }
  const descriptor = Object.getOwnPropertyDescriptor(target, name)

  const attributes = {
    configurable: true,
    ...descriptor
  }

  if (typeof original === 'function') copyProperties(original, wrapped)

  if (descriptor) {
    unwrappers.set(wrapped, () => Object.defineProperty(target, name, descriptor))

    if (descriptor.get || descriptor.set) {
      attributes.get = () => wrapped
    } else {
      attributes.value = wrapped
    }

    // TODO: create a single object for multiple wrapped methods
    if (descriptor.configurable === false) {
      return Object.create(target, {
        [name]: attributes
      })
    }
  } else { // no descriptor means original was on the prototype
    unwrappers.set(wrapped, () => delete target[name])
    attributes.value = wrapped
    attributes.writable = true
  }

  Object.defineProperty(target, name, attributes)

  return target
}

function wrap (target, name, wrapper) {
  return typeof name === 'function'
    ? wrapFn(target, name)
    : wrapMethod(target, name, wrapper)
}

function unwrap (target, name) {
  if (!target) return target // no target to unwrap

  const unwrapper = unwrappers.get(name ? target[name] : target)

  if (!unwrapper) return target // target is already unwrapped or isn't wrapped

  unwrapper()

  return target
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

function massUnwrap (targets, names) {
  targets = toArray(targets)
  names = toArray(names)

  for (const target of targets) {
    for (const name of names) {
      unwrap(target, name)
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

  if (!target[name]) {
    throw new Error(`No original method ${name}.`)
  }

  if (typeof target[name] !== 'function') {
    throw new Error(`Original method ${name} is not a function.`)
  }
}

function assertFunction (target) {
  if (!target) {
    throw new Error('No function provided.')
  }

  if (typeof target !== 'function') {
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
  unwrap,
  massUnwrap,
  setSafe
}
