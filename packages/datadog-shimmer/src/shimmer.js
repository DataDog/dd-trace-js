'use strict'

/**
 * @type {Set<string | symbol>}
 */
const skipMethods = new Set([
  'caller',
  'arguments',
  'name',
  'length'
])
const skipMethodSize = skipMethods.size

const nonConfigurableModuleExports = new WeakMap()

/**
 * Copies properties from the original function to the wrapped function.
 *
 * @param {Function} original - The original function.
 * @param {Function} wrapped - The wrapped function.
 */
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
 * Copies properties from the original object to the wrapped object, skipping a specific key.
 *
 * @param {Record<string | symbol, unknown>} original - The original object.
 * @param {Record<string | symbol, unknown>} wrapped - The wrapped object.
 * @param {string | symbol} skipKey - The key to skip during copying.
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
 * Wraps a function with a wrapper function.
 *
 * @param {Function} original - The original function to wrap.
 * @param {(original: Function) => Function} wrapper - The wrapper function.
 * @returns {Function} The wrapped function.
 */
function wrapFunction (original, wrapper) {
  const wrapped = wrapper(original)

  if (typeof original === 'function') {
    assertNotClass(original)
    copyProperties(original, wrapped)
  }

  return wrapped
}

/**
 * Wraps a method of an object with a wrapper function.
 *
 * @param {Record<string | symbol, unknown> | Function} target - The target
 * object.
 * @param {string | symbol} name - The property key of the method to wrap.
 * @param {(original: Function) => (...args) => any} wrapper - The wrapper function.
 * @param {{ replaceGetter?: boolean }} [options] - If `replaceGetter` is set to
 * true, the getter is accessed and the getter is replaced with one that just
 * returns the earlier retrieved value. Use with care! This may only be done in
 * case the getter absolutely has no side effect and no setter is defined for the
 * property.
 * @returns {Record<string | symbol, unknown> | Function} The target object with
 * the wrapped method.
 */
function wrap (target, name, wrapper, options) {
  if (typeof wrapper !== 'function') {
    throw new TypeError(wrapper ? 'Target is not a function' : 'No function provided')
  }

  // No descriptor means original was on the prototype. This is not totally
  // safe, since we define the property on the target. That could have an impact
  // in case e.g., the own keys are checks.
  const descriptor = Object.getOwnPropertyDescriptor(target, name) ?? {
    value: target[name],
    writable: true,
    configurable: true,
    enumerable: false
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
    // Fast path for assigned properties.
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

      // In case more than a single property is not configurable and writable,
      // Just reuse the already created object.
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
 * @param {(original: Function) => (...args) => any} wrapper - The wrapper function.
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
  if (Function.prototype.toString.call(target).startsWith('class')) {
    throw new TypeError('Target is a native class constructor and cannot be wrapped.')
  }
}

module.exports = {
  wrap,
  wrapFunction,
  massWrap
}
