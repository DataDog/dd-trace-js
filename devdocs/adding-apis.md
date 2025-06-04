# Adding APIs to `dd-trace-api`

This guide explains how to expose `dd-trace` methods through the `dd-trace-api` package.

## Overview

Datadog’s tracing system includes two related packages:

- **`dd-trace`**: The core tracing library.
- **`dd-trace-api`**: A stable facade layer used in specialized deployments.

All APIs exposed via `dd-trace-api` exist in `dd-trace`. The facade adds flexibility for deployment and versioning.

You’ll typically update `dd-trace-api` when:

1. A **new method** is added to `dd-trace`.
2. An **existing method** in `dd-trace` needs to be exposed via `dd-trace-api`.

In either case, you’ll also update the `datadog-plugin-dd-trace-api` to bridge the method.

---

## Steps to Add an API

### 1. Implement or Identify the Method

Locate or add the desired method in `dd-trace` (e.g., `tracer.js`, `appsec`, etc.).

**Existing method example**:

```js
class DatadogTracer extends Tracer {
  getVersion() {
    return this._version
  }
}
```

**New method example**:

```js
class DatadogTracer extends Tracer {
  getEnvironmentInfo() {
    return {
      nodeVersion: process.version,
      platform: process.platform,
      tracerVersion: this._version
    }
  }
}
```

---

### 2. Update `dd-trace-api`

Expose the method by updating the `dd-trace-api` package.

Refer to the [contribution guide](https://github.com/DataDog/dd-trace-api-js/blob/bengl/adding-new-apis/docs/adding-api.md) for details.

---

### 3. Modify the Plugin

Bridge the method in `datadog-plugin-dd-trace-api` by adding a `handleEvent()` call:

```js
handleEvent('getVersion')             // For tracer methods
handleEvent('appsec:checkPermission') // For subsystem methods
```

File location:
```
packages/datadog-plugin-dd-trace-api/src/index.js
```

---

### 4. Add Tests

Add a test in:
```
packages/datadog-plugin-dd-trace-api/test/index.spec.js
```

**Example**:
```js
describe('getVersion', () => {
  it('should call underlying API', () => {
    testChannel({
      name: 'getVersion',
      fn: tracer.getVersion,
      ret: '1.2.3'
    })
  })
})
```

---

### 5. Handle Subsystem Methods

Use the `subsystem:method` format in `handleEvent()`:

```js
handleEvent('appsec:checkPermission')
```

And test with `describeSubsystem()`:

```js
describeSubsystem('appsec', 'checkPermission', true)
```

---

### 6. Handle Complex Methods

For non-trivial logic, define a custom handler:

```js
this.addSub('datadog-api:v1:complexMethod', ({ self, args, ret, proxy }) => {
  try {
    ret.value = self.complexMethod(...args)
  } catch (e) {
    ret.error = e
  }
})
```

---

## Channel System

`dd-trace-api` uses the `diagnostics_channel` system to communicate with `dd-trace`:

1. An API call publishes to `datadog-api:v1:methodName`.
2. The plugin handles the event:
   - Maps arguments/returns.
   - Calls the method on `dd-trace`.
   - Returns the result.

---

## Key Considerations

- **API Stability**: Be thoughtful when adding new methods; APIs exposed here are considered stable.
- **Telemetry**: All API calls are automatically tracked when using `handleEvent()`.
- **Object Mapping**: For complex return types, ensure proper proxying via the `proxy` parameter.
- **Documentation**: Update user-facing documentation after exposing new APIs.

---

## Example: Full API Addition

1. **Method in `dd-trace`**:
```js
class DatadogTracer extends Tracer {
  getServiceName() {
    return this._service
  }
}
```

2. **Expose in `dd-trace-api`**:
```js
getServiceName() {
  return this._publicApi.channel.publish('getServiceName', {})
}
```

3. **Bridge in plugin**:
```js
handleEvent('getServiceName')
```

4. **Add test**:
```js
describe('getServiceName', () => {
  it('should call underlying API', () => {
    testChannel({
      name: 'getServiceName',
      fn: tracer.getServiceName,
      ret: 'test-service'
    })
  })
})
```

---

With these changes, users of `dd-trace-api` can call `tracer.getServiceName()` just like they would with `dd-trace` directly.
