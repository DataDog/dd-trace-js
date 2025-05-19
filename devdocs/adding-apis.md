# Adding APIs to dd-trace-api

This guide explains how to expose dd-trace API methods through the dd-trace-api package.

## Overview

Datadog's tracing system has two related packages:
- **dd-trace**: The main tracing library that users typically use directly
- **dd-trace-api**: A facade layer providing a stable API (used for specialized deployment scenarios)

The dd-trace-api package is a thin API facade that enables specialized deployment scenarios. All APIs exposed in dd-trace-api are also available directly in dd-trace, but the separate API package gives us flexibility in deployment and versioning.

You may need to expose an API through dd-trace-api in two common scenarios:
1. When you've added a **new method** to dd-trace
2. When there's an **existing method** in dd-trace that should also be available through dd-trace-api

In both cases, the process is the same - you'll need to update the `datadog-plugin-dd-trace-api` plugin to make the method available through the dd-trace-api facade.

## Step-by-Step Guide

### 1. Identify or implement the method in dd-trace

First, either:
- Identify an existing method in dd-trace that you want to expose through dd-trace-api, or
- Implement new functionality in dd-trace

This could be a method on the tracer, appsec, or another subsystem.

Example of an existing method you might want to expose:
```js
// Already exists in packages/dd-trace/src/tracer.js
class DatadogTracer extends Tracer {
  // This method might exist but not be exposed through dd-trace-api yet
  getVersion() {
    return this._version
  }
}
```

Example of adding a new method:
```js
// Adding a new method to packages/dd-trace/src/tracer.js
class DatadogTracer extends Tracer {
  // ...existing methods...
  
  getEnvironmentInfo() {
    return {
      nodeVersion: process.version,
      platform: process.platform,
      tracerVersion: this._version
    }
  }
}
```

### 2. Add the method to dd-trace-api

The dd-trace-api package needs to be updated to include the new method. This package defines the public interface that will be available to users who import dd-trace-api instead of dd-trace directly.

Instructions on adding a new API to that package can be found here: https://github.com/DataDog/dd-trace-api-js/blob/bengl/adding-new-apis/docs/adding-api.md

### 3. Update the dd-trace-api plugin

Once you've added the method to dd-trace-api, you need to update the `datadog-plugin-dd-trace-api` plugin to handle the method call and bridge it to dd-trace.

Open `packages/datadog-plugin-dd-trace-api/src/index.js` and add a new event handler for your method:

```js
// In packages/datadog-plugin-dd-trace-api/src/index.js

// Add your method to the end of the list of handleEvent calls 
handleEvent('getVersion')  // Simple method with no special handling

// For methods on subsystems, use the subsystem:method pattern
// handleEvent('subsystem:methodName')
```

### 4. Test the API

Add tests for your API endpoint in `packages/datadog-plugin-dd-trace-api/test/index.spec.js`.

Example:

```js
describe('getVersion', () => {
  it('should call underlying api', () => {
    testChannel({
      name: 'getVersion',
      fn: tracer.getVersion,
      ret: '1.2.3'  // Expected return value
    })
  })
})
```

### 5. Add subsystem methods (if applicable)

If your method belongs to a subsystem (like appsec or dogstatsd), use the subsystem pattern:

```js
// In packages/datadog-plugin-dd-trace-api/src/index.js
handleEvent('subsystem:methodName')

// For example, to add a new appsec method:
handleEvent('appsec:checkPermission')
```

In the test file, you would use the `describeSubsystem` helper:

```js
describeSubsystem('appsec', 'checkPermission', true) // true is the expected return value
```

### 6. Handle complex methods (if necessary)

For methods requiring special handling (like proxying objects or custom parameter processing), you may need to customize the handler. You can do this by implementing a custom handler function instead of using the generic one:

```js
// Example of a custom handler for a complex method
this.addSub(`datadog-api:v1:complexMethod`, ({ self, args, ret, proxy }) => {
  // Custom handling code here
  // ...
  
  try {
    ret.value = self.complexMethod(...args)
    // Additional processing if needed
  } catch (e) {
    ret.error = e
  }
})
```

## Note on Channel System

The dd-trace-api plugin uses Node.js's `diagnostics_channel` system (wrapped by `dc-polyfill`) to bridge between the dd-trace-api facade and the dd-trace implementation. When an API method is called:

1. It publishes an event on the `datadog-api:v1:methodName` channel
2. The plugin handles this event by:
   - Mapping objects between the facade layer and dd-trace
   - Calling the dd-trace implementation
   - Mapping results back to dd-trace-api
   - Returning the result

## Important Considerations

1. **API Stability**: The dd-trace-api facade provides API stability. Be thoughtful when adding new APIs that may need to be supported long-term.

2. **Telemetry**: All API calls are tracked with telemetry. This happens automatically when you use `handleEvent()`.

3. **Object Mapping**: If your API returns complex objects that might be passed back to other API calls later, ensure they're properly proxied using the `proxy` parameter.

4. **Documentation**: After exposing an API, remember to update the external documentation for users.

## Example: Complete API Addition

Here's a complete example of exposing a method through dd-trace-api:

1. **The method in dd-trace**:
```js
// In packages/dd-trace/src/tracer.js
class DatadogTracer extends Tracer {
  getServiceName() {
    return this._service
  }
}
```

2. **Add to dd-trace-api**:
```js
// In the appropriate dd-trace-api file
getServiceName() {
  return this._publicApi.channel.publish('getServiceName', {})
}
```

3. **Plugin update**:
```js
// In packages/datadog-plugin-dd-trace-api/src/index.js
handleEvent('getServiceName')
```

4. **Test implementation**:
```js
// In packages/datadog-plugin-dd-trace-api/test/index.spec.js
describe('getServiceName', () => {
  it('should call underlying api', () => {
    testChannel({
      name: 'getServiceName',
      fn: tracer.getServiceName,
      ret: 'test-service'  // Expected return value
    })
  })
})
```

With these changes, users of the dd-trace-api package would be able to call `tracer.getServiceName()` and get the service name set in the tracer, just as they can with dd-trace directly.
