'use strict'

/**
 * @type {Set<string | symbol>}
 */
const skipMethods = new Set([
  'caller',
  'arguments',
  'name',
  'length',
])
const skipMethodSize = skipMethods.size

const nonConfigurableModuleExports = new WeakMap()

// Reused descriptor scratch space for the `name` and `length` slots that
// `copyProperties` and `wrapCallback` rewrite per wrap. `Object.defineProperty`
// reads the descriptor's slots synchronously and does not retain the object,
// so mutating `value` between calls is safe.
const lengthDescriptor = { value: 0, configurable: true }
const nameDescriptor = { value: '', configurable: true }

/**
 * @param {Function} original
 * @param {Function} wrapped
 */
function copyProperties (original, wrapped) {
  if (original.constructor !== wrapped.constructor) {
    const proto = Object.getPrototypeOf(original)
    Object.setPrototypeOf(wrapped, proto)
  }

  const ownKeys = Reflect.ownKeys(original)
  const originalLength = original.length
  if (originalLength !== wrapped.length) {
    lengthDescriptor.value = originalLength
    Object.defineProperty(wrapped, 'length', lengthDescriptor)
  }
  const originalName = original.name
  if (originalName !== wrapped.name) {
    nameDescriptor.value = originalName
    Object.defineProperty(wrapped, 'name', nameDescriptor)
  }
  if (ownKeys.length !== 2) {
    for (const key of ownKeys) {
      if (skipMethods.has(key)) continue
      const descriptor = /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(original, key))
      if (descriptor.writable && descriptor.enumerable && descriptor.configurable) {
        wrapped[key] = original[key]
      } else if (descriptor.writable || descriptor.configurable || !Object.hasOwn(wrapped, key)) {
        Object.defineProperty(wrapped, key, descriptor)
      }
    }
  }
}

/**
 * @param {Record<string | symbol, unknown>} original
 * @param {Record<string | symbol, unknown>} wrapped
 * @param {string | symbol} skipKey
 */
function copyObjectProperties (original, wrapped, skipKey) {
  const ownKeys = Reflect.ownKeys(original)
  for (const key of ownKeys) {
    if (key === skipKey) continue
    const descriptor = /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(original, key))
    if (descriptor.writable && descriptor.enumerable && descriptor.configurable) {
      wrapped[key] = original[key]
    } else if (descriptor.writable || descriptor.configurable || !Object.hasOwn(wrapped, key)) {
      Object.defineProperty(wrapped, key, descriptor)
    }
  }
}

/**
 * @param {Function} original
 * @param {(original: Function) => Function} wrapper
 */
function wrapFunction (original, wrapper) {
  if (typeof original !== 'function') return original

  const wrapped = wrapper(original)
  assertNotClass(original)
  copyProperties(original, wrapped)

  return wrapped
}

/**
 * Lean variant of `wrapFunction` for tracer-owned closures wrapping a
 * user-supplied callback. Preserves `name` and `length` only; skips the
 * prototype copy, `assertNotClass`, and the `Reflect.ownKeys` descriptor
 * walk. Use `wrapFunction` instead when the wrapped value needs its
 * prototype, has own properties the caller may read, or is `new`-ed.
 *
 * @param {Function} original
 * @param {(original: Function) => Function} wrapper
 */
function wrapCallback (original, wrapper) {
  if (typeof original !== 'function') {
    return original
  }
  const wrapped = wrapper(original)
  if (wrapped.name !== original.name) {
    nameDescriptor.value = original.name
    Object.defineProperty(wrapped, 'name', nameDescriptor)
  }
  if (wrapped.length !== original.length) {
    lengthDescriptor.value = original.length
    Object.defineProperty(wrapped, 'length', lengthDescriptor)
  }
  return wrapped
}

/**
 * Wraps a method of an object with a wrapper function.
 *
 * @param {Record<string | symbol, unknown> | Function | undefined} target - The target
 * object.
 * @param {string | symbol} name - The property key of the method to wrap.
 * @param {(original: Function) => (...args: unknown[]) => unknown} wrapper - The wrapper function.
 * @param {{ replaceGetter?: boolean }} [options] - If `replaceGetter` is set to
 * true, the getter is accessed and the getter is replaced with one that just
 * returns the earlier retrieved value. Use with care! This may only be done in
 * case the getter absolutely has no side effect and no setter is defined for the
 * property.
 * @returns {Record<string | symbol, unknown> | Function | undefined} The target object with
 * the wrapped method.
 */
function wrap (target, name, wrapper, options) {
  if (typeof wrapper !== 'function') {
    throw new TypeError(wrapper ? 'Target is not a function' : 'No function provided')
  }

  if (target == null) {
    // TODO: Add logging. This is an indicator that the part of a module that we
    // try to instrument changed.
    // Accessing the properties directly is in itself also unsafe, so we could just
    // pass through an array of properties that should be accessed and automatically
    // handle the access in here.
    return
  }

  // No descriptor means original was on the prototype. This is not totally
  // safe, since we define the property on the target. That could have an impact
  // in case e.g., the own keys are checks.
  const descriptor = Object.getOwnPropertyDescriptor(target, name) ?? {
    value: target[name],
    writable: true,
    configurable: true,
    enumerable: false,
  }

  if (descriptor.set && (!descriptor.get || options?.replaceGetter)) {
    // It is possible to support these cases by instrumenting both the getter
    // and setter (or only the setter, in case that is a use case).
    // For now, this is not supported due to the complexity and the fact that
    // this is not a common use case.
    throw new Error(options?.replaceGetter
      ? 'Replacing a getter/setter pair is not supported. Implement if required.'
      : 'Replacing setters is not supported. Implement if required.')
  }

  const original = descriptor.value ?? options?.replaceGetter ? target[name] : descriptor.get

  assertMethod(target, name, original)

  const wrapped = wrapper(original)

  copyProperties(original, wrapped)

  if (descriptor.writable) {
    if (descriptor.configurable && descriptor.enumerable) {
      target[name] = wrapped
      return target
    }
    descriptor.value = wrapped
  } else {
    if (descriptor.get) {
      // `replaceGetter` may only be used when the getter has no side effect.
      descriptor.get = options?.replaceGetter ? () => wrapped : wrapped
    } else {
      descriptor.value = wrapped
    }

    if (descriptor.configurable === false) {
      // TODO(BridgeAR): This currently only works on the most outer part. The
      // moduleExports object.
      //
      // It would be possible to also implement it for non moduleExports objects
      // by passing through the moduleExports object and the property names that
      // are accessed. That way it would be possible to redefine the complete
      // property chain. Example:
      //
      // shimmer.wrap(hapi.Server.prototype, 'start', wrapStart)
      // shimmer.wrap(hapi.Server.prototype, 'ext', wrapExt)
      //
      // shimmer.wrap(hapi, 'Server', 'prototype', 'start', wrapStart)
      // shimmer.wrap(hapi, 'Server', 'prototype', 'ext', wrapExt)
      //
      // That would however still not resolve the issue about the user replacing
      // the return value so that the hook picks up the new hapi moduleExports
      // object. To safely fix that, we would have to couple the register helper
      // with this code. That way it would be possible to directly pass through
      // the entries.

      let moduleExports = nonConfigurableModuleExports.get(target)
      if (!moduleExports) {
        if (typeof target === 'function') {
          const original = target
          moduleExports = function (...args) { return original.apply(original, args) }
          // This is a rare case. Accept the slight performance hit.
          skipMethods.add(name)
          copyProperties(target, moduleExports)
          if (skipMethods.size === skipMethodSize + 1) {
            skipMethods.delete(name)
          }
        } else {
          moduleExports = Object.create(target)
          copyObjectProperties(target, moduleExports, name)
        }
        nonConfigurableModuleExports.set(target, moduleExports)
      }
      target = moduleExports
    }
  }

  Object.defineProperty(target, name, descriptor)

  return target
}

/**
 * Wraps multiple methods and or multiple objects with a wrapper function.
 * May also receive a single method or object or a single method name.
 *
 * @param {Array<Record<string | symbol, unknown> | Function> |
 *         Record<string | symbol, unknown> |
 *         Function} targets - The target objects.
 * @param {Array<string | symbol> | string | symbol} names - The property keys of the methods to wrap.
 * @param {(original: Function) => (...args: unknown[]) => unknown} wrapper - The wrapper function.
 */
function massWrap (targets, names, wrapper) {
  targets = toArray(targets)
  names = toArray(names)

  for (const target of targets) {
    for (const name of names) {
      wrap(target, name, wrapper)
    }
  }
}

/**
 * Converts a value to an array if it is not already an array.
 *
 * @template T
 * @param {T | T[]} maybeArray - The value to convert.
 * @returns {T[]} The value as an array.
 */
function toArray (maybeArray) {
  return Array.isArray(maybeArray) ? maybeArray : [maybeArray]
}

/**
 * Asserts that a method is a function.
 *
 * @param {Record<string | symbol, unknown> | Function} target - The target object.
 * @param {string | symbol} name - The property key of the method.
 * @param {unknown} method - The method to assert.
 * @throws {Error} If the method is not a function.
 */
function assertMethod (target, name, method) {
  if (typeof method !== 'function') {
    let message = 'No target object provided'

    if (target) {
      if (typeof target !== 'object' && typeof target !== 'function') {
        message = 'Invalid target'
      } else {
        name = String(name)
        message = method ? `Original method ${name} is not a function` : `No original method ${name}`
      }
    }

    throw new TypeError(message)
  }
}

/**
 * Asserts that a target is not a class constructor.
 *
 * @param {Function} target - The target function.
 * @throws {Error} If the target is a class constructor.
 */
function assertNotClass (target) {
  // Class constructors have a non-writable `prototype` property; functions have a
  // writable one and arrows / async / method-shorthand have none at all. The
  // `'prototype' in target` gate skips the descriptor lookup for the no-prototype
  // shapes; the `in` operator is cheaper than reading `target.prototype` since
  // it returns a boolean instead of materialising the prototype reference.
  if ('prototype' in target &&
      Object.getOwnPropertyDescriptor(target, 'prototype').writable === false) {
    throw new TypeError('Target is a native class constructor and cannot be wrapped.')
  }
}

module.exports = {
  wrap,
  wrapCallback,
  wrapFunction,
  massWrap,
}
