"use strict";
var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};

// packages/dd-trace/src/util.js
var require_util = __commonJS({
  "packages/dd-trace/src/util.js"(exports2, module2) {
    "use strict";
    var path = require("path");
    function isTrue(str) {
      str = String(str).toLowerCase();
      return str === "true" || str === "1";
    }
    function isFalse(str) {
      str = String(str).toLowerCase();
      return str === "false" || str === "0";
    }
    function isError(value) {
      if (value instanceof Error) {
        return true;
      }
      if (value && value.message && value.stack) {
        return true;
      }
      return false;
    }
    function globMatch(pattern, subject) {
      let px = 0;
      let sx = 0;
      let nextPx = 0;
      let nextSx = 0;
      while (px < pattern.length || sx < subject.length) {
        if (px < pattern.length) {
          const c = pattern[px];
          switch (c) {
            default:
              if (sx < subject.length && subject[sx] === c) {
                px++;
                sx++;
                continue;
              }
              break;
            case "?":
              if (sx < subject.length) {
                px++;
                sx++;
                continue;
              }
              break;
            case "*":
              nextPx = px;
              nextSx = sx + 1;
              px++;
              continue;
          }
        }
        if (nextSx > 0 && nextSx <= subject.length) {
          px = nextPx;
          sx = nextSx;
          continue;
        }
        return false;
      }
      return true;
    }
    function calculateDDBasePath(dirname) {
      const dirSteps = dirname.split(path.sep);
      const packagesIndex = dirSteps.lastIndexOf("packages");
      return dirSteps.slice(0, packagesIndex).join(path.sep) + path.sep;
    }
    module2.exports = {
      isTrue,
      isFalse,
      isError,
      globMatch,
      calculateDDBasePath
    };
  }
});

// packages/dd-trace/src/noop/scope.js
var require_scope = __commonJS({
  "packages/dd-trace/src/noop/scope.js"(exports2, module2) {
    "use strict";
    var Scope = class {
      active() {
        return null;
      }
      activate(span, callback) {
        if (typeof callback !== "function")
          return callback;
        return callback();
      }
      bind(fn, span) {
        return fn;
      }
    };
    module2.exports = Scope;
  }
});

// ext/priority.js
var require_priority = __commonJS({
  "ext/priority.js"(exports2, module2) {
    "use strict";
    module2.exports = {
      USER_REJECT: -1,
      AUTO_REJECT: 0,
      AUTO_KEEP: 1,
      USER_KEEP: 2
    };
  }
});

// packages/dd-trace/src/opentracing/span_context.js
var require_span_context = __commonJS({
  "packages/dd-trace/src/opentracing/span_context.js"(exports2, module2) {
    "use strict";
    var { AUTO_KEEP } = require_priority();
    var DatadogSpanContext = class {
      constructor(props) {
        props = props || {};
        this._traceId = props.traceId;
        this._spanId = props.spanId;
        this._parentId = props.parentId || null;
        this._name = props.name;
        this._isFinished = props.isFinished || false;
        this._tags = props.tags || {};
        this._sampling = Object.assign({}, props.sampling);
        this._baggageItems = props.baggageItems || {};
        this._traceparent = props.traceparent;
        this._tracestate = props.tracestate;
        this._noop = props.noop || null;
        this._trace = props.trace || {
          started: [],
          finished: [],
          tags: {}
        };
      }
      toTraceId() {
        return this._traceId.toString(10);
      }
      toSpanId() {
        return this._spanId.toString(10);
      }
      toTraceparent() {
        const flags = this._sampling.priority >= AUTO_KEEP ? "01" : "00";
        const traceId = this._traceId.toBuffer().length <= 8 && this._trace.tags["_dd.p.tid"] ? this._trace.tags["_dd.p.tid"] + this._traceId.toString(16).padStart(16, "0") : this._traceId.toString(16).padStart(32, "0");
        const spanId = this._spanId.toString(16).padStart(16, "0");
        const version = this._traceparent && this._traceparent.version || "00";
        return `${version}-${traceId}-${spanId}-${flags}`;
      }
    };
    module2.exports = DatadogSpanContext;
  }
});

// packages/dd-trace/src/noop/span_context.js
var require_span_context2 = __commonJS({
  "packages/dd-trace/src/noop/span_context.js"(exports2, module2) {
    "use strict";
    var DatadogSpanContext = require_span_context();
    var priority = require_priority();
    var USER_REJECT = priority.USER_REJECT;
    var NoopSpanContext = class extends DatadogSpanContext {
      constructor(props) {
        super(props);
        this._sampling.priority = USER_REJECT;
      }
    };
    module2.exports = NoopSpanContext;
  }
});

// packages/dd-trace/src/id.js
var require_id = __commonJS({
  "packages/dd-trace/src/id.js"(exports2, module2) {
    "use strict";
    var { randomFillSync } = require("crypto");
    var UINT_MAX = 4294967296;
    var data = new Uint8Array(8 * 8192);
    var zeroId = new Uint8Array(8);
    var map = Array.prototype.map;
    var pad = (byte) => `${byte < 16 ? "0" : ""}${byte.toString(16)}`;
    var batch = 0;
    var Identifier = class {
      constructor(value, radix = 16) {
        this._isUint64BE = true;
        this._buffer = radix === 16 ? createBuffer(value) : fromString(value, radix);
      }
      toString(radix = 16) {
        return radix === 16 ? toHexString(this._buffer) : toNumberString(this._buffer, radix);
      }
      toBuffer() {
        return this._buffer;
      }
      // msgpack-lite compatibility
      toArray() {
        if (this._buffer.length === 8) {
          return this._buffer;
        }
        return this._buffer.slice(-8);
      }
      toJSON() {
        return this.toString();
      }
    };
    function createBuffer(value) {
      if (value === "0")
        return zeroId;
      if (!value)
        return pseudoRandom();
      const size = Math.ceil(value.length / 16) * 16;
      const bytes = size / 2;
      const buffer = new Array(bytes);
      value = value.padStart(size, "0");
      for (let i = 0; i < bytes; i++) {
        buffer[i] = parseInt(value.substring(i * 2, i * 2 + 2), 16);
      }
      return buffer;
    }
    function fromString(str, raddix) {
      const buffer = new Array(8);
      const len = str.length;
      let pos = 0;
      let high = 0;
      let low = 0;
      if (str[0] === "-")
        pos++;
      const sign = pos;
      while (pos < len) {
        const chr = parseInt(str[pos++], raddix);
        if (!(chr >= 0))
          break;
        low = low * raddix + chr;
        high = high * raddix + Math.floor(low / UINT_MAX);
        low %= UINT_MAX;
      }
      if (sign) {
        high = ~high;
        if (low) {
          low = UINT_MAX - low;
        } else {
          high++;
        }
      }
      writeUInt32BE(buffer, high, 0);
      writeUInt32BE(buffer, low, 4);
      return buffer;
    }
    function toNumberString(buffer, radix) {
      let high = readInt32(buffer, buffer.length - 8);
      let low = readInt32(buffer, buffer.length - 4);
      let str = "";
      radix = radix || 10;
      while (1) {
        const mod = high % radix * UINT_MAX + low;
        high = Math.floor(high / radix);
        low = Math.floor(mod / radix);
        str = (mod % radix).toString(radix) + str;
        if (!high && !low)
          break;
      }
      return str;
    }
    function toHexString(buffer) {
      return map.call(buffer, pad).join("");
    }
    function pseudoRandom() {
      if (batch === 0) {
        randomFillSync(data);
      }
      batch = (batch + 1) % 8192;
      const offset = batch * 8;
      return [
        data[offset] & 127,
        // only positive int64,
        data[offset + 1],
        data[offset + 2],
        data[offset + 3],
        data[offset + 4],
        data[offset + 5],
        data[offset + 6],
        data[offset + 7]
      ];
    }
    function readInt32(buffer, offset) {
      return buffer[offset + 0] * 16777216 + (buffer[offset + 1] << 16) + (buffer[offset + 2] << 8) + buffer[offset + 3];
    }
    function writeUInt32BE(buffer, value, offset) {
      buffer[3 + offset] = value & 255;
      value = value >> 8;
      buffer[2 + offset] = value & 255;
      value = value >> 8;
      buffer[1 + offset] = value & 255;
      value = value >> 8;
      buffer[0 + offset] = value & 255;
    }
    module2.exports = (value, radix) => new Identifier(value, radix);
  }
});

// packages/diagnostics_channel/src/index.js
var require_src = __commonJS({
  "packages/diagnostics_channel/src/index.js"(exports2, module2) {
    "use strict";
    var {
      Channel,
      channel
    } = require("diagnostics_channel");
    var [major, minor] = process.versions.node.split(".");
    var channels = /* @__PURE__ */ new WeakSet();
    var dc = { channel };
    if (major === "19" && minor === "9") {
      dc.channel = function() {
        const ch = channel.apply(this, arguments);
        if (!channels.has(ch)) {
          const subscribe = ch.subscribe;
          const unsubscribe = ch.unsubscribe;
          ch.subscribe = function() {
            delete ch.subscribe;
            delete ch.unsubscribe;
            const result = subscribe.apply(this, arguments);
            this.subscribe(() => {
            });
            return result;
          };
          if (ch.unsubscribe === Channel.prototype.unsubscribe) {
            ch.unsubscribe = function() {
              delete ch.subscribe;
              delete ch.unsubscribe;
              this.subscribe(() => {
              });
              return unsubscribe.apply(this, arguments);
            };
          }
          channels.add(ch);
        }
        return ch;
      };
    }
    module2.exports = dc;
  }
});

// packages/diagnostics_channel/index.js
var require_diagnostics_channel = __commonJS({
  "packages/diagnostics_channel/index.js"(exports2, module2) {
    "use strict";
    module2.exports = require_src();
  }
});

// packages/datadog-core/src/storage/async_resource.js
var require_async_resource = __commonJS({
  "packages/datadog-core/src/storage/async_resource.js"(exports2, module2) {
    "use strict";
    var { createHook, executionAsyncResource } = require("async_hooks");
    var { channel } = require_diagnostics_channel();
    var beforeCh = channel("dd-trace:storage:before");
    var afterCh = channel("dd-trace:storage:after");
    var PrivateSymbol = Symbol;
    function makePrivateSymbol() {
      PrivateSymbol = new Function("name", "return %CreatePrivateSymbol(name)");
    }
    try {
      makePrivateSymbol();
    } catch (e) {
      try {
        const v8 = require("v8");
        v8.setFlagsFromString("--allow-natives-syntax");
        makePrivateSymbol();
        v8.setFlagsFromString("--no-allow-natives-syntax");
      } catch (e2) {
      }
    }
    var AsyncResourceStorage = class {
      constructor() {
        this._ddResourceStore = PrivateSymbol("ddResourceStore");
        this._enabled = false;
        this._hook = createHook(this._createHook());
      }
      disable() {
        if (!this._enabled)
          return;
        this._hook.disable();
        this._enabled = false;
      }
      getStore() {
        if (!this._enabled)
          return;
        const resource = this._executionAsyncResource();
        return resource[this._ddResourceStore];
      }
      enterWith(store) {
        this._enable();
        const resource = this._executionAsyncResource();
        resource[this._ddResourceStore] = store;
      }
      run(store, callback, ...args) {
        this._enable();
        const resource = this._executionAsyncResource();
        const oldStore = resource[this._ddResourceStore];
        resource[this._ddResourceStore] = store;
        try {
          return callback(...args);
        } finally {
          resource[this._ddResourceStore] = oldStore;
        }
      }
      _createHook() {
        return {
          init: this._init.bind(this),
          before() {
            beforeCh.publish();
          },
          after() {
            afterCh.publish();
          }
        };
      }
      _enable() {
        if (this._enabled)
          return;
        this._enabled = true;
        this._hook.enable();
      }
      _init(asyncId, type, triggerAsyncId, resource) {
        const currentResource = this._executionAsyncResource();
        if (Object.prototype.hasOwnProperty.call(currentResource, this._ddResourceStore)) {
          resource[this._ddResourceStore] = currentResource[this._ddResourceStore];
        }
      }
      _executionAsyncResource() {
        return executionAsyncResource() || {};
      }
    };
    module2.exports = AsyncResourceStorage;
  }
});

// packages/datadog-core/src/storage/async_hooks.js
var require_async_hooks = __commonJS({
  "packages/datadog-core/src/storage/async_hooks.js"(exports2, module2) {
    "use strict";
    var { executionAsyncId } = require("async_hooks");
    var AsyncResourceStorage = require_async_resource();
    var AsyncHooksStorage = class extends AsyncResourceStorage {
      constructor() {
        super();
        this._resources = /* @__PURE__ */ new Map();
      }
      disable() {
        super.disable();
        this._resources.clear();
      }
      _createHook() {
        return {
          ...super._createHook(),
          destroy: this._destroy.bind(this)
        };
      }
      _init(asyncId, type, triggerAsyncId, resource) {
        super._init.apply(this, arguments);
        this._resources.set(asyncId, resource);
      }
      _destroy(asyncId) {
        this._resources.delete(asyncId);
      }
      _executionAsyncResource() {
        const asyncId = executionAsyncId();
        let resource = this._resources.get(asyncId);
        if (!resource) {
          this._resources.set(asyncId, resource = {});
        }
        return resource;
      }
    };
    module2.exports = AsyncHooksStorage;
  }
});

// packages/datadog-core/src/storage/index.js
var require_storage = __commonJS({
  "packages/datadog-core/src/storage/index.js"(exports2, module2) {
    "use strict";
    var semver = require("semver");
    var hasJavaScriptAsyncHooks = semver.satisfies(process.versions.node, ">=14.5");
    if (hasJavaScriptAsyncHooks) {
      module2.exports = require_async_resource();
    } else {
      module2.exports = require_async_hooks();
    }
  }
});

// packages/datadog-core/index.js
var require_datadog_core = __commonJS({
  "packages/datadog-core/index.js"(exports2, module2) {
    "use strict";
    var LocalStorage = require_storage();
    var storage = new LocalStorage();
    module2.exports = { storage };
  }
});

// packages/dd-trace/src/noop/span.js
var require_span = __commonJS({
  "packages/dd-trace/src/noop/span.js"(exports2, module2) {
    "use strict";
    var NoopSpanContext = require_span_context2();
    var id = require_id();
    var { storage } = require_datadog_core();
    var NoopSpan = class {
      constructor(tracer, parent) {
        this._store = storage.getStore();
        this._noopTracer = tracer;
        this._noopContext = this._createContext(parent);
      }
      context() {
        return this._noopContext;
      }
      tracer() {
        return this._noopTracer;
      }
      setOperationName(name) {
        return this;
      }
      setBaggageItem(key, value) {
        return this;
      }
      getBaggageItem(key) {
      }
      setTag(key, value) {
        return this;
      }
      addTags(keyValueMap) {
        return this;
      }
      log() {
        return this;
      }
      logEvent() {
      }
      finish(finishTime) {
      }
      _createContext(parent) {
        const spanId = id();
        if (parent) {
          return new NoopSpanContext({
            noop: this,
            traceId: parent._traceId,
            spanId,
            parentId: parent._spanId,
            baggageItems: Object.assign({}, parent._baggageItems)
          });
        } else {
          return new NoopSpanContext({
            noop: this,
            traceId: spanId,
            spanId
          });
        }
      }
    };
    module2.exports = NoopSpan;
  }
});

// packages/dd-trace/src/noop/tracer.js
var require_tracer = __commonJS({
  "packages/dd-trace/src/noop/tracer.js"(exports2, module2) {
    "use strict";
    var Scope = require_scope();
    var Span = require_span();
    var NoopTracer = class {
      constructor(config) {
        this._scope = new Scope();
        this._span = new Span(this);
      }
      trace(name, options, fn) {
        return fn(this._span, () => {
        });
      }
      wrap(name, options, fn) {
        return fn;
      }
      scope() {
        return this._scope;
      }
      getRumData() {
        return "";
      }
      setUrl() {
      }
      startSpan(name, options) {
        return this._span;
      }
      inject(spanContext, format, carrier) {
      }
      extract(format, carrier) {
        return this._span.context();
      }
      setUser() {
        return this;
      }
    };
    module2.exports = NoopTracer;
  }
});

// packages/dd-trace/src/appsec/sdk/noop.js
var require_noop = __commonJS({
  "packages/dd-trace/src/appsec/sdk/noop.js"(exports2, module2) {
    "use strict";
    var NoopAppsecSdk = class {
      trackUserLoginSuccessEvent() {
      }
      trackUserLoginFailureEvent() {
      }
      trackCustomEvent() {
      }
      isUserBlocked() {
      }
      blockRequest() {
      }
      setUser() {
      }
    };
    module2.exports = NoopAppsecSdk;
  }
});

// packages/dd-trace/src/noop/proxy.js
var require_proxy = __commonJS({
  "packages/dd-trace/src/noop/proxy.js"(exports2, module2) {
    "use strict";
    var NoopTracer = require_tracer();
    var NoopAppsecSdk = require_noop();
    var noop = new NoopTracer();
    var noopAppsec = new NoopAppsecSdk();
    var Tracer = class {
      constructor() {
        this._tracer = noop;
        this.appsec = noopAppsec;
      }
      init() {
        return this;
      }
      use() {
        return this;
      }
      trace(name, options, fn) {
        if (!fn) {
          fn = options;
          options = {};
        }
        if (typeof fn !== "function")
          return;
        options = options || {};
        return this._tracer.trace(name, options, fn);
      }
      wrap(name, options, fn) {
        if (!fn) {
          fn = options;
          options = {};
        }
        if (typeof fn !== "function")
          return fn;
        options = options || {};
        return this._tracer.wrap(name, options, fn);
      }
      setUrl() {
        this._tracer.setUrl.apply(this._tracer, arguments);
        return this;
      }
      startSpan() {
        return this._tracer.startSpan.apply(this._tracer, arguments);
      }
      inject() {
        return this._tracer.inject.apply(this._tracer, arguments);
      }
      extract() {
        return this._tracer.extract.apply(this._tracer, arguments);
      }
      scope() {
        return this._tracer.scope.apply(this._tracer, arguments);
      }
      getRumData() {
        return this._tracer.getRumData.apply(this._tracer, arguments);
      }
      setUser(user) {
        this.appsec.setUser(user);
        return this;
      }
    };
    module2.exports = Tracer;
  }
});

// packages/dd-trace/src/log/channels.js
var require_channels = __commonJS({
  "packages/dd-trace/src/log/channels.js"(exports2, module2) {
    "use strict";
    var { channel } = require_diagnostics_channel();
    var Level = {
      Debug: "debug",
      Info: "info",
      Warn: "warn",
      Error: "error"
    };
    var defaultLevel = Level.Debug;
    var logChannels = {
      [Level.Debug]: createLogChannel(Level.Debug, 20),
      [Level.Info]: createLogChannel(Level.Info, 30),
      [Level.Warn]: createLogChannel(Level.Warn, 40),
      [Level.Error]: createLogChannel(Level.Error, 50)
    };
    function createLogChannel(name, logLevel) {
      const logChannel = channel(`datadog:log:${name}`);
      logChannel.logLevel = logLevel;
      return logChannel;
    }
    function getChannelLogLevel(level) {
      let logChannel;
      if (level && typeof level === "string") {
        logChannel = logChannels[level.toLowerCase().trim()] || logChannels[defaultLevel];
      } else {
        logChannel = logChannels[defaultLevel];
      }
      return logChannel.logLevel;
    }
    module2.exports = {
      Level,
      getChannelLogLevel,
      debugChannel: logChannels[Level.Debug],
      infoChannel: logChannels[Level.Info],
      warnChannel: logChannels[Level.Warn],
      errorChannel: logChannels[Level.Error]
    };
  }
});

// packages/dd-trace/src/log/writer.js
var require_writer = __commonJS({
  "packages/dd-trace/src/log/writer.js"(exports2, module2) {
    "use strict";
    var { storage } = require_datadog_core();
    var { getChannelLogLevel, debugChannel, infoChannel, warnChannel, errorChannel } = require_channels();
    var defaultLogger = {
      debug: (msg) => console.debug(msg),
      /* eslint-disable-line no-console */
      info: (msg) => console.info(msg),
      /* eslint-disable-line no-console */
      warn: (msg) => console.warn(msg),
      /* eslint-disable-line no-console */
      error: (msg) => console.error(msg)
      /* eslint-disable-line no-console */
    };
    var enabled = false;
    var logger = defaultLogger;
    var logLevel = getChannelLogLevel();
    function withNoop(fn) {
      const store = storage.getStore();
      storage.enterWith({ noop: true });
      fn();
      storage.enterWith(store);
    }
    function unsubscribeAll() {
      if (debugChannel.hasSubscribers) {
        debugChannel.unsubscribe(onDebug);
      }
      if (infoChannel.hasSubscribers) {
        infoChannel.unsubscribe(onInfo);
      }
      if (warnChannel.hasSubscribers) {
        warnChannel.unsubscribe(onWarn);
      }
      if (errorChannel.hasSubscribers) {
        errorChannel.unsubscribe(onError);
      }
    }
    function toggleSubscription(enable) {
      unsubscribeAll();
      if (enable) {
        if (debugChannel.logLevel >= logLevel) {
          debugChannel.subscribe(onDebug);
        }
        if (infoChannel.logLevel >= logLevel) {
          infoChannel.subscribe(onInfo);
        }
        if (warnChannel.logLevel >= logLevel) {
          warnChannel.subscribe(onWarn);
        }
        if (errorChannel.logLevel >= logLevel) {
          errorChannel.subscribe(onError);
        }
      }
    }
    function toggle(enable, level) {
      if (level !== void 0) {
        logLevel = getChannelLogLevel(level);
      }
      enabled = enable;
      toggleSubscription(enabled);
    }
    function use(newLogger) {
      if (newLogger && newLogger.debug instanceof Function && newLogger.error instanceof Function) {
        logger = newLogger;
      }
    }
    function reset() {
      logger = defaultLogger;
      enabled = false;
      logLevel = getChannelLogLevel();
      toggleSubscription(false);
    }
    function onError(err) {
      if (enabled)
        error(err);
    }
    function onWarn(message) {
      if (enabled)
        warn(message);
    }
    function onInfo(message) {
      if (enabled)
        info(message);
    }
    function onDebug(message) {
      if (enabled)
        debug(message);
    }
    function error(err) {
      if (typeof err !== "object" || !err) {
        err = String(err);
      } else if (!err.stack) {
        err = String(err.message || err);
      }
      if (typeof err === "string") {
        err = new Error(err);
      }
      withNoop(() => logger.error(err));
    }
    function warn(message) {
      if (!logger.warn)
        return debug(message);
      withNoop(() => logger.warn(message));
    }
    function info(message) {
      if (!logger.info)
        return debug(message);
      withNoop(() => logger.info(message));
    }
    function debug(message) {
      withNoop(() => logger.debug(message));
    }
    module2.exports = { use, toggle, reset, error, warn, info, debug };
  }
});

// packages/dd-trace/src/log/index.js
var require_log = __commonJS({
  "packages/dd-trace/src/log/index.js"(exports2, module2) {
    "use strict";
    var { debugChannel, infoChannel, warnChannel, errorChannel } = require_channels();
    var logWriter = require_writer();
    var memoize = (func) => {
      const cache = {};
      const memoized = function(key) {
        if (!cache[key]) {
          cache[key] = func.apply(this, arguments);
        }
        return cache[key];
      };
      return memoized;
    };
    function processMsg(msg) {
      return typeof msg === "function" ? msg() : msg;
    }
    var log = {
      use(logger) {
        logWriter.use(logger);
        return this;
      },
      toggle(enabled, logLevel) {
        logWriter.toggle(enabled, logLevel);
        return this;
      },
      reset() {
        logWriter.reset();
        this._deprecate = memoize((code, message) => {
          errorChannel.publish(message);
          return true;
        });
        return this;
      },
      debug(message) {
        if (debugChannel.hasSubscribers) {
          debugChannel.publish(processMsg(message));
        }
        return this;
      },
      info(message) {
        if (infoChannel.hasSubscribers) {
          infoChannel.publish(processMsg(message));
        }
        return this;
      },
      warn(message) {
        if (warnChannel.hasSubscribers) {
          warnChannel.publish(processMsg(message));
        }
        return this;
      },
      error(err) {
        if (errorChannel.hasSubscribers) {
          errorChannel.publish(processMsg(err));
        }
        return this;
      },
      deprecate(code, message) {
        return this._deprecate(code, message);
      }
    };
    log.reset();
    module2.exports = log;
  }
});

// packages/dd-trace/src/tagger.js
var require_tagger = __commonJS({
  "packages/dd-trace/src/tagger.js"(exports2, module2) {
    "use strict";
    var log = require_log();
    function add(carrier, keyValuePairs) {
      if (!carrier || !keyValuePairs)
        return;
      if (Array.isArray(keyValuePairs)) {
        return keyValuePairs.forEach((tags) => add(carrier, tags));
      }
      try {
        if (typeof keyValuePairs === "string") {
          const segments = keyValuePairs.split(",");
          for (const segment of segments) {
            const separatorIndex = segment.indexOf(":");
            if (separatorIndex === -1)
              continue;
            const key = segment.slice(0, separatorIndex);
            const value = segment.slice(separatorIndex + 1);
            carrier[key.trim()] = value.trim();
          }
        } else {
          Object.assign(carrier, keyValuePairs);
        }
      } catch (e) {
        log.error(e);
      }
    }
    module2.exports = { add };
  }
});

// packages/dd-trace/src/exporters/common/docker.js
var require_docker = __commonJS({
  "packages/dd-trace/src/exporters/common/docker.js"(exports2, module2) {
    "use strict";
    var fs = require("fs");
    var uuidSource = "[0-9a-f]{8}[-_][0-9a-f]{4}[-_][0-9a-f]{4}[-_][0-9a-f]{4}[-_][0-9a-f]{12}|[0-9a-f]{8}(?:-[0-9a-f]{4}){4}$";
    var containerSource = "[0-9a-f]{64}";
    var taskSource = "[0-9a-f]{32}-\\d+";
    var entityReg = new RegExp(`.*(${uuidSource}|${containerSource}|${taskSource})(?:\\.scope)?$`, "m");
    var entityId = getEntityId();
    function getEntityId() {
      const cgroup = readControlGroup() || "";
      const match = cgroup.trim().match(entityReg) || [];
      return match[1];
    }
    function readControlGroup() {
      try {
        return fs.readFileSync("/proc/self/cgroup").toString();
      } catch (err) {
      }
    }
    module2.exports = {
      // can be the container ID but not always depending on the orchestrator
      id() {
        return entityId;
      }
    };
  }
});

// packages/dd-trace/src/exporters/common/agents.js
var require_agents = __commonJS({
  "packages/dd-trace/src/exporters/common/agents.js"(exports2, module2) {
    "use strict";
    var http = require("http");
    var https = require("https");
    var { storage } = require_datadog_core();
    var keepAlive = true;
    var maxSockets = 1;
    function createAgentClass(BaseAgent) {
      class CustomAgent extends BaseAgent {
        constructor() {
          super({ keepAlive, maxSockets });
        }
        createConnection(...args) {
          return this._noop(() => super.createConnection(...args));
        }
        keepSocketAlive(...args) {
          return this._noop(() => super.keepSocketAlive(...args));
        }
        reuseSocket(...args) {
          return this._noop(() => super.reuseSocket(...args));
        }
        _noop(callback) {
          return storage.run({ noop: true }, callback);
        }
      }
      return CustomAgent;
    }
    var HttpAgent = createAgentClass(http.Agent);
    var HttpsAgent = createAgentClass(https.Agent);
    module2.exports = {
      httpAgent: new HttpAgent(),
      HttpsAgent: new HttpsAgent()
    };
  }
});

// packages/dd-trace/src/exporters/common/request.js
var require_request = __commonJS({
  "packages/dd-trace/src/exporters/common/request.js"(exports2, module2) {
    "use strict";
    var { Readable } = require("stream");
    var http = require("http");
    var https = require("https");
    var { parse: urlParse } = require("url");
    var docker = require_docker();
    var { httpAgent, httpsAgent } = require_agents();
    var { storage } = require_datadog_core();
    var log = require_log();
    var maxActiveRequests = 8;
    var containerId = docker.id();
    var activeRequests = 0;
    function urlToOptions(url) {
      const agent = url.agent || http.globalAgent;
      const options = {
        protocol: url.protocol || agent.protocol,
        hostname: typeof url.hostname === "string" && url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname || url.host || "localhost",
        hash: url.hash,
        search: url.search,
        pathname: url.pathname,
        path: `${url.pathname || ""}${url.search || ""}`,
        href: url.href
      };
      if (url.port !== "") {
        options.port = Number(url.port);
      }
      if (url.username || url.password) {
        options.auth = `${url.username}:${url.password}`;
      }
      return options;
    }
    function fromUrlString(url) {
      return typeof urlToHttpOptions === "function" ? urlToOptions(new URL(url)) : urlParse(url);
    }
    function request(data, options, callback) {
      if (!options.headers) {
        options.headers = {};
      }
      if (options.url) {
        const url = typeof options.url === "object" ? urlToOptions(options.url) : fromUrlString(options.url);
        if (url.protocol === "unix:") {
          options.socketPath = url.pathname;
        } else {
          if (!options.path)
            options.path = url.path;
          options.protocol = url.protocol;
          options.hostname = url.hostname;
          options.port = url.port;
        }
      }
      const isReadable = data instanceof Readable;
      const timeout = options.timeout || 2e3;
      const isSecure = options.protocol === "https:";
      const client = isSecure ? https : http;
      const dataArray = [].concat(data);
      if (!isReadable) {
        options.headers["Content-Length"] = byteLength(dataArray);
      }
      if (containerId) {
        options.headers["Datadog-Container-ID"] = containerId;
      }
      options.agent = isSecure ? httpsAgent : httpAgent;
      const onResponse = (res) => {
        let responseData = "";
        res.setTimeout(timeout);
        res.on("data", (chunk) => {
          responseData += chunk;
        });
        res.on("end", () => {
          activeRequests--;
          if (res.statusCode >= 200 && res.statusCode <= 299) {
            callback(null, responseData, res.statusCode);
          } else {
            let errorMessage = "";
            try {
              const fullUrl = new URL(
                options.path,
                options.url || options.hostname || `http://localhost:${options.port}`
              ).href;
              errorMessage = `Error from ${fullUrl}: ${res.statusCode} ${http.STATUS_CODES[res.statusCode]}.`;
            } catch (e) {
            }
            if (responseData) {
              errorMessage += ` Response from the endpoint: "${responseData}"`;
            }
            const error = new Error(errorMessage);
            error.status = res.statusCode;
            callback(error, null, res.statusCode);
          }
        });
      };
      const makeRequest = (onError) => {
        if (!request.writable) {
          log.debug("Maximum number of active requests reached: payload is discarded.");
          return callback(null);
        }
        activeRequests++;
        const store = storage.getStore();
        storage.enterWith({ noop: true });
        const req = client.request(options, onResponse);
        req.once("error", (err) => {
          activeRequests--;
          onError(err);
        });
        req.setTimeout(timeout, req.abort);
        if (isReadable) {
          data.pipe(req);
        } else {
          dataArray.forEach((buffer) => req.write(buffer));
          req.end();
        }
        storage.enterWith(store);
      };
      makeRequest(() => setTimeout(() => makeRequest(callback)));
    }
    function byteLength(data) {
      return data.length > 0 ? data.reduce((prev, next) => prev + next.length, 0) : 0;
    }
    Object.defineProperty(request, "writable", {
      get() {
        return activeRequests < maxActiveRequests;
      }
    });
    module2.exports = request;
  }
});

// packages/dd-trace/src/dogstatsd.js
var require_dogstatsd = __commonJS({
  "packages/dd-trace/src/dogstatsd.js"(exports2, module2) {
    "use strict";
    var lookup = require("dns").lookup;
    var request = require_request();
    var dgram = require("dgram");
    var isIP = require("net").isIP;
    var log = require_log();
    var MAX_BUFFER_SIZE = 1024;
    var Client = class {
      constructor(options) {
        options = options || {};
        if (options.metricsProxyUrl) {
          this._httpOptions = {
            url: options.metricsProxyUrl.toString(),
            path: "/dogstatsd/v2/proxy"
          };
        }
        this._host = options.host || "localhost";
        this._family = isIP(this._host);
        this._port = options.port || 8125;
        this._prefix = options.prefix || "";
        this._tags = options.tags || [];
        this._queue = [];
        this._buffer = "";
        this._offset = 0;
        this._udp4 = this._socket("udp4");
        this._udp6 = this._socket("udp6");
      }
      gauge(stat, value, tags) {
        this._add(stat, value, "g", tags);
      }
      increment(stat, value, tags) {
        this._add(stat, value, "c", tags);
      }
      flush() {
        const queue = this._enqueue();
        if (this._queue.length === 0)
          return;
        this._queue = [];
        if (this._httpOptions) {
          this._sendHttp(queue);
        } else {
          this._sendUdp(queue);
        }
      }
      _sendHttp(queue) {
        const buffer = Buffer.concat(queue);
        request(buffer, this._httpOptions, (err) => {
          if (err) {
            log.error("HTTP error from agent: " + err.stack);
            if (err.status) {
              if (err.status === 404) {
                this._httpOptions = null;
              }
              this._sendUdp(queue);
            }
          }
        });
      }
      _sendUdp(queue) {
        if (this._family !== 0) {
          this._sendUdpFromQueue(queue, this._host, this._family);
        } else {
          lookup(this._host, (err, address, family) => {
            if (err)
              return log.error(err);
            this._sendUdpFromQueue(queue, address, family);
          });
        }
      }
      _sendUdpFromQueue(queue, address, family) {
        const socket = family === 6 ? this._udp6 : this._udp4;
        queue.forEach((buffer) => {
          log.debug(`Sending to DogStatsD: ${buffer}`);
          socket.send(buffer, 0, buffer.length, this._port, address);
        });
      }
      _add(stat, value, type, tags) {
        const message = `${this._prefix + stat}:${value}|${type}`;
        tags = tags ? this._tags.concat(tags) : this._tags;
        if (tags.length > 0) {
          this._write(`${message}|#${tags.join(",")}
`);
        } else {
          this._write(`${message}
`);
        }
      }
      _write(message) {
        const offset = Buffer.byteLength(message);
        if (this._offset + offset > MAX_BUFFER_SIZE) {
          this._enqueue();
        }
        this._offset += offset;
        this._buffer += message;
      }
      _enqueue() {
        if (this._offset > 0) {
          this._queue.push(Buffer.from(this._buffer));
          this._buffer = "";
          this._offset = 0;
        }
        return this._queue;
      }
      _socket(type) {
        const socket = dgram.createSocket(type);
        socket.on("error", () => {
        });
        socket.unref();
        return socket;
      }
    };
    module2.exports = Client;
  }
});

// packages/dd-trace/src/histogram.js
var require_histogram = __commonJS({
  "packages/dd-trace/src/histogram.js"(exports2, module2) {
    "use strict";
    var { DDSketch } = require("@datadog/sketches-js");
    var Histogram = class {
      constructor() {
        this.reset();
      }
      get min() {
        return this._min;
      }
      get max() {
        return this._max;
      }
      get avg() {
        return this._count === 0 ? 0 : this._sum / this._count;
      }
      get sum() {
        return this._sum;
      }
      get count() {
        return this._count;
      }
      get median() {
        return this.percentile(50);
      }
      get p95() {
        return this.percentile(95);
      }
      percentile(percentile) {
        return this._histogram.getValueAtQuantile(percentile / 100) || 0;
      }
      record(value) {
        if (this._count === 0) {
          this._min = this._max = value;
        } else {
          this._min = Math.min(this._min, value);
          this._max = Math.max(this._max, value);
        }
        this._count++;
        this._sum += value;
        this._histogram.accept(value);
      }
      reset() {
        this._min = 0;
        this._max = 0;
        this._sum = 0;
        this._count = 0;
        this._histogram = new DDSketch();
      }
    };
    module2.exports = Histogram;
  }
});

// packages/dd-trace/src/metrics.js
var require_metrics = __commonJS({
  "packages/dd-trace/src/metrics.js"(exports2, module2) {
    "use strict";
    var { URL: URL2, format } = require("url");
    var v8 = require("v8");
    var os = require("os");
    var Client = require_dogstatsd();
    var log = require_log();
    var Histogram = require_histogram();
    var { performance } = require("perf_hooks");
    var INTERVAL = 10 * 1e3;
    var nativeMetrics = null;
    var interval;
    var client;
    var time;
    var cpuUsage;
    var gauges;
    var counters;
    var histograms;
    var elu;
    reset();
    module2.exports = {
      start(config) {
        const tags = [];
        Object.keys(config.tags).filter((key) => typeof config.tags[key] === "string").filter((key) => {
          if (key !== "runtime-id")
            return true;
          return config.experimental && config.experimental.runtimeId;
        }).forEach((key) => {
          const value = config.tags[key].replace(/[^a-z0-9_:./-]/ig, "_");
          tags.push(`${key}:${value}`);
        });
        try {
          nativeMetrics = require("@datadog/native-metrics");
          nativeMetrics.start();
        } catch (e) {
          log.error(e);
          nativeMetrics = null;
        }
        const clientConfig = {
          host: config.dogstatsd.hostname,
          port: config.dogstatsd.port,
          tags
        };
        if (config.url) {
          clientConfig.metricsProxyUrl = config.url;
        } else if (config.port) {
          clientConfig.metricsProxyUrl = new URL2(format({
            protocol: "http:",
            hostname: config.hostname || "localhost",
            port: config.port
          }));
        }
        client = new Client(clientConfig);
        time = process.hrtime();
        if (nativeMetrics) {
          interval = setInterval(() => {
            captureCommonMetrics();
            captureNativeMetrics();
            client.flush();
          }, INTERVAL);
        } else {
          cpuUsage = process.cpuUsage();
          interval = setInterval(() => {
            captureCommonMetrics();
            captureCpuUsage();
            captureHeapSpace();
            client.flush();
          }, INTERVAL);
        }
        interval.unref();
      },
      stop() {
        if (nativeMetrics) {
          nativeMetrics.stop();
        }
        clearInterval(interval);
        reset();
      },
      track(span) {
        if (nativeMetrics) {
          const handle = nativeMetrics.track(span);
          return {
            finish: () => nativeMetrics.finish(handle)
          };
        }
        return { finish: () => {
        } };
      },
      boolean(name, value, tag) {
        this.gauge(name, value ? 1 : 0, tag);
      },
      histogram(name, value, tag) {
        if (!client)
          return;
        histograms[name] = histograms[name] || /* @__PURE__ */ new Map();
        if (!histograms[name].has(tag)) {
          histograms[name].set(tag, new Histogram());
        }
        histograms[name].get(tag).record(value);
      },
      count(name, count, tag, monotonic = false) {
        if (!client)
          return;
        if (typeof tag === "boolean") {
          monotonic = tag;
          tag = void 0;
        }
        const map = monotonic ? counters : gauges;
        map[name] = map[name] || /* @__PURE__ */ new Map();
        const value = map[name].get(tag) || 0;
        map[name].set(tag, value + count);
      },
      gauge(name, value, tag) {
        if (!client)
          return;
        gauges[name] = gauges[name] || /* @__PURE__ */ new Map();
        gauges[name].set(tag, value);
      },
      increment(name, tag, monotonic) {
        this.count(name, 1, tag, monotonic);
      },
      decrement(name, tag) {
        this.count(name, -1, tag);
      }
    };
    function reset() {
      interval = null;
      client = null;
      time = null;
      cpuUsage = null;
      gauges = {};
      counters = {};
      histograms = {};
      nativeMetrics = null;
    }
    function captureCpuUsage() {
      if (!process.cpuUsage)
        return;
      const elapsedTime = process.hrtime(time);
      const elapsedUsage = process.cpuUsage(cpuUsage);
      time = process.hrtime();
      cpuUsage = process.cpuUsage();
      const elapsedMs = elapsedTime[0] * 1e3 + elapsedTime[1] / 1e6;
      const userPercent = 100 * elapsedUsage.user / 1e3 / elapsedMs;
      const systemPercent = 100 * elapsedUsage.system / 1e3 / elapsedMs;
      const totalPercent = userPercent + systemPercent;
      client.gauge("runtime.node.cpu.system", systemPercent.toFixed(2));
      client.gauge("runtime.node.cpu.user", userPercent.toFixed(2));
      client.gauge("runtime.node.cpu.total", totalPercent.toFixed(2));
    }
    function captureMemoryUsage() {
      const stats = process.memoryUsage();
      client.gauge("runtime.node.mem.heap_total", stats.heapTotal);
      client.gauge("runtime.node.mem.heap_used", stats.heapUsed);
      client.gauge("runtime.node.mem.rss", stats.rss);
      client.gauge("runtime.node.mem.total", os.totalmem());
      client.gauge("runtime.node.mem.free", os.freemem());
      stats.external && client.gauge("runtime.node.mem.external", stats.external);
    }
    function captureProcess() {
      client.gauge("runtime.node.process.uptime", Math.round(process.uptime()));
    }
    function captureHeapStats() {
      const stats = v8.getHeapStatistics();
      client.gauge("runtime.node.heap.total_heap_size", stats.total_heap_size);
      client.gauge("runtime.node.heap.total_heap_size_executable", stats.total_heap_size_executable);
      client.gauge("runtime.node.heap.total_physical_size", stats.total_physical_size);
      client.gauge("runtime.node.heap.total_available_size", stats.total_available_size);
      client.gauge("runtime.node.heap.heap_size_limit", stats.heap_size_limit);
      stats.malloced_memory && client.gauge("runtime.node.heap.malloced_memory", stats.malloced_memory);
      stats.peak_malloced_memory && client.gauge("runtime.node.heap.peak_malloced_memory", stats.peak_malloced_memory);
    }
    function captureHeapSpace() {
      if (!v8.getHeapSpaceStatistics)
        return;
      const stats = v8.getHeapSpaceStatistics();
      for (let i = 0, l = stats.length; i < l; i++) {
        const tags = [`space:${stats[i].space_name}`];
        client.gauge("runtime.node.heap.size.by.space", stats[i].space_size, tags);
        client.gauge("runtime.node.heap.used_size.by.space", stats[i].space_used_size, tags);
        client.gauge("runtime.node.heap.available_size.by.space", stats[i].space_available_size, tags);
        client.gauge("runtime.node.heap.physical_size.by.space", stats[i].physical_space_size, tags);
      }
    }
    function captureGauges() {
      Object.keys(gauges).forEach((name) => {
        gauges[name].forEach((value, tag) => {
          client.gauge(name, value, tag && [tag]);
        });
      });
    }
    function captureCounters() {
      Object.keys(counters).forEach((name) => {
        counters[name].forEach((value, tag) => {
          client.increment(name, value, tag && [tag]);
        });
      });
      counters = {};
    }
    function captureHistograms() {
      Object.keys(histograms).forEach((name) => {
        histograms[name].forEach((stats, tag) => {
          histogram(name, stats, tag && [tag]);
          stats.reset();
        });
      });
    }
    var captureELU = "eventLoopUtilization" in performance ? () => {
      elu = performance.eventLoopUtilization(elu);
      client.gauge("runtime.node.event_loop.utilization", elu.utilization);
    } : () => {
    };
    function captureCommonMetrics() {
      captureMemoryUsage();
      captureProcess();
      captureHeapStats();
      captureGauges();
      captureCounters();
      captureHistograms();
      captureELU();
    }
    function captureNativeMetrics() {
      const stats = nativeMetrics.stats();
      const spaces = stats.heap.spaces;
      const elapsedTime = process.hrtime(time);
      time = process.hrtime();
      const elapsedUs = elapsedTime[0] * 1e6 + elapsedTime[1] / 1e3;
      const userPercent = 100 * stats.cpu.user / elapsedUs;
      const systemPercent = 100 * stats.cpu.system / elapsedUs;
      const totalPercent = userPercent + systemPercent;
      client.gauge("runtime.node.cpu.system", systemPercent.toFixed(2));
      client.gauge("runtime.node.cpu.user", userPercent.toFixed(2));
      client.gauge("runtime.node.cpu.total", totalPercent.toFixed(2));
      histogram("runtime.node.event_loop.delay", stats.eventLoop);
      Object.keys(stats.gc).forEach((type) => {
        if (type === "all") {
          histogram("runtime.node.gc.pause", stats.gc[type]);
        } else {
          histogram("runtime.node.gc.pause.by.type", stats.gc[type], [`gc_type:${type}`]);
        }
      });
      for (let i = 0, l = spaces.length; i < l; i++) {
        const tags = [`heap_space:${spaces[i].space_name}`];
        client.gauge("runtime.node.heap.size.by.space", spaces[i].space_size, tags);
        client.gauge("runtime.node.heap.used_size.by.space", spaces[i].space_used_size, tags);
        client.gauge("runtime.node.heap.available_size.by.space", spaces[i].space_available_size, tags);
        client.gauge("runtime.node.heap.physical_size.by.space", spaces[i].physical_space_size, tags);
      }
    }
    function histogram(name, stats, tags) {
      tags = [].concat(tags);
      client.gauge(`${name}.min`, stats.min, tags);
      client.gauge(`${name}.max`, stats.max, tags);
      client.increment(`${name}.sum`, stats.sum, tags);
      client.increment(`${name}.total`, stats.sum, tags);
      client.gauge(`${name}.avg`, stats.avg, tags);
      client.increment(`${name}.count`, stats.count, tags);
      client.gauge(`${name}.median`, stats.median, tags);
      client.gauge(`${name}.95percentile`, stats.p95, tags);
    }
  }
});

// packages/dd-trace/src/opentracing/span.js
var require_span2 = __commonJS({
  "packages/dd-trace/src/opentracing/span.js"(exports2, module2) {
    "use strict";
    var { performance } = require("perf_hooks");
    var now = performance.now.bind(performance);
    var dateNow = Date.now;
    var semver = require("semver");
    var SpanContext = require_span_context();
    var id = require_id();
    var tagger = require_tagger();
    var metrics = require_metrics();
    var log = require_log();
    var { storage } = require_datadog_core();
    var {
      DD_TRACE_EXPERIMENTAL_STATE_TRACKING,
      DD_TRACE_EXPERIMENTAL_SPAN_COUNTS
    } = process.env;
    var unfinishedRegistry = createRegistry("unfinished");
    var finishedRegistry = createRegistry("finished");
    var DatadogSpan = class {
      constructor(tracer, processor, prioritySampler, fields, debug) {
        const operationName = fields.operationName;
        const parent = fields.parent || null;
        const tags = Object.assign({}, fields.tags);
        const hostname = fields.hostname;
        this._parentTracer = tracer;
        this._debug = debug;
        this._processor = processor;
        this._prioritySampler = prioritySampler;
        this._store = storage.getStore();
        this._duration = void 0;
        this._name = operationName;
        this._spanContext = this._createContext(parent, fields);
        this._spanContext._name = operationName;
        this._spanContext._tags = tags;
        this._spanContext._hostname = hostname;
        this._startTime = fields.startTime || this._getTime();
        if (DD_TRACE_EXPERIMENTAL_SPAN_COUNTS && finishedRegistry) {
          metrics.increment("runtime.node.spans.unfinished");
          metrics.increment("runtime.node.spans.unfinished.by.name", `span_name:${operationName}`);
          metrics.increment("runtime.node.spans.open");
          metrics.increment("runtime.node.spans.open.by.name", `span_name:${operationName}`);
          unfinishedRegistry.register(this, operationName, this);
        }
      }
      toString() {
        const spanContext = this.context();
        const resourceName = spanContext._tags["resource.name"];
        const resource = resourceName.length > 100 ? `${resourceName.substring(0, 97)}...` : resourceName;
        const json = JSON.stringify({
          traceId: spanContext._traceId,
          spanId: spanContext._spanId,
          parentId: spanContext._parentId,
          service: spanContext._tags["service.name"],
          name: spanContext._name,
          resource
        });
        return `Span${json}`;
      }
      context() {
        return this._spanContext;
      }
      tracer() {
        return this._parentTracer;
      }
      setOperationName(name) {
        this._spanContext._name = name;
        return this;
      }
      setBaggageItem(key, value) {
        this._spanContext._baggageItems[key] = value;
        return this;
      }
      getBaggageItem(key) {
        return this._spanContext._baggageItems[key];
      }
      setTag(key, value) {
        this._addTags({ [key]: value });
        return this;
      }
      addTags(keyValueMap) {
        this._addTags(keyValueMap);
        return this;
      }
      log() {
        return this;
      }
      logEvent() {
      }
      finish(finishTime) {
        if (this._duration !== void 0) {
          return;
        }
        if (DD_TRACE_EXPERIMENTAL_STATE_TRACKING === "true") {
          if (!this._spanContext._tags["service.name"]) {
            log.error(`Finishing invalid span: ${this}`);
          }
        }
        if (DD_TRACE_EXPERIMENTAL_SPAN_COUNTS && finishedRegistry) {
          metrics.decrement("runtime.node.spans.unfinished");
          metrics.decrement("runtime.node.spans.unfinished.by.name", `span_name:${this._name}`);
          metrics.increment("runtime.node.spans.finished");
          metrics.increment("runtime.node.spans.finished.by.name", `span_name:${this._name}`);
          metrics.decrement("runtime.node.spans.open");
          metrics.decrement("runtime.node.spans.open.by.name", `span_name:${this._name}`);
          unfinishedRegistry.unregister(this);
          finishedRegistry.register(this, this._name);
        }
        finishTime = parseFloat(finishTime) || this._getTime();
        this._duration = finishTime - this._startTime;
        this._spanContext._trace.finished.push(this);
        this._spanContext._isFinished = true;
        this._processor.process(this);
      }
      _createContext(parent, fields) {
        let spanContext;
        if (parent) {
          spanContext = new SpanContext({
            traceId: parent._traceId,
            spanId: id(),
            parentId: parent._spanId,
            sampling: parent._sampling,
            baggageItems: Object.assign({}, parent._baggageItems),
            trace: parent._trace,
            tracestate: parent._tracestate
          });
          if (!spanContext._trace.startTime) {
            spanContext._trace.startTime = dateNow();
          }
        } else {
          const spanId = id();
          const startTime = dateNow();
          spanContext = new SpanContext({
            traceId: spanId,
            spanId
          });
          spanContext._trace.startTime = startTime;
          if (fields.traceId128BitGenerationEnabled) {
            spanContext._trace.tags["_dd.p.tid"] = Math.floor(startTime / 1e3).toString(16).padStart(8, "0").padEnd(16, "0");
          }
        }
        spanContext._trace.started.push(this);
        spanContext._trace.ticks = spanContext._trace.ticks || now();
        return spanContext;
      }
      _getTime() {
        const { startTime, ticks } = this._spanContext._trace;
        return startTime + now() - ticks;
      }
      _addTags(keyValuePairs) {
        tagger.add(this._spanContext._tags, keyValuePairs);
        this._prioritySampler.sample(this, false);
      }
    };
    function createRegistry(type) {
      if (!semver.satisfies(process.version, ">=14.6"))
        return;
      return new global.FinalizationRegistry((name) => {
        metrics.decrement(`runtime.node.spans.${type}`);
        metrics.decrement(`runtime.node.spans.${type}.by.name`, [`span_name:${name}`]);
      });
    }
    module2.exports = DatadogSpan;
  }
});

// packages/dd-trace/src/constants.js
var require_constants = __commonJS({
  "packages/dd-trace/src/constants.js"(exports2, module2) {
    "use strict";
    module2.exports = {
      SAMPLING_PRIORITY_KEY: "_sampling_priority_v1",
      ANALYTICS_KEY: "_dd1.sr.eausr",
      ORIGIN_KEY: "_dd.origin",
      HOSTNAME_KEY: "_dd.hostname",
      TOP_LEVEL_KEY: "_dd.top_level",
      SAMPLING_RULE_DECISION: "_dd.rule_psr",
      SAMPLING_LIMIT_DECISION: "_dd.limit_psr",
      SAMPLING_AGENT_DECISION: "_dd.agent_psr",
      SAMPLING_MECHANISM_DEFAULT: 0,
      SAMPLING_MECHANISM_AGENT: 1,
      SAMPLING_MECHANISM_RULE: 3,
      SAMPLING_MECHANISM_MANUAL: 4,
      SAMPLING_MECHANISM_APPSEC: 5,
      SAMPLING_MECHANISM_SPAN: 8,
      SPAN_SAMPLING_MECHANISM: "_dd.span_sampling.mechanism",
      SPAN_SAMPLING_RULE_RATE: "_dd.span_sampling.rule_rate",
      SPAN_SAMPLING_MAX_PER_SECOND: "_dd.span_sampling.max_per_second",
      DATADOG_LAMBDA_EXTENSION_PATH: "/opt/extensions/datadog-agent",
      DECISION_MAKER_KEY: "_dd.p.dm",
      PROCESS_ID: "process_id",
      ERROR_TYPE: "error.type",
      ERROR_MESSAGE: "error.message",
      ERROR_STACK: "error.stack",
      COMPONENT: "component",
      CLIENT_PORT_KEY: "network.destination.port"
    };
  }
});

// ext/tags.js
var require_tags = __commonJS({
  "ext/tags.js"(exports2, module2) {
    "use strict";
    var tags = {
      // Common
      SERVICE_NAME: "service.name",
      RESOURCE_NAME: "resource.name",
      SPAN_TYPE: "span.type",
      SPAN_KIND: "span.kind",
      SAMPLING_PRIORITY: "sampling.priority",
      ANALYTICS: "_dd1.sr.eausr",
      ERROR: "error",
      MANUAL_KEEP: "manual.keep",
      MANUAL_DROP: "manual.drop",
      MEASURED: "_dd.measured",
      // HTTP
      HTTP_URL: "http.url",
      HTTP_METHOD: "http.method",
      HTTP_STATUS_CODE: "http.status_code",
      HTTP_ROUTE: "http.route",
      HTTP_REQUEST_HEADERS: "http.request.headers",
      HTTP_RESPONSE_HEADERS: "http.response.headers",
      HTTP_USERAGENT: "http.useragent",
      HTTP_CLIENT_IP: "http.client_ip"
    };
    tags.ANALYTICS_SAMPLE_RATE = tags.ANALYTICS;
    module2.exports = tags;
  }
});

// packages/dd-trace/src/format.js
var require_format = __commonJS({
  "packages/dd-trace/src/format.js"(exports2, module2) {
    "use strict";
    var constants = require_constants();
    var tags = require_tags();
    var id = require_id();
    var { isError } = require_util();
    var SAMPLING_PRIORITY_KEY = constants.SAMPLING_PRIORITY_KEY;
    var SAMPLING_RULE_DECISION = constants.SAMPLING_RULE_DECISION;
    var SAMPLING_LIMIT_DECISION = constants.SAMPLING_LIMIT_DECISION;
    var SAMPLING_AGENT_DECISION = constants.SAMPLING_AGENT_DECISION;
    var SPAN_SAMPLING_MECHANISM = constants.SPAN_SAMPLING_MECHANISM;
    var SPAN_SAMPLING_RULE_RATE = constants.SPAN_SAMPLING_RULE_RATE;
    var SPAN_SAMPLING_MAX_PER_SECOND = constants.SPAN_SAMPLING_MAX_PER_SECOND;
    var SAMPLING_MECHANISM_SPAN = constants.SAMPLING_MECHANISM_SPAN;
    var MEASURED = tags.MEASURED;
    var ORIGIN_KEY = constants.ORIGIN_KEY;
    var HOSTNAME_KEY = constants.HOSTNAME_KEY;
    var TOP_LEVEL_KEY = constants.TOP_LEVEL_KEY;
    var PROCESS_ID = constants.PROCESS_ID;
    var ERROR_MESSAGE = constants.ERROR_MESSAGE;
    var ERROR_STACK = constants.ERROR_STACK;
    var ERROR_TYPE = constants.ERROR_TYPE;
    var map = {
      "service.name": "service",
      "span.type": "type",
      "resource.name": "resource"
    };
    function format(span) {
      const formatted = formatSpan(span);
      extractRootTags(formatted, span);
      extractChunkTags(formatted, span);
      extractTags(formatted, span);
      return formatted;
    }
    function formatSpan(span) {
      const spanContext = span.context();
      return {
        trace_id: spanContext._traceId,
        span_id: spanContext._spanId,
        parent_id: spanContext._parentId || id("0"),
        name: String(spanContext._name),
        resource: String(spanContext._name),
        error: 0,
        meta: {},
        metrics: {},
        start: Math.round(span._startTime * 1e6),
        duration: Math.round(span._duration * 1e6)
      };
    }
    function setSingleSpanIngestionTags(span, options) {
      if (!options)
        return;
      addTag({}, span.metrics, SPAN_SAMPLING_MECHANISM, SAMPLING_MECHANISM_SPAN);
      addTag({}, span.metrics, SPAN_SAMPLING_RULE_RATE, options.sampleRate);
      addTag({}, span.metrics, SPAN_SAMPLING_MAX_PER_SECOND, options.maxPerSecond);
    }
    function extractTags(trace, span) {
      const context = span.context();
      const origin = context._trace.origin;
      const tags2 = context._tags;
      const hostname = context._hostname;
      const priority = context._sampling.priority;
      if (tags2["span.kind"] && tags2["span.kind"] !== "internal") {
        addTag({}, trace.metrics, MEASURED, 1);
      }
      for (const tag in tags2) {
        switch (tag) {
          case "service.name":
          case "span.type":
          case "resource.name":
            addTag(trace, {}, map[tag], tags2[tag]);
            break;
          case "http.status_code":
            addTag(trace.meta, {}, tag, tags2[tag] && String(tags2[tag]));
            break;
          case HOSTNAME_KEY:
          case MEASURED:
            addTag({}, trace.metrics, tag, tags2[tag] === void 0 || tags2[tag] ? 1 : 0);
            break;
          case "error":
            if (context._name !== "fs.operation") {
              extractError(trace, tags2[tag]);
            }
            break;
          case ERROR_TYPE:
          case ERROR_MESSAGE:
          case ERROR_STACK:
            if (context._name !== "fs.operation") {
              trace.error = 1;
            } else {
              break;
            }
          default:
            addTag(trace.meta, trace.metrics, tag, tags2[tag]);
        }
      }
      setSingleSpanIngestionTags(trace, context._sampling.spanSampling);
      addTag(trace.meta, trace.metrics, "language", "javascript");
      addTag(trace.meta, trace.metrics, PROCESS_ID, process.pid);
      addTag(trace.meta, trace.metrics, SAMPLING_PRIORITY_KEY, priority);
      addTag(trace.meta, trace.metrics, ORIGIN_KEY, origin);
      addTag(trace.meta, trace.metrics, HOSTNAME_KEY, hostname);
    }
    function extractRootTags(trace, span) {
      const context = span.context();
      const isLocalRoot = span === context._trace.started[0];
      const parentId = context._parentId;
      if (!isLocalRoot || parentId && parentId.toString(10) !== "0")
        return;
      addTag({}, trace.metrics, SAMPLING_RULE_DECISION, context._trace[SAMPLING_RULE_DECISION]);
      addTag({}, trace.metrics, SAMPLING_LIMIT_DECISION, context._trace[SAMPLING_LIMIT_DECISION]);
      addTag({}, trace.metrics, SAMPLING_AGENT_DECISION, context._trace[SAMPLING_AGENT_DECISION]);
      addTag({}, trace.metrics, TOP_LEVEL_KEY, 1);
    }
    function extractChunkTags(trace, span) {
      const context = span.context();
      const isLocalRoot = span === context._trace.started[0];
      if (!isLocalRoot)
        return;
      for (const key in context._trace.tags) {
        addTag(trace.meta, trace.metrics, key, context._trace.tags[key]);
      }
    }
    function extractError(trace, error) {
      if (!error)
        return;
      trace.error = 1;
      if (isError(error)) {
        addTag(trace.meta, trace.metrics, ERROR_MESSAGE, error.message || error.code);
        addTag(trace.meta, trace.metrics, ERROR_TYPE, error.name);
        addTag(trace.meta, trace.metrics, ERROR_STACK, error.stack);
      }
    }
    function addTag(meta, metrics, key, value, nested) {
      switch (typeof value) {
        case "string":
          if (!value)
            break;
          meta[key] = value;
          break;
        case "number":
          if (isNaN(value))
            break;
          metrics[key] = value;
          break;
        case "boolean":
          metrics[key] = value ? 1 : 0;
          break;
        case "undefined":
          break;
        case "object":
          if (value === null)
            break;
          if (isNodeBuffer(value) || isUrl(value)) {
            metrics[key] = value.toString();
          } else if (!Array.isArray(value) && !nested) {
            for (const prop in value) {
              if (!hasOwn(value, prop))
                continue;
              addTag(meta, metrics, `${key}.${prop}`, value[prop], true);
            }
          }
          break;
      }
    }
    function hasOwn(object, prop) {
      return Object.prototype.hasOwnProperty.call(object, prop);
    }
    function isNodeBuffer(obj) {
      return obj.constructor && obj.constructor.name === "Buffer" && typeof obj.readInt8 === "function" && typeof obj.toString === "function";
    }
    function isUrl(obj) {
      return obj.constructor && obj.constructor.name === "URL" && typeof obj.href === "string" && typeof obj.toString === "function";
    }
    module2.exports = format;
  }
});

// ext/formats.js
var require_formats = __commonJS({
  "ext/formats.js"(exports2, module2) {
    "use strict";
    module2.exports = {
      TEXT_MAP: "text_map",
      HTTP_HEADERS: "http_headers",
      BINARY: "binary",
      LOG: "log"
    };
  }
});

// ext/kinds.js
var require_kinds = __commonJS({
  "ext/kinds.js"(exports2, module2) {
    "use strict";
    module2.exports = {
      SERVER: "server",
      CLIENT: "client",
      PRODUCER: "producer",
      CONSUMER: "consumer"
    };
  }
});

// ext/types.js
var require_types = __commonJS({
  "ext/types.js"(exports2, module2) {
    "use strict";
    module2.exports = {
      HTTP: "http",
      WEB: "web"
    };
  }
});

// ext/exporters.js
var require_exporters = __commonJS({
  "ext/exporters.js"(exports2, module2) {
    "use strict";
    module2.exports = {
      LOG: "log",
      AGENT: "agent",
      DATADOG: "datadog",
      AGENT_PROXY: "agent_proxy",
      JEST_WORKER: "jest_worker"
    };
  }
});

// ext/index.js
var require_ext = __commonJS({
  "ext/index.js"(exports2, module2) {
    "use strict";
    var formats = require_formats();
    var kinds = require_kinds();
    var priority = require_priority();
    var tags = require_tags();
    var types = require_types();
    var exporters = require_exporters();
    module2.exports = {
      formats,
      kinds,
      priority,
      tags,
      types,
      exporters
    };
  }
});

// packages/dd-trace/src/rate_limiter.js
var require_rate_limiter = __commonJS({
  "packages/dd-trace/src/rate_limiter.js"(exports2, module2) {
    "use strict";
    var limiter = require("limiter");
    var RateLimiter = class {
      constructor(rateLimit) {
        this._rateLimit = parseInt(rateLimit);
        this._limiter = new limiter.RateLimiter(this._rateLimit, "second");
        this._tokensRequested = 0;
        this._prevIntervalTokens = 0;
        this._prevTokensRequested = 0;
      }
      isAllowed() {
        const curIntervalStart = this._limiter.curIntervalStart;
        const curIntervalTokens = this._limiter.tokensThisInterval;
        const allowed = this._isAllowed();
        if (curIntervalStart !== this._limiter.curIntervalStart) {
          this._prevIntervalTokens = curIntervalTokens;
          this._prevTokensRequested = this._tokensRequested;
          this._tokensRequested = 1;
        } else {
          this._tokensRequested++;
        }
        return allowed;
      }
      effectiveRate() {
        if (this._rateLimit < 0)
          return 1;
        if (this._rateLimit === 0)
          return 0;
        if (this._tokensRequested === 0)
          return 1;
        const allowed = this._prevIntervalTokens + this._limiter.tokensThisInterval;
        const requested = this._prevTokensRequested + this._tokensRequested;
        return allowed / requested;
      }
      _isAllowed() {
        if (this._rateLimit < 0)
          return true;
        if (this._rateLimit === 0)
          return false;
        return this._limiter.tryRemoveTokens(1);
      }
      _currentWindowRate() {
        if (this._rateLimit < 0)
          return 1;
        if (this._rateLimit === 0)
          return 0;
        if (this._tokensRequested === 0)
          return 1;
        return this._limiter.tokensThisInterval / this._tokensRequested;
      }
    };
    module2.exports = RateLimiter;
  }
});

// packages/dd-trace/src/sampler.js
var require_sampler = __commonJS({
  "packages/dd-trace/src/sampler.js"(exports2, module2) {
    "use strict";
    var Sampler = class {
      constructor(rate) {
        this._rate = rate;
      }
      rate() {
        return this._rate;
      }
      isSampled() {
        return this._rate === 1 || Math.random() < this._rate;
      }
    };
    module2.exports = Sampler;
  }
});

// packages/dd-trace/src/span_sampler.js
var require_span_sampler = __commonJS({
  "packages/dd-trace/src/span_sampler.js"(exports2, module2) {
    "use strict";
    var { globMatch } = require_util();
    var { USER_KEEP, AUTO_KEEP } = require_ext().priority;
    var RateLimiter = require_rate_limiter();
    var Sampler = require_sampler();
    var SpanSamplingRule = class {
      constructor({ service, name, sampleRate = 1, maxPerSecond } = {}) {
        this.service = service;
        this.name = name;
        this._sampler = new Sampler(sampleRate);
        this._limiter = void 0;
        if (Number.isFinite(maxPerSecond)) {
          this._limiter = new RateLimiter(maxPerSecond);
        }
      }
      get sampleRate() {
        return this._sampler.rate();
      }
      get maxPerSecond() {
        return this._limiter && this._limiter._rateLimit;
      }
      static from(config) {
        return new SpanSamplingRule(config);
      }
      match(service, name) {
        if (this.service && !globMatch(this.service, service)) {
          return false;
        }
        if (this.name && !globMatch(this.name, name)) {
          return false;
        }
        return true;
      }
      sample() {
        if (!this._sampler.isSampled()) {
          return false;
        }
        if (this._limiter) {
          return this._limiter.isAllowed();
        }
        return true;
      }
    };
    var SpanSampler = class {
      constructor({ spanSamplingRules = [] } = {}) {
        this._rules = spanSamplingRules.map(SpanSamplingRule.from);
      }
      findRule(service, name) {
        for (const rule of this._rules) {
          if (rule.match(service, name)) {
            return rule;
          }
        }
      }
      sample(spanContext) {
        const decision = spanContext._sampling.priority;
        if (decision === USER_KEEP || decision === AUTO_KEEP)
          return;
        const { started } = spanContext._trace;
        for (const span of started) {
          const context = span.context();
          const tags = context._tags || {};
          const name = context._name;
          const service = tags.service || tags["service.name"] || span.tracer()._service;
          const rule = this.findRule(service, name);
          if (rule && rule.sample()) {
            span.context()._sampling.spanSampling = {
              sampleRate: rule.sampleRate,
              maxPerSecond: rule.maxPerSecond
            };
          }
        }
      }
    };
    module2.exports = SpanSampler;
  }
});

// packages/dd-trace/src/pkg.js
var require_pkg = __commonJS({
  "packages/dd-trace/src/pkg.js"(exports2, module2) {
    "use strict";
    var fs = require("fs");
    var path = require("path");
    function findRoot() {
      return require.main && require.main.filename ? path.dirname(require.main.filename) : process.cwd();
    }
    function findPkg() {
      const cwd = findRoot();
      const directory = path.resolve(cwd);
      const res = path.parse(directory);
      if (!res)
        return {};
      const { root } = res;
      const filePath = findUp("package.json", root, directory);
      try {
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
      } catch (e) {
        return {};
      }
    }
    function findUp(name, root, directory) {
      while (true) {
        const current = path.resolve(directory, name);
        if (fs.existsSync(current))
          return current;
        if (directory === root)
          return;
        directory = path.dirname(directory);
      }
    }
    module2.exports = Object.assign(findPkg(), { findRoot, findUp });
  }
});

// package.json
var require_package = __commonJS({
  "package.json"(exports2, module2) {
    module2.exports = {
      name: "dd-trace",
      version: "4.0.0-pre",
      description: "Datadog APM tracing client for JavaScript",
      main: "index.js",
      typings: "index.d.ts",
      scripts: {
        preinstall: "node scripts/preinstall.js",
        bundle: "node scripts/bundle",
        bench: "node benchmark",
        "bench:profiler": "node benchmark/profiler",
        "bench:e2e": "SERVICES=mongo yarn services && cd benchmark/e2e && node benchmark-run.js --duration=30",
        "bench:e2e:ci-visibility": "node benchmark/e2e-ci/benchmark-run.js",
        "type:doc": "cd docs && yarn && yarn build",
        "type:test": "cd docs && yarn && yarn test",
        lint: "node scripts/check_licenses.js && eslint . && yarn audit --groups dependencies",
        services: "node ./scripts/install_plugin_modules && node packages/dd-trace/test/setup/services",
        test: "SERVICES=* yarn services && mocha --colors --exit --expose-gc 'packages/dd-trace/test/setup/node.js' 'packages/*/test/**/*.spec.js'",
        "test:appsec": 'mocha --colors --exit -r "packages/dd-trace/test/setup/mocha.js" --exclude "packages/dd-trace/test/appsec/iast/**/*.plugin.spec.js" "packages/dd-trace/test/appsec/**/*.spec.js"',
        "test:appsec:ci": 'nyc --no-clean --include "packages/dd-trace/src/appsec/**/*.js" --exclude "packages/dd-trace/test/appsec/iast/**/*.plugin.spec.js" -- npm run test:appsec',
        "test:appsec:plugins": 'mocha --colors --exit -r "packages/dd-trace/test/setup/mocha.js" "packages/dd-trace/test/appsec/iast/**/*.@($(echo $PLUGINS)).plugin.spec.js"',
        "test:appsec:plugins:ci": 'yarn services && nyc --no-clean --include "packages/dd-trace/test/appsec/iast/**/*.@($(echo $PLUGINS)).plugin.spec.js" -- npm run test:appsec:plugins',
        "test:trace:core": 'tap packages/dd-trace/test/*.spec.js "packages/dd-trace/test/{ci-visibility,encode,exporters,opentracing,plugins,telemetry}/**/*.spec.js"',
        "test:trace:core:ci": 'npm run test:trace:core -- --coverage --nyc-arg=--include="packages/dd-trace/src/**/*.js"',
        "test:instrumentations": "mocha --colors -r 'packages/dd-trace/test/setup/mocha.js' 'packages/datadog-instrumentations/test/**/*.spec.js'",
        "test:instrumentations:ci": "nyc --no-clean --include 'packages/datadog-instrumentations/src/**/*.js' -- npm run test:instrumentations",
        "test:core": 'tap "packages/datadog-core/test/**/*.spec.js"',
        "test:core:ci": 'npm run test:core -- --coverage --nyc-arg=--include="packages/datadog-core/src/**/*.js"',
        "test:lambda": 'mocha --colors --exit -r "packages/dd-trace/test/setup/mocha.js" "packages/dd-trace/test/lambda/**/*.spec.js"',
        "test:lambda:ci": 'nyc --no-clean --include "packages/dd-trace/src/lambda/**/*.js" -- npm run test:lambda',
        "test:plugins": 'mocha --colors --exit -r "packages/dd-trace/test/setup/mocha.js" "packages/datadog-instrumentations/test/@($(echo $PLUGINS)).spec.js" "packages/datadog-plugin-@($(echo $PLUGINS))/test/**/*.spec.js"',
        "test:plugins:ci": 'yarn services && nyc --no-clean --include "packages/datadog-instrumentations/src/@($(echo $PLUGINS)).js" --include "packages/datadog-instrumentations/src/@($(echo $PLUGINS))/**/*.js" --include "packages/datadog-plugin-@($(echo $PLUGINS))/src/**/*.js" -- npm run test:plugins',
        "test:plugins:upstream": "node ./packages/dd-trace/test/plugins/suite.js",
        "test:profiler": 'tap "packages/dd-trace/test/profiling/**/*.spec.js"',
        "test:profiler:ci": 'npm run test:profiler -- --coverage --nyc-arg=--include="packages/dd-trace/src/profiling/**/*.js"',
        "test:integration": 'mocha --colors --timeout 30000 "integration-tests/*.spec.js"',
        "test:integration:cucumber": 'mocha --colors --timeout 30000 "integration-tests/cucumber/*.spec.js"',
        "test:integration:cypress": 'mocha --colors --timeout 30000 "integration-tests/cypress/*.spec.js"',
        "test:integration:playwright": 'mocha --colors --timeout 30000 "integration-tests/playwright/*.spec.js"',
        "test:shimmer": "mocha --colors 'packages/datadog-shimmer/test/**/*.spec.js'",
        "test:shimmer:ci": "nyc --no-clean --include 'packages/datadog-shimmer/src/**/*.js' -- npm run test:shimmer",
        "leak:core": "node ./scripts/install_plugin_modules && (cd packages/memwatch && yarn) && NODE_PATH=./packages/memwatch/node_modules node --no-warnings ./node_modules/.bin/tape 'packages/dd-trace/test/leak/**/*.js'",
        "leak:plugins": 'yarn services && (cd packages/memwatch && yarn) && NODE_PATH=./packages/memwatch/node_modules node --no-warnings ./node_modules/.bin/tape "packages/datadog-plugin-@($(echo $PLUGINS))/test/leak.js"'
      },
      repository: {
        type: "git",
        url: "git+https://github.com/DataDog/dd-trace-js.git"
      },
      keywords: [
        "datadog",
        "trace",
        "tracing",
        "profile",
        "profiler",
        "profiling",
        "opentracing",
        "apm"
      ],
      author: "Datadog Inc. <info@datadoghq.com>",
      license: "BSD-3-Clause",
      bugs: {
        url: "https://github.com/DataDog/dd-trace-js/issues"
      },
      homepage: "https://github.com/DataDog/dd-trace-js#readme",
      engines: {
        node: ">=14"
      },
      dependencies: {
        "@datadog/native-appsec": "2.0.0",
        "@datadog/native-iast-rewriter": "2.0.1",
        "@datadog/native-iast-taint-tracking": "^1.4.0",
        "@datadog/native-metrics": "^1.6.0",
        "@datadog/pprof": "^2.2.0",
        "@datadog/sketches-js": "^2.1.0",
        "crypto-randomuuid": "^1.0.0",
        diagnostics_channel: "^1.1.0",
        ignore: "^5.2.0",
        "import-in-the-middle": "^1.3.5",
        "ipaddr.js": "^2.0.1",
        "istanbul-lib-coverage": "3.2.0",
        koalas: "^1.0.2",
        limiter: "^1.1.4",
        "lodash.kebabcase": "^4.1.1",
        "lodash.pick": "^4.4.0",
        "lodash.sortby": "^4.7.0",
        "lodash.uniq": "^4.5.0",
        "lru-cache": "^7.14.0",
        methods: "^1.1.2",
        "module-details-from-path": "^1.0.3",
        "node-abort-controller": "^3.0.1",
        opentracing: ">=0.12.1",
        "path-to-regexp": "^0.1.2",
        protobufjs: "^7.1.2",
        retry: "^0.10.1",
        semver: "^7.3.8"
      },
      devDependencies: {
        "@types/node": ">=14",
        autocannon: "^4.5.2",
        axios: "^0.21.2",
        benchmark: "^2.1.4",
        "body-parser": "^1.18.2",
        chai: "^4.2.0",
        chalk: "^3.0.0",
        checksum: "^0.1.1",
        "cli-table3": "^0.5.1",
        dotenv: "8.2.0",
        esbuild: "^0.17.18",
        "esbuild-node-externals": "^1.7.0",
        eslint: "^8.23.0",
        "eslint-config-standard": "^11.0.0-beta.0",
        "eslint-plugin-import": "^2.8.0",
        "eslint-plugin-mocha": "^10.1.0",
        "eslint-plugin-n": "^15.7.0",
        "eslint-plugin-node": "^5.2.1",
        "eslint-plugin-promise": "^3.6.0",
        "eslint-plugin-standard": "^3.0.1",
        express: "^4.16.2",
        "get-port": "^3.2.0",
        glob: "^7.1.6",
        graphql: "0.13.2",
        "int64-buffer": "^0.1.9",
        jszip: "^3.5.0",
        mkdirp: "^0.5.1",
        mocha: "8",
        "msgpack-lite": "^0.1.26",
        multer: "^1.4.5-lts.1",
        nock: "^11.3.3",
        nyc: "^15.1.0",
        "pprof-format": "^2.0.7",
        proxyquire: "^1.8.0",
        rimraf: "^3.0.0",
        sinon: "^11.1.2",
        "sinon-chai": "^3.7.0",
        tap: "^16.3.4",
        tape: "^4.9.1"
      }
    };
  }
});

// packages/dd-trace/src/encode/tags-processors.js
var require_tags_processors = __commonJS({
  "packages/dd-trace/src/encode/tags-processors.js"(exports2, module2) {
    var MAX_RESOURCE_NAME_LENGTH = 5e3;
    var MAX_META_KEY_LENGTH = 200;
    var MAX_META_VALUE_LENGTH = 25e3;
    var MAX_METRIC_KEY_LENGTH = MAX_META_KEY_LENGTH;
    var DEFAULT_SPAN_NAME = "unnamed_operation";
    var DEFAULT_SERVICE_NAME = "unnamed-service";
    var MAX_NAME_LENGTH = 100;
    var MAX_SERVICE_LENGTH = 100;
    var MAX_TYPE_LENGTH = 100;
    function truncateSpan(span, shouldTruncateResourceName = true) {
      if (shouldTruncateResourceName && span.resource && span.resource.length > MAX_RESOURCE_NAME_LENGTH) {
        span.resource = `${span.resource.slice(0, MAX_RESOURCE_NAME_LENGTH)}...`;
      }
      for (let metaKey in span.meta) {
        const val = span.meta[metaKey];
        if (metaKey.length > MAX_META_KEY_LENGTH) {
          delete span.meta[metaKey];
          metaKey = `${metaKey.slice(0, MAX_META_KEY_LENGTH)}...`;
          span.metrics[metaKey] = val;
        }
        if (val && val.length > MAX_META_VALUE_LENGTH) {
          span.meta[metaKey] = `${val.slice(0, MAX_META_VALUE_LENGTH)}...`;
        }
      }
      for (let metricsKey in span.metrics) {
        const val = span.metrics[metricsKey];
        if (metricsKey.length > MAX_METRIC_KEY_LENGTH) {
          delete span.metrics[metricsKey];
          metricsKey = `${metricsKey.slice(0, MAX_METRIC_KEY_LENGTH)}...`;
          span.metrics[metricsKey] = val;
        }
      }
      return span;
    }
    function normalizeSpan(span) {
      span.service = span.service || DEFAULT_SERVICE_NAME;
      if (span.service.length > MAX_SERVICE_LENGTH) {
        span.service = span.service.slice(0, MAX_SERVICE_LENGTH);
      }
      span.name = span.name || DEFAULT_SPAN_NAME;
      if (span.name.length > MAX_NAME_LENGTH) {
        span.name = span.name.slice(0, MAX_NAME_LENGTH);
      }
      if (!span.resource) {
        span.resource = span.name;
      }
      if (span.type && span.type.length > MAX_TYPE_LENGTH) {
        span.type = span.type.slice(0, MAX_TYPE_LENGTH);
      }
      return span;
    }
    module2.exports = {
      truncateSpan,
      normalizeSpan,
      MAX_META_KEY_LENGTH,
      MAX_META_VALUE_LENGTH,
      MAX_METRIC_KEY_LENGTH,
      MAX_NAME_LENGTH,
      MAX_SERVICE_LENGTH,
      MAX_TYPE_LENGTH,
      MAX_RESOURCE_NAME_LENGTH,
      DEFAULT_SPAN_NAME,
      DEFAULT_SERVICE_NAME
    };
  }
});

// packages/dd-trace/src/encode/chunk.js
var require_chunk = __commonJS({
  "packages/dd-trace/src/encode/chunk.js"(exports2, module2) {
    "use strict";
    var DEFAULT_MIN_SIZE = 2 * 1024 * 1024;
    var Chunk = class {
      constructor(minSize = DEFAULT_MIN_SIZE) {
        this.buffer = Buffer.allocUnsafe(minSize);
        this.length = 0;
        this._minSize = minSize;
      }
      write(value) {
        const length = Buffer.byteLength(value);
        const offset = this.length;
        if (length < 32) {
          this.reserve(length + 1);
          this.length += 1;
          this.buffer[offset] = length | 160;
        } else if (length < 4294967296) {
          this.reserve(length + 5);
          this.length += 5;
          this.buffer[offset] = 219;
          this.buffer[offset + 1] = length >> 24;
          this.buffer[offset + 2] = length >> 16;
          this.buffer[offset + 3] = length >> 8;
          this.buffer[offset + 4] = length;
        }
        this.length += this.buffer.utf8Write(value, this.length, length);
        return this.length - offset;
      }
      copy(target, sourceStart, sourceEnd) {
        target.set(new Uint8Array(this.buffer.buffer, sourceStart, sourceEnd - sourceStart));
      }
      set(array) {
        this.reserve(array.length);
        this.buffer.set(array, this.length);
        this.length += array.length;
      }
      reserve(size) {
        if (this.length + size > this.buffer.length) {
          this._resize(this._minSize * Math.ceil((this.length + size) / this._minSize));
        }
      }
      _resize(size) {
        const oldBuffer = this.buffer;
        this.buffer = Buffer.allocUnsafe(size);
        oldBuffer.copy(this.buffer, 0, 0, this.length);
      }
    };
    module2.exports = Chunk;
  }
});

// packages/dd-trace/src/encode/0.4.js
var require__ = __commonJS({
  "packages/dd-trace/src/encode/0.4.js"(exports2, module2) {
    "use strict";
    var { truncateSpan, normalizeSpan } = require_tags_processors();
    var Chunk = require_chunk();
    var log = require_log();
    var { isTrue } = require_util();
    var coalesce = require("koalas");
    var SOFT_LIMIT = 8 * 1024 * 1024;
    var float64Array = new Float64Array(1);
    var uInt8Float64Array = new Uint8Array(float64Array.buffer);
    float64Array[0] = -1;
    var bigEndian = uInt8Float64Array[7] === 0;
    function formatSpan(span) {
      return normalizeSpan(truncateSpan(span, false));
    }
    var AgentEncoder = class {
      constructor(writer, limit = SOFT_LIMIT) {
        this._limit = limit;
        this._traceBytes = new Chunk();
        this._stringBytes = new Chunk();
        this._writer = writer;
        this._reset();
        this._debugEncoding = isTrue(coalesce(
          process.env.DD_TRACE_ENCODING_DEBUG,
          false
        ));
      }
      count() {
        return this._traceCount;
      }
      encode(trace) {
        const bytes = this._traceBytes;
        const start = bytes.length;
        this._traceCount++;
        this._encode(bytes, trace);
        const end = bytes.length;
        if (this._debugEncoding) {
          log.debug(() => {
            const hex = bytes.buffer.subarray(start, end).toString("hex").match(/../g).join(" ");
            return `Adding encoded trace to buffer: ${hex}`;
          });
        }
        if (this._traceBytes.length > this._limit || this._stringBytes.length > this._limit) {
          log.debug("Buffer went over soft limit, flushing");
          this._writer.flush();
        }
      }
      makePayload() {
        const traceSize = this._traceBytes.length + 5;
        const buffer = Buffer.allocUnsafe(traceSize);
        this._writeTraces(buffer);
        this._reset();
        return buffer;
      }
      reset() {
        this._reset();
      }
      _encode(bytes, trace) {
        this._encodeArrayPrefix(bytes, trace);
        for (let span of trace) {
          span = formatSpan(span);
          bytes.reserve(1);
          if (span.type) {
            bytes.buffer[bytes.length++] = 140;
            this._encodeString(bytes, "type");
            this._encodeString(bytes, span.type);
          } else {
            bytes.buffer[bytes.length++] = 139;
          }
          this._encodeString(bytes, "trace_id");
          this._encodeId(bytes, span.trace_id);
          this._encodeString(bytes, "span_id");
          this._encodeId(bytes, span.span_id);
          this._encodeString(bytes, "parent_id");
          this._encodeId(bytes, span.parent_id);
          this._encodeString(bytes, "name");
          this._encodeString(bytes, span.name);
          this._encodeString(bytes, "resource");
          this._encodeString(bytes, span.resource);
          this._encodeString(bytes, "service");
          this._encodeString(bytes, span.service);
          this._encodeString(bytes, "error");
          this._encodeInteger(bytes, span.error);
          this._encodeString(bytes, "start");
          this._encodeLong(bytes, span.start);
          this._encodeString(bytes, "duration");
          this._encodeLong(bytes, span.duration);
          this._encodeString(bytes, "meta");
          this._encodeMap(bytes, span.meta);
          this._encodeString(bytes, "metrics");
          this._encodeMap(bytes, span.metrics);
        }
      }
      _reset() {
        this._traceCount = 0;
        this._traceBytes.length = 0;
        this._stringCount = 0;
        this._stringBytes.length = 0;
        this._stringMap = {};
        this._cacheString("");
      }
      _encodeArrayPrefix(bytes, value) {
        const length = value.length;
        const offset = bytes.length;
        bytes.reserve(5);
        bytes.length += 5;
        bytes.buffer[offset] = 221;
        bytes.buffer[offset + 1] = length >> 24;
        bytes.buffer[offset + 2] = length >> 16;
        bytes.buffer[offset + 3] = length >> 8;
        bytes.buffer[offset + 4] = length;
      }
      _encodeMapPrefix(bytes, keysLength) {
        const offset = bytes.length;
        bytes.reserve(5);
        bytes.length += 5;
        bytes.buffer[offset] = 223;
        bytes.buffer[offset + 1] = keysLength >> 24;
        bytes.buffer[offset + 2] = keysLength >> 16;
        bytes.buffer[offset + 3] = keysLength >> 8;
        bytes.buffer[offset + 4] = keysLength;
      }
      _encodeByte(bytes, value) {
        bytes.reserve(1);
        bytes.buffer[bytes.length++] = value;
      }
      _encodeId(bytes, id) {
        const offset = bytes.length;
        bytes.reserve(9);
        bytes.length += 9;
        id = id.toArray();
        bytes.buffer[offset] = 207;
        bytes.buffer[offset + 1] = id[0];
        bytes.buffer[offset + 2] = id[1];
        bytes.buffer[offset + 3] = id[2];
        bytes.buffer[offset + 4] = id[3];
        bytes.buffer[offset + 5] = id[4];
        bytes.buffer[offset + 6] = id[5];
        bytes.buffer[offset + 7] = id[6];
        bytes.buffer[offset + 8] = id[7];
      }
      _encodeInteger(bytes, value) {
        const offset = bytes.length;
        bytes.reserve(5);
        bytes.length += 5;
        bytes.buffer[offset] = 206;
        bytes.buffer[offset + 1] = value >> 24;
        bytes.buffer[offset + 2] = value >> 16;
        bytes.buffer[offset + 3] = value >> 8;
        bytes.buffer[offset + 4] = value;
      }
      _encodeLong(bytes, value) {
        const offset = bytes.length;
        const hi = value / Math.pow(2, 32) >> 0;
        const lo = value >>> 0;
        bytes.reserve(9);
        bytes.length += 9;
        bytes.buffer[offset] = 207;
        bytes.buffer[offset + 1] = hi >> 24;
        bytes.buffer[offset + 2] = hi >> 16;
        bytes.buffer[offset + 3] = hi >> 8;
        bytes.buffer[offset + 4] = hi;
        bytes.buffer[offset + 5] = lo >> 24;
        bytes.buffer[offset + 6] = lo >> 16;
        bytes.buffer[offset + 7] = lo >> 8;
        bytes.buffer[offset + 8] = lo;
      }
      _encodeMap(bytes, value) {
        const keys = Object.keys(value);
        const validKeys = keys.filter((key) => typeof value[key] === "string" || typeof value[key] === "number");
        this._encodeMapPrefix(bytes, validKeys.length);
        for (const key of validKeys) {
          this._encodeString(bytes, key);
          this._encodeValue(bytes, value[key]);
        }
      }
      _encodeValue(bytes, value) {
        switch (typeof value) {
          case "string":
            this._encodeString(bytes, value);
            break;
          case "number":
            this._encodeFloat(bytes, value);
            break;
          default:
        }
      }
      _encodeString(bytes, value = "") {
        this._cacheString(value);
        const { start, end } = this._stringMap[value];
        this._stringBytes.copy(bytes, start, end);
      }
      _encodeFloat(bytes, value) {
        float64Array[0] = value;
        const offset = bytes.length;
        bytes.reserve(9);
        bytes.length += 9;
        bytes.buffer[offset] = 203;
        if (bigEndian) {
          for (let i = 0; i <= 7; i++) {
            bytes.buffer[offset + i + 1] = uInt8Float64Array[i];
          }
        } else {
          for (let i = 7; i >= 0; i--) {
            bytes.buffer[bytes.length - i - 1] = uInt8Float64Array[i];
          }
        }
      }
      _cacheString(value) {
        if (!(value in this._stringMap)) {
          this._stringCount++;
          this._stringMap[value] = {
            start: this._stringBytes.length,
            end: this._stringBytes.length + this._stringBytes.write(value)
          };
        }
      }
      _writeArrayPrefix(buffer, offset, count) {
        buffer[offset++] = 221;
        buffer.writeUInt32BE(count, offset);
        return offset + 4;
      }
      _writeTraces(buffer, offset = 0) {
        offset = this._writeArrayPrefix(buffer, offset, this._traceCount);
        offset += this._traceBytes.buffer.copy(buffer, offset, 0, this._traceBytes.length);
        return offset;
      }
    };
    module2.exports = { AgentEncoder };
  }
});

// packages/dd-trace/src/encode/span-stats.js
var require_span_stats = __commonJS({
  "packages/dd-trace/src/encode/span-stats.js"(exports2, module2) {
    "use strict";
    var { AgentEncoder } = require__();
    var {
      MAX_NAME_LENGTH,
      MAX_SERVICE_LENGTH,
      MAX_RESOURCE_NAME_LENGTH,
      MAX_TYPE_LENGTH,
      DEFAULT_SPAN_NAME,
      DEFAULT_SERVICE_NAME
    } = require_tags_processors();
    function truncate(value, maxLength, suffix = "") {
      if (!value) {
        return value;
      }
      if (value.length > maxLength) {
        return `${value.slice(0, maxLength)}${suffix}`;
      }
      return value;
    }
    var SpanStatsEncoder = class extends AgentEncoder {
      _encodeBool(bytes, value) {
        this._encodeByte(bytes, value ? 195 : 194);
      }
      makePayload() {
        const traceSize = this._traceBytes.length;
        const buffer = Buffer.allocUnsafe(traceSize);
        this._traceBytes.copy(buffer, 0, traceSize);
        this._reset();
        return buffer;
      }
      _encodeMapPrefix(bytes, length) {
        const offset = bytes.length;
        bytes.reserve(1);
        bytes.length += 1;
        bytes.buffer[offset] = 128 + length;
      }
      _encodeBuffer(bytes, buffer) {
        const length = buffer.length;
        const offset = bytes.length;
        bytes.reserve(5);
        bytes.length += 5;
        bytes.buffer[offset] = 198;
        bytes.buffer[offset + 1] = length >> 24;
        bytes.buffer[offset + 2] = length >> 16;
        bytes.buffer[offset + 3] = length >> 8;
        bytes.buffer[offset + 4] = length;
        buffer.copy(bytes.buffer, offset + 5);
        bytes.length += length;
      }
      _encodeStat(bytes, stat) {
        this._encodeMapPrefix(bytes, 12);
        this._encodeString(bytes, "Service");
        const service = stat.Service || DEFAULT_SERVICE_NAME;
        this._encodeString(bytes, truncate(service, MAX_SERVICE_LENGTH));
        this._encodeString(bytes, "Name");
        const name = stat.Name || DEFAULT_SPAN_NAME;
        this._encodeString(bytes, truncate(name, MAX_NAME_LENGTH));
        this._encodeString(bytes, "Resource");
        this._encodeString(bytes, truncate(stat.Resource, MAX_RESOURCE_NAME_LENGTH, "..."));
        this._encodeString(bytes, "HTTPStatusCode");
        this._encodeInteger(bytes, stat.HTTPStatusCode);
        this._encodeString(bytes, "Type");
        this._encodeString(bytes, truncate(stat.Type, MAX_TYPE_LENGTH));
        this._encodeString(bytes, "Hits");
        this._encodeLong(bytes, stat.Hits);
        this._encodeString(bytes, "Errors");
        this._encodeLong(bytes, stat.Errors);
        this._encodeString(bytes, "Duration");
        this._encodeLong(bytes, stat.Duration);
        this._encodeString(bytes, "OkSummary");
        this._encodeBuffer(bytes, stat.OkSummary);
        this._encodeString(bytes, "ErrorSummary");
        this._encodeBuffer(bytes, stat.ErrorSummary);
        this._encodeString(bytes, "Synthetics");
        this._encodeBool(bytes, stat.Synthetics);
        this._encodeString(bytes, "TopLevelHits");
        this._encodeLong(bytes, stat.TopLevelHits);
      }
      _encodeBucket(bytes, bucket) {
        this._encodeMapPrefix(bytes, 3);
        this._encodeString(bytes, "Start");
        this._encodeLong(bytes, bucket.Start);
        this._encodeString(bytes, "Duration");
        this._encodeLong(bytes, bucket.Duration);
        this._encodeString(bytes, "Stats");
        this._encodeArrayPrefix(bytes, bucket.Stats);
        for (const stat of bucket.Stats) {
          this._encodeStat(bytes, stat);
        }
      }
      _encode(bytes, stats) {
        this._encodeMapPrefix(bytes, 8);
        this._encodeString(bytes, "Hostname");
        this._encodeString(bytes, stats.Hostname);
        this._encodeString(bytes, "Env");
        this._encodeString(bytes, stats.Env);
        this._encodeString(bytes, "Version");
        this._encodeString(bytes, stats.Version);
        this._encodeString(bytes, "Stats");
        this._encodeArrayPrefix(bytes, stats.Stats);
        for (const bucket of stats.Stats) {
          this._encodeBucket(bytes, bucket);
        }
        this._encodeString(bytes, "Lang");
        this._encodeString(bytes, stats.Lang);
        this._encodeString(bytes, "TracerVersion");
        this._encodeString(bytes, stats.TracerVersion);
        this._encodeString(bytes, "RuntimeID");
        this._encodeString(bytes, stats.RuntimeID);
        this._encodeString(bytes, "Sequence");
        this._encodeLong(bytes, stats.Sequence);
      }
    };
    module2.exports = {
      SpanStatsEncoder
    };
  }
});

// packages/dd-trace/src/exporters/common/writer.js
var require_writer2 = __commonJS({
  "packages/dd-trace/src/exporters/common/writer.js"(exports2, module2) {
    "use strict";
    var request = require_request();
    var log = require_log();
    var Writer = class {
      constructor({ url }) {
        this._url = url;
      }
      flush(done = () => {
      }) {
        const count = this._encoder.count();
        if (!request.writable) {
          this._encoder.reset();
          done();
        } else if (count > 0) {
          const payload = this._encoder.makePayload();
          this._sendPayload(payload, count, done);
        } else {
          done();
        }
      }
      append(payload) {
        if (!request.writable) {
          log.debug(() => `Maximum number of active requests reached. Payload discarded: ${JSON.stringify(payload)}`);
          return;
        }
        log.debug(() => `Encoding payload: ${JSON.stringify(payload)}`);
        this._encode(payload);
      }
      _encode(payload) {
        this._encoder.encode(payload);
      }
      setUrl(url) {
        this._url = url;
      }
    };
    module2.exports = Writer;
  }
});

// packages/dd-trace/src/exporters/span-stats/writer.js
var require_writer3 = __commonJS({
  "packages/dd-trace/src/exporters/span-stats/writer.js"(exports2, module2) {
    var { SpanStatsEncoder } = require_span_stats();
    var pkg = require_package();
    var BaseWriter = require_writer2();
    var request = require_request();
    var log = require_log();
    var Writer = class extends BaseWriter {
      constructor({ url }) {
        super(...arguments);
        this._url = url;
        this._encoder = new SpanStatsEncoder(this);
      }
      _sendPayload(data, _, done) {
        makeRequest(data, this._url, (err, res) => {
          if (err) {
            log.error(err);
            done();
            return;
          }
          log.debug(`Response from the intake: ${res}`);
          done();
        });
      }
    };
    function makeRequest(data, url, cb) {
      const options = {
        path: "/v0.6/stats",
        method: "PUT",
        headers: {
          "Datadog-Meta-Lang": "javascript",
          "Datadog-Meta-Tracer-Version": pkg.version,
          "Content-Type": "application/msgpack"
        }
      };
      options.protocol = url.protocol;
      options.hostname = url.hostname;
      options.port = url.port;
      log.debug(() => `Request to the intake: ${JSON.stringify(options)}`);
      request(data, options, (err, res) => {
        cb(err, res);
      });
    }
    module2.exports = {
      Writer
    };
  }
});

// packages/dd-trace/src/exporters/span-stats/index.js
var require_span_stats2 = __commonJS({
  "packages/dd-trace/src/exporters/span-stats/index.js"(exports2, module2) {
    var { URL: URL2, format } = require("url");
    var { Writer } = require_writer3();
    var SpanStatsExporter = class {
      constructor(config) {
        const { hostname = "127.0.0.1", port = 8126, tags, url } = config;
        this._url = url || new URL2(format({
          protocol: "http:",
          hostname: hostname || "localhost",
          port
        }));
        this._writer = new Writer({ url: this._url, tags });
      }
      export(payload) {
        this._writer.append(payload);
        this._writer.flush();
      }
    };
    module2.exports = {
      SpanStatsExporter
    };
  }
});

// packages/dd-trace/src/span_stats.js
var require_span_stats3 = __commonJS({
  "packages/dd-trace/src/span_stats.js"(exports2, module2) {
    var os = require("os");
    var { version } = require_pkg();
    var pkg = require_package();
    var { LogCollapsingLowestDenseDDSketch } = require("@datadog/sketches-js");
    var { ORIGIN_KEY, TOP_LEVEL_KEY } = require_constants();
    var {
      MEASURED,
      HTTP_STATUS_CODE
    } = require_tags();
    var { SpanStatsExporter } = require_span_stats2();
    var {
      DEFAULT_SPAN_NAME,
      DEFAULT_SERVICE_NAME
    } = require_tags_processors();
    var SpanAggStats = class {
      constructor(aggKey) {
        this.aggKey = aggKey;
        this.hits = 0;
        this.topLevelHits = 0;
        this.errors = 0;
        this.duration = 0;
        this.okDistribution = new LogCollapsingLowestDenseDDSketch(775e-5);
        this.errorDistribution = new LogCollapsingLowestDenseDDSketch(775e-5);
      }
      record(span) {
        const durationNs = span.duration;
        this.hits++;
        this.duration += durationNs;
        if (span.metrics[TOP_LEVEL_KEY]) {
          this.topLevelHits++;
        }
        if (span.error) {
          this.errors++;
          this.errorDistribution.accept(durationNs);
        } else {
          this.okDistribution.accept(durationNs);
        }
      }
      toJSON() {
        const {
          name,
          service,
          resource,
          type,
          statusCode,
          synthetics
        } = this.aggKey;
        return {
          Name: name,
          Service: service,
          Resource: resource,
          Type: type,
          HTTPStatusCode: statusCode,
          Synthetics: synthetics,
          Hits: this.hits,
          TopLevelHits: this.topLevelHits,
          Errors: this.errors,
          Duration: this.duration,
          OkSummary: this.okDistribution.toProto(),
          // TODO: custom proto encoding
          ErrorSummary: this.errorDistribution.toProto()
          // TODO: custom proto encoding
        };
      }
    };
    var SpanAggKey = class {
      constructor(span) {
        this.name = span.name || DEFAULT_SPAN_NAME;
        this.service = span.service || DEFAULT_SERVICE_NAME;
        this.resource = span.resource || "";
        this.type = span.type || "";
        this.statusCode = span.meta[HTTP_STATUS_CODE] || 0;
        this.synthetics = span.meta[ORIGIN_KEY] === "synthetics";
      }
      toString() {
        return [
          this.name,
          this.service,
          this.resource,
          this.type,
          this.statusCode,
          this.synthetics
        ].join(",");
      }
    };
    var SpanBuckets = class extends Map {
      forSpan(span) {
        const aggKey = new SpanAggKey(span);
        const key = aggKey.toString();
        if (!this.has(key)) {
          this.set(key, new SpanAggStats(aggKey));
        }
        return this.get(key);
      }
    };
    var TimeBuckets = class extends Map {
      forTime(time) {
        if (!this.has(time)) {
          this.set(time, new SpanBuckets());
        }
        return this.get(time);
      }
    };
    var SpanStatsProcessor = class {
      constructor({
        stats: {
          enabled = false,
          interval = 10
        },
        hostname,
        port,
        url,
        env,
        tags
      } = {}) {
        this.exporter = new SpanStatsExporter({
          hostname,
          port,
          tags,
          url
        });
        this.interval = interval;
        this.bucketSizeNs = interval * 1e9;
        this.buckets = new TimeBuckets();
        this.hostname = os.hostname();
        this.enabled = enabled;
        this.env = env;
        this.tags = tags || {};
        this.sequence = 0;
        if (enabled) {
          this.timer = setInterval(this.onInterval.bind(this), interval * 1e3);
          this.timer.unref();
        }
      }
      onInterval() {
        const serialized = this._serializeBuckets();
        if (!serialized)
          return;
        this.exporter.export({
          Hostname: this.hostname,
          Env: this.env,
          Version: version,
          Stats: serialized,
          Lang: "javascript",
          TracerVersion: pkg.version,
          RuntimeID: this.tags["runtime-id"],
          Sequence: ++this.sequence
        });
      }
      onSpanFinished(span) {
        if (!this.enabled)
          return;
        if (!span.metrics[TOP_LEVEL_KEY] && !span.metrics[MEASURED])
          return;
        const spanEndNs = span.startTime + span.duration;
        const bucketTime = spanEndNs - spanEndNs % this.bucketSizeNs;
        this.buckets.forTime(bucketTime).forSpan(span).record(span);
      }
      _serializeBuckets() {
        const { bucketSizeNs } = this;
        const serializedBuckets = [];
        for (const [timeNs, bucket] of this.buckets.entries()) {
          const bucketAggStats = [];
          for (const stats of bucket.values()) {
            bucketAggStats.push(stats.toJSON());
          }
          serializedBuckets.push({
            Start: timeNs,
            Duration: bucketSizeNs,
            Stats: bucketAggStats
          });
        }
        this.buckets.clear();
        return serializedBuckets;
      }
    };
    module2.exports = {
      SpanAggStats,
      SpanAggKey,
      SpanBuckets,
      TimeBuckets,
      SpanStatsProcessor
    };
  }
});

// packages/dd-trace/src/span_processor.js
var require_span_processor = __commonJS({
  "packages/dd-trace/src/span_processor.js"(exports2, module2) {
    "use strict";
    var log = require_log();
    var format = require_format();
    var SpanSampler = require_span_sampler();
    var { SpanStatsProcessor } = require_span_stats3();
    var startedSpans = /* @__PURE__ */ new WeakSet();
    var finishedSpans = /* @__PURE__ */ new WeakSet();
    var SpanProcessor = class {
      constructor(exporter, prioritySampler, config) {
        this._exporter = exporter;
        this._prioritySampler = prioritySampler;
        this._config = config;
        this._killAll = false;
        this._stats = new SpanStatsProcessor(config);
        this._spanSampler = new SpanSampler(config.sampler);
      }
      process(span) {
        const spanContext = span.context();
        const active = [];
        const formatted = [];
        const trace = spanContext._trace;
        const { flushMinSpans } = this._config;
        const { started, finished } = trace;
        if (trace.record === false)
          return;
        if (started.length === finished.length || finished.length >= flushMinSpans) {
          this._prioritySampler.sample(spanContext);
          this._spanSampler.sample(spanContext);
          for (const span2 of started) {
            if (span2._duration !== void 0) {
              const formattedSpan = format(span2);
              this._stats.onSpanFinished(formattedSpan);
              formatted.push(formattedSpan);
            } else {
              active.push(span2);
            }
          }
          if (formatted.length !== 0 && trace.isRecording !== false) {
            this._exporter.export(formatted);
          }
          this._erase(trace, active);
        }
        if (this._killAll) {
          started.map((startedSpan) => {
            if (!startedSpan._finished) {
              startedSpan.finish();
            }
          });
        }
      }
      killAll() {
        this._killAll = true;
      }
      _erase(trace, active) {
        if (process.env.DD_TRACE_EXPERIMENTAL_STATE_TRACKING === "true") {
          const started = /* @__PURE__ */ new Set();
          const startedIds = /* @__PURE__ */ new Set();
          const finished = /* @__PURE__ */ new Set();
          const finishedIds = /* @__PURE__ */ new Set();
          for (const span of trace.finished) {
            const context = span.context();
            const id = context.toSpanId();
            if (finished.has(span)) {
              log.error(`Span was already finished in the same trace: ${span}`);
            } else {
              finished.add(span);
              if (finishedIds.has(id)) {
                log.error(`Another span with the same ID was already finished in the same trace: ${span}`);
              } else {
                finishedIds.add(id);
              }
              if (context._trace !== trace) {
                log.error(`A span was finished in the wrong trace: ${span}.`);
              }
              if (finishedSpans.has(span)) {
                log.error(`Span was already finished in a different trace: ${span}`);
              } else {
                finishedSpans.add(span);
              }
            }
          }
          for (const span of trace.started) {
            const context = span.context();
            const id = context.toSpanId();
            if (started.has(span)) {
              log.error(`Span was already started in the same trace: ${span}`);
            } else {
              started.add(span);
              if (startedIds.has(id)) {
                log.error(`Another span with the same ID was already started in the same trace: ${span}`);
              } else {
                startedIds.add(id);
              }
              if (context._trace !== trace) {
                log.error(`A span was started in the wrong trace: ${span}.`);
              }
              if (startedSpans.has(span)) {
                log.error(`Span was already started in a different trace: ${span}`);
              } else {
                startedSpans.add(span);
              }
            }
            if (!finished.has(span)) {
              log.error(`Span started in one trace but was finished in another trace: ${span}`);
            }
          }
          for (const span of trace.finished) {
            if (!started.has(span)) {
              log.error(`Span finished in one trace but was started in another trace: ${span}`);
            }
          }
        }
        for (const span of trace.finished) {
          span.context()._tags = {};
        }
        trace.started = active;
        trace.finished = [];
      }
    };
    module2.exports = SpanProcessor;
  }
});

// packages/dd-trace/src/startup-log.js
var require_startup_log = __commonJS({
  "packages/dd-trace/src/startup-log.js"(exports2, module2) {
    "use strict";
    var { info, warn } = require_writer();
    var os = require("os");
    var { inspect } = require("util");
    var tracerVersion = require_package().version;
    var config;
    var pluginManager;
    var samplingRules = [];
    var alreadyRan = false;
    function getIntegrationsAndAnalytics() {
      const integrations = /* @__PURE__ */ new Set();
      const extras = {};
      for (const pluginName in pluginManager._pluginsByName) {
        integrations.add(pluginName);
      }
      extras.integrations_loaded = Array.from(integrations);
      return extras;
    }
    function startupLog({ agentError } = {}) {
      if (!config || !pluginManager) {
        return;
      }
      if (alreadyRan) {
        return;
      }
      alreadyRan = true;
      if (!config.startupLogs) {
        return;
      }
      const url = config.url || `http://${config.hostname || "localhost"}:${config.port}`;
      const out = {
        [inspect.custom]() {
          return String(this);
        },
        toString() {
          return JSON.stringify(this);
        }
      };
      out.date = (/* @__PURE__ */ new Date()).toISOString();
      out.os_name = os.type();
      out.os_version = os.release();
      out.architecture = os.arch();
      out.version = tracerVersion;
      out.lang = "nodejs";
      out.lang_version = process.versions.node;
      out.env = config.env;
      out.enabled = config.enabled;
      out.service = config.service;
      out.agent_url = url;
      if (agentError) {
        out.agent_error = agentError.message;
      }
      out.debug = !!config.debug;
      out.sample_rate = config.sampleRate;
      out.sampling_rules = samplingRules;
      out.tags = config.tags;
      if (config.tags && config.tags.version) {
        out.dd_version = config.tags.version;
      }
      out.log_injection_enabled = !!config.logInjection;
      out.runtime_metrics_enabled = !!config.runtimeMetrics;
      out.profiling_enabled = !!(config.profiling || {}).enabled;
      Object.assign(out, getIntegrationsAndAnalytics());
      out.appsec_enabled = !!config.appsec.enabled;
      info("DATADOG TRACER CONFIGURATION - " + out);
      if (agentError) {
        warn("DATADOG TRACER DIAGNOSTIC - Agent Error: " + agentError.message);
      }
      config = void 0;
      pluginManager = void 0;
      samplingRules = void 0;
    }
    function setStartupLogConfig(aConfig) {
      config = aConfig;
    }
    function setStartupLogPluginManager(thePluginManager) {
      pluginManager = thePluginManager;
    }
    function setSamplingRules(theRules) {
      samplingRules = theRules;
    }
    module2.exports = {
      startupLog,
      setStartupLogConfig,
      setStartupLogPluginManager,
      setSamplingRules
    };
  }
});

// packages/dd-trace/src/priority_sampler.js
var require_priority_sampler = __commonJS({
  "packages/dd-trace/src/priority_sampler.js"(exports2, module2) {
    "use strict";
    var RateLimiter = require_rate_limiter();
    var Sampler = require_sampler();
    var ext = require_ext();
    var { setSamplingRules } = require_startup_log();
    var {
      SAMPLING_MECHANISM_DEFAULT,
      SAMPLING_MECHANISM_AGENT,
      SAMPLING_MECHANISM_RULE,
      SAMPLING_MECHANISM_MANUAL,
      SAMPLING_RULE_DECISION,
      SAMPLING_LIMIT_DECISION,
      SAMPLING_AGENT_DECISION,
      DECISION_MAKER_KEY
    } = require_constants();
    var SERVICE_NAME = ext.tags.SERVICE_NAME;
    var SAMPLING_PRIORITY = ext.tags.SAMPLING_PRIORITY;
    var MANUAL_KEEP = ext.tags.MANUAL_KEEP;
    var MANUAL_DROP = ext.tags.MANUAL_DROP;
    var USER_REJECT = ext.priority.USER_REJECT;
    var AUTO_REJECT = ext.priority.AUTO_REJECT;
    var AUTO_KEEP = ext.priority.AUTO_KEEP;
    var USER_KEEP = ext.priority.USER_KEEP;
    var DEFAULT_KEY = "service:,env:";
    var defaultSampler = new Sampler(AUTO_KEEP);
    var PrioritySampler = class {
      constructor(env, { sampleRate, rateLimit = 100, rules = [] } = {}) {
        this._env = env;
        this._rules = this._normalizeRules(rules, sampleRate);
        this._limiter = new RateLimiter(rateLimit);
        setSamplingRules(this._rules);
        this.update({});
      }
      isSampled(span) {
        const priority = this._getPriorityFromAuto(span);
        return priority === USER_KEEP || priority === AUTO_KEEP;
      }
      sample(span, auto = true) {
        if (!span)
          return;
        const context = this._getContext(span);
        const root = context._trace.started[0];
        if (context._sampling.priority !== void 0)
          return;
        if (!root)
          return;
        const tag = this._getPriorityFromTags(context._tags);
        if (this.validate(tag)) {
          context._sampling.priority = tag;
          context._sampling.mechanism = SAMPLING_MECHANISM_MANUAL;
        } else if (auto) {
          context._sampling.priority = this._getPriorityFromAuto(root);
        } else {
          return;
        }
        this._addDecisionMaker(root);
      }
      update(rates) {
        const samplers = {};
        for (const key in rates) {
          const rate = rates[key];
          const sampler = new Sampler(rate);
          samplers[key] = sampler;
        }
        samplers[DEFAULT_KEY] = samplers[DEFAULT_KEY] || defaultSampler;
        this._samplers = samplers;
      }
      validate(samplingPriority) {
        switch (samplingPriority) {
          case USER_REJECT:
          case USER_KEEP:
          case AUTO_REJECT:
          case AUTO_KEEP:
            return true;
          default:
            return false;
        }
      }
      _getContext(span) {
        return typeof span.context === "function" ? span.context() : span;
      }
      _getPriorityFromAuto(span) {
        const context = this._getContext(span);
        const rule = this._findRule(context);
        return rule ? this._getPriorityByRule(context, rule) : this._getPriorityByAgent(context);
      }
      _getPriorityFromTags(tags) {
        if (hasOwn(tags, MANUAL_KEEP) && tags[MANUAL_KEEP] !== false) {
          return USER_KEEP;
        } else if (hasOwn(tags, MANUAL_DROP) && tags[MANUAL_DROP] !== false) {
          return USER_REJECT;
        } else {
          const priority = parseInt(tags[SAMPLING_PRIORITY], 10);
          if (priority === 1 || priority === 2) {
            return USER_KEEP;
          } else if (priority === 0 || priority === -1) {
            return USER_REJECT;
          }
        }
      }
      _getPriorityByRule(context, rule) {
        context._trace[SAMPLING_RULE_DECISION] = rule.sampleRate;
        context._sampling.mechanism = SAMPLING_MECHANISM_RULE;
        return rule.sampler.isSampled(context) && this._isSampledByRateLimit(context) ? USER_KEEP : USER_REJECT;
      }
      _isSampledByRateLimit(context) {
        const allowed = this._limiter.isAllowed();
        context._trace[SAMPLING_LIMIT_DECISION] = this._limiter.effectiveRate();
        return allowed;
      }
      _getPriorityByAgent(context) {
        const key = `service:${context._tags[SERVICE_NAME]},env:${this._env}`;
        const sampler = this._samplers[key] || this._samplers[DEFAULT_KEY];
        context._trace[SAMPLING_AGENT_DECISION] = sampler.rate();
        if (sampler === defaultSampler) {
          context._sampling.mechanism = SAMPLING_MECHANISM_DEFAULT;
        } else {
          context._sampling.mechanism = SAMPLING_MECHANISM_AGENT;
        }
        return sampler.isSampled(context) ? AUTO_KEEP : AUTO_REJECT;
      }
      _addDecisionMaker(span) {
        const context = span.context();
        const trace = context._trace;
        const priority = context._sampling.priority;
        const mechanism = context._sampling.mechanism;
        if (priority >= AUTO_KEEP) {
          if (!trace.tags[DECISION_MAKER_KEY]) {
            trace.tags[DECISION_MAKER_KEY] = `-${mechanism}`;
          }
        } else {
          delete trace.tags[DECISION_MAKER_KEY];
        }
      }
      _normalizeRules(rules, sampleRate) {
        rules = [].concat(rules || []);
        return rules.concat({ sampleRate }).map((rule) => ({ ...rule, sampleRate: parseFloat(rule.sampleRate) })).filter((rule) => !isNaN(rule.sampleRate)).map((rule) => ({ ...rule, sampler: new Sampler(rule.sampleRate) }));
      }
      _findRule(context) {
        for (let i = 0, l = this._rules.length; i < l; i++) {
          if (this._matchRule(context, this._rules[i]))
            return this._rules[i];
        }
      }
      _matchRule(context, rule) {
        const name = context._name;
        const service = context._tags["service.name"];
        if (rule.name instanceof RegExp && !rule.name.test(name))
          return false;
        if (typeof rule.name === "string" && rule.name !== name)
          return false;
        if (rule.service instanceof RegExp && !rule.service.test(service))
          return false;
        if (typeof rule.service === "string" && rule.service !== service)
          return false;
        return true;
      }
    };
    function hasOwn(object, prop) {
      return Object.prototype.hasOwnProperty.call(object, prop);
    }
    module2.exports = PrioritySampler;
  }
});

// packages/dd-trace/src/opentracing/propagation/tracestate.js
var require_tracestate = __commonJS({
  "packages/dd-trace/src/opentracing/propagation/tracestate.js"(exports2, module2) {
    "use strict";
    var traceStateRegex = /[ \t]*([^=]+)=([ \t]*[^, \t]+)[ \t]*(,|$)/gim;
    var traceStateDataRegex = /([^:]+):([^;]+)(;|$)/gim;
    function fromString(Type, regex, value) {
      if (typeof value !== "string" || !value.length) {
        return new Type();
      }
      const values = [];
      for (const row of value.matchAll(regex)) {
        values.unshift(row.slice(1, 3));
      }
      return new Type(values);
    }
    function toString(map, pairSeparator, fieldSeparator) {
      return Array.from(map.entries()).reverse().map((pair) => pair.join(pairSeparator)).join(fieldSeparator);
    }
    var TraceStateData = class extends Map {
      constructor(...args) {
        super(...args);
        this.changed = false;
      }
      set(...args) {
        if (this.has(args[0]) && this.get(args[0]) === args[1]) {
          return;
        }
        this.changed = true;
        return super.set(...args);
      }
      delete(...args) {
        this.changed = true;
        return super.delete(...args);
      }
      clear(...args) {
        this.changed = true;
        return super.clear(...args);
      }
      static fromString(value) {
        return fromString(TraceStateData, traceStateDataRegex, value);
      }
      toString() {
        return toString(this, ":", ";");
      }
    };
    var TraceState = class extends Map {
      // Delete entries on update to ensure they're moved to the end of the list
      set(key, value) {
        if (this.has(key)) {
          this.delete(key);
        }
        return super.set(key, value);
      }
      forVendor(vendor, handle) {
        const data = super.get(vendor);
        const state = TraceStateData.fromString(data);
        const result = handle(state);
        if (state.changed) {
          const value = state.toString();
          if (value) {
            this.set(vendor, state.toString());
          } else {
            this.delete(vendor);
          }
        }
        return result;
      }
      static fromString(value) {
        return fromString(TraceState, traceStateRegex, value);
      }
      toString() {
        return toString(this, "=", ",");
      }
    };
    module2.exports = TraceState;
  }
});

// packages/dd-trace/src/opentracing/propagation/text_map.js
var require_text_map = __commonJS({
  "packages/dd-trace/src/opentracing/propagation/text_map.js"(exports2, module2) {
    "use strict";
    var pick = require("lodash.pick");
    var id = require_id();
    var DatadogSpanContext = require_span_context();
    var log = require_log();
    var TraceState = require_tracestate();
    var { AUTO_KEEP, AUTO_REJECT, USER_KEEP } = require_priority();
    var traceKey = "x-datadog-trace-id";
    var spanKey = "x-datadog-parent-id";
    var originKey = "x-datadog-origin";
    var samplingKey = "x-datadog-sampling-priority";
    var tagsKey = "x-datadog-tags";
    var baggagePrefix = "ot-baggage-";
    var b3TraceKey = "x-b3-traceid";
    var b3TraceExpr = /^([0-9a-f]{16}){1,2}$/i;
    var b3SpanKey = "x-b3-spanid";
    var b3SpanExpr = /^[0-9a-f]{16}$/i;
    var b3ParentKey = "x-b3-parentspanid";
    var b3SampledKey = "x-b3-sampled";
    var b3FlagsKey = "x-b3-flags";
    var b3HeaderKey = "b3";
    var sqsdHeaderHey = "x-aws-sqsd-attr-_datadog";
    var b3HeaderExpr = /^(([0-9a-f]{16}){1,2}-[0-9a-f]{16}(-[01d](-[0-9a-f]{16})?)?|[01d])$/i;
    var baggageExpr = new RegExp(`^${baggagePrefix}(.+)$`);
    var tagKeyExpr = /^_dd\.p\.[\x21-\x2b\x2d-\x7e]+$/;
    var tagValueExpr = /^[\x20-\x2b\x2d-\x7e]*$/;
    var ddKeys = [traceKey, spanKey, samplingKey, originKey];
    var b3Keys = [b3TraceKey, b3SpanKey, b3ParentKey, b3SampledKey, b3FlagsKey, b3HeaderKey];
    var logKeys = ddKeys.concat(b3Keys);
    var traceparentExpr = /^([a-f0-9]{2})-([a-f0-9]{32})-([a-f0-9]{16})-([a-f0-9]{2})(-.*)?$/i;
    var traceparentKey = "traceparent";
    var tracestateOriginFilter = /[^\x20-\x2b\x2d-\x3a\x3c-\x7d]/g;
    var tracestateTagKeyFilter = /[^\x21-\x2b\x2d-\x3c\x3e-\x7e]/g;
    var tracestateTagValueFilter = /[^\x20-\x2b\x2d-\x3a\x3c-\x7d]/g;
    var invalidSegment = /^0+$/;
    var TextMapPropagator = class {
      constructor(config) {
        this._config = config;
      }
      inject(spanContext, carrier) {
        this._injectBaggageItems(spanContext, carrier);
        this._injectDatadog(spanContext, carrier);
        this._injectB3MultipleHeaders(spanContext, carrier);
        this._injectB3SingleHeader(spanContext, carrier);
        this._injectTraceparent(spanContext, carrier);
        log.debug(() => `Inject into carrier: ${JSON.stringify(pick(carrier, logKeys))}.`);
      }
      extract(carrier) {
        const spanContext = this._extractSpanContext(carrier);
        if (!spanContext)
          return spanContext;
        log.debug(() => `Extract from carrier: ${JSON.stringify(pick(carrier, logKeys))}.`);
        return spanContext;
      }
      _injectDatadog(spanContext, carrier) {
        if (!this._hasPropagationStyle("inject", "datadog"))
          return;
        carrier[traceKey] = spanContext.toTraceId();
        carrier[spanKey] = spanContext.toSpanId();
        this._injectOrigin(spanContext, carrier);
        this._injectSamplingPriority(spanContext, carrier);
        this._injectTags(spanContext, carrier);
      }
      _injectOrigin(spanContext, carrier) {
        const origin = spanContext._trace.origin;
        if (origin) {
          carrier[originKey] = origin;
        }
      }
      _injectSamplingPriority(spanContext, carrier) {
        const priority = spanContext._sampling.priority;
        if (Number.isInteger(priority)) {
          carrier[samplingKey] = priority.toString();
        }
      }
      _injectBaggageItems(spanContext, carrier) {
        spanContext._baggageItems && Object.keys(spanContext._baggageItems).forEach((key) => {
          carrier[baggagePrefix + key] = String(spanContext._baggageItems[key]);
        });
      }
      _injectTags(spanContext, carrier) {
        const trace = spanContext._trace;
        if (this._config.tagsHeaderMaxLength === 0) {
          log.debug("Trace tag propagation is disabled, skipping injection.");
          return;
        }
        const tags = [];
        for (const key in trace.tags) {
          if (!trace.tags[key] || !key.startsWith("_dd.p."))
            continue;
          if (!this._validateTagKey(key) || !this._validateTagValue(trace.tags[key])) {
            log.error("Trace tags from span are invalid, skipping injection.");
            return;
          }
          tags.push(`${key}=${trace.tags[key]}`);
        }
        const header = tags.join(",");
        if (header.length > this._config.tagsHeaderMaxLength) {
          log.error("Trace tags from span are too large, skipping injection.");
        } else if (header) {
          carrier[tagsKey] = header;
        }
      }
      _injectB3MultipleHeaders(spanContext, carrier) {
        const hasB3 = this._hasPropagationStyle("inject", "b3");
        const hasB3multi = this._hasPropagationStyle("inject", "b3multi");
        if (!(hasB3 || hasB3multi))
          return;
        carrier[b3TraceKey] = this._getB3TraceId(spanContext);
        carrier[b3SpanKey] = spanContext._spanId.toString(16);
        carrier[b3SampledKey] = spanContext._sampling.priority >= AUTO_KEEP ? "1" : "0";
        if (spanContext._sampling.priority > AUTO_KEEP) {
          carrier[b3FlagsKey] = "1";
        }
        if (spanContext._parentId) {
          carrier[b3ParentKey] = spanContext._parentId.toString(16);
        }
      }
      _injectB3SingleHeader(spanContext, carrier) {
        const hasB3SingleHeader = this._hasPropagationStyle("inject", "b3 single header");
        if (!hasB3SingleHeader)
          return null;
        const traceId = this._getB3TraceId(spanContext);
        const spanId = spanContext._spanId.toString(16);
        const sampled = spanContext._sampling.priority >= AUTO_KEEP ? "1" : "0";
        carrier[b3HeaderKey] = `${traceId}-${spanId}-${sampled}`;
        if (spanContext._parentId) {
          carrier[b3HeaderKey] += "-" + spanContext._parentId.toString(16);
        }
      }
      _injectTraceparent(spanContext, carrier) {
        if (!this._hasPropagationStyle("inject", "tracecontext"))
          return;
        const {
          _sampling: { priority, mechanism },
          _tracestate: ts = new TraceState(),
          _trace: { origin, tags }
        } = spanContext;
        carrier[traceparentKey] = spanContext.toTraceparent();
        ts.forVendor("dd", (state) => {
          state.set("s", priority);
          if (mechanism) {
            state.set("t.dm", mechanism);
          }
          if (typeof origin === "string") {
            const originValue = origin.replace(tracestateOriginFilter, "_").replace(/[\x3d]/g, "~");
            state.set("o", originValue);
          }
          for (const key in tags) {
            if (!tags[key] || !key.startsWith("_dd.p."))
              continue;
            const tagKey = "t." + key.slice(6).replace(tracestateTagKeyFilter, "_");
            const tagValue = tags[key].toString().replace(tracestateTagValueFilter, "_").replace(/[\x3d]/g, "~");
            state.set(tagKey, tagValue);
          }
        });
        carrier.tracestate = ts.toString();
      }
      _hasPropagationStyle(mode, name) {
        return this._config.tracePropagationStyle[mode].includes(name);
      }
      _extractSpanContext(carrier) {
        for (const extractor of this._config.tracePropagationStyle.extract) {
          let spanContext = null;
          switch (extractor) {
            case "datadog":
              spanContext = this._extractDatadogContext(carrier);
              break;
            case "tracecontext":
              spanContext = this._extractTraceparentContext(carrier);
              break;
            case "b3":
            case "b3multi":
              spanContext = this._extractB3MultiContext(carrier);
              break;
            case "b3 single header":
              spanContext = this._extractB3SingleContext(carrier);
              break;
          }
          if (spanContext !== null) {
            return spanContext;
          }
        }
        return this._extractSqsdContext(carrier);
      }
      _extractDatadogContext(carrier) {
        const spanContext = this._extractGenericContext(carrier, traceKey, spanKey, 10);
        if (spanContext) {
          this._extractOrigin(carrier, spanContext);
          this._extractBaggageItems(carrier, spanContext);
          this._extractSamplingPriority(carrier, spanContext);
          this._extractTags(carrier, spanContext);
        }
        return spanContext;
      }
      _extractB3MultiContext(carrier) {
        const b3 = this._extractB3MultipleHeaders(carrier);
        if (!b3)
          return null;
        return this._extractB3Context(b3);
      }
      _extractB3SingleContext(carrier) {
        if (!b3HeaderExpr.test(carrier[b3HeaderKey]))
          return null;
        const b3 = this._extractB3SingleHeader(carrier);
        if (!b3)
          return null;
        return this._extractB3Context(b3);
      }
      _extractB3Context(b3) {
        const debug = b3[b3FlagsKey] === "1";
        const priority = this._getPriority(b3[b3SampledKey], debug);
        const spanContext = this._extractGenericContext(b3, b3TraceKey, b3SpanKey, 16);
        if (priority !== void 0) {
          if (!spanContext) {
            return new DatadogSpanContext({
              traceId: id(),
              spanId: null,
              sampling: { priority }
            });
          }
          spanContext._sampling.priority = priority;
        }
        this._extract128BitTraceId(b3[b3TraceKey], spanContext);
        return spanContext;
      }
      _extractSqsdContext(carrier) {
        const headerValue = carrier[sqsdHeaderHey];
        if (!headerValue) {
          return null;
        }
        let parsed;
        try {
          parsed = JSON.parse(headerValue);
        } catch (e) {
          return null;
        }
        return this._extractDatadogContext(parsed);
      }
      _extractTraceparentContext(carrier) {
        const headerValue = carrier[traceparentKey];
        if (!headerValue) {
          return null;
        }
        const matches = headerValue.trim().match(traceparentExpr);
        if (matches.length) {
          const [version, traceId, spanId, flags, tail] = matches.slice(1);
          const traceparent = { version };
          const tracestate = TraceState.fromString(carrier.tracestate);
          if (invalidSegment.test(traceId))
            return null;
          if (invalidSegment.test(spanId))
            return null;
          if (version === "ff")
            return null;
          if (tail && version === "00")
            return null;
          const spanContext = new DatadogSpanContext({
            traceId: id(traceId, 16),
            spanId: id(spanId, 16),
            sampling: { priority: parseInt(flags, 10) & 1 ? 1 : 0 },
            traceparent,
            tracestate
          });
          this._extract128BitTraceId(traceId, spanContext);
          tracestate.forVendor("dd", (state) => {
            for (const [key, value] of state.entries()) {
              switch (key) {
                case "s": {
                  const priority = parseInt(value, 10);
                  if (!Number.isInteger(priority))
                    continue;
                  if (spanContext._sampling.priority === 1 && priority > 0 || spanContext._sampling.priority === 0 && priority < 0) {
                    spanContext._sampling.priority = priority;
                  }
                  break;
                }
                case "o":
                  spanContext._trace.origin = value;
                  break;
                case "t.dm": {
                  const mechanism = -Math.abs(parseInt(value, 10));
                  if (Number.isInteger(mechanism)) {
                    spanContext._sampling.mechanism = mechanism;
                    spanContext._trace.tags["_dd.p.dm"] = String(mechanism);
                  }
                  break;
                }
                default:
                  if (!key.startsWith("t."))
                    continue;
                  spanContext._trace.tags[`_dd.p.${key.slice(2)}`] = value.replace(/[\x7e]/gm, "=");
              }
            }
          });
          this._extractBaggageItems(carrier, spanContext);
          return spanContext;
        }
        return null;
      }
      _extractGenericContext(carrier, traceKey2, spanKey2, radix) {
        if (carrier[traceKey2] && carrier[spanKey2]) {
          if (invalidSegment.test(carrier[traceKey2]))
            return null;
          return new DatadogSpanContext({
            traceId: id(carrier[traceKey2], radix),
            spanId: id(carrier[spanKey2], radix)
          });
        }
        return null;
      }
      _extractB3MultipleHeaders(carrier) {
        let empty = true;
        const b3 = {};
        if (b3TraceExpr.test(carrier[b3TraceKey]) && b3SpanExpr.test(carrier[b3SpanKey])) {
          b3[b3TraceKey] = carrier[b3TraceKey];
          b3[b3SpanKey] = carrier[b3SpanKey];
          empty = false;
        }
        if (carrier[b3SampledKey]) {
          b3[b3SampledKey] = carrier[b3SampledKey];
          empty = false;
        }
        if (carrier[b3FlagsKey]) {
          b3[b3FlagsKey] = carrier[b3FlagsKey];
          empty = false;
        }
        return empty ? null : b3;
      }
      _extractB3SingleHeader(carrier) {
        const header = carrier[b3HeaderKey];
        if (!header)
          return null;
        const parts = header.split("-");
        if (parts[0] === "d") {
          return {
            [b3SampledKey]: "1",
            [b3FlagsKey]: "1"
          };
        } else if (parts.length === 1) {
          return {
            [b3SampledKey]: parts[0]
          };
        } else {
          const b3 = {
            [b3TraceKey]: parts[0],
            [b3SpanKey]: parts[1]
          };
          if (parts[2]) {
            b3[b3SampledKey] = parts[2] !== "0" ? "1" : "0";
            if (parts[2] === "d") {
              b3[b3FlagsKey] = "1";
            }
          }
          return b3;
        }
      }
      _extractOrigin(carrier, spanContext) {
        const origin = carrier[originKey];
        if (typeof carrier[originKey] === "string") {
          spanContext._trace.origin = origin;
        }
      }
      _extractBaggageItems(carrier, spanContext) {
        Object.keys(carrier).forEach((key) => {
          const match = key.match(baggageExpr);
          if (match) {
            spanContext._baggageItems[match[1]] = carrier[key];
          }
        });
      }
      _extractSamplingPriority(carrier, spanContext) {
        const priority = parseInt(carrier[samplingKey], 10);
        if (Number.isInteger(priority)) {
          spanContext._sampling.priority = priority;
        }
      }
      _extractTags(carrier, spanContext) {
        if (!carrier[tagsKey])
          return;
        const trace = spanContext._trace;
        if (this._config.tagsHeaderMaxLength === 0) {
          log.debug("Trace tag propagation is disabled, skipping extraction.");
        } else if (carrier[tagsKey].length > this._config.tagsHeaderMaxLength) {
          log.error("Trace tags from carrier are too large, skipping extraction.");
        } else {
          const pairs = carrier[tagsKey].split(",");
          const tags = {};
          for (const pair of pairs) {
            const [key, ...rest] = pair.split("=");
            const value = rest.join("=");
            if (!this._validateTagKey(key) || !this._validateTagValue(value)) {
              log.error("Trace tags from carrier are invalid, skipping extraction.");
              return;
            }
            tags[key] = value;
          }
          Object.assign(trace.tags, tags);
        }
      }
      _extract128BitTraceId(traceId, spanContext) {
        if (!spanContext)
          return;
        const buffer = spanContext._traceId.toBuffer();
        if (buffer.length !== 16)
          return;
        const tid = traceId.substring(0, 16);
        if (tid === "0000000000000000")
          return;
        spanContext._trace.tags["_dd.p.tid"] = tid;
      }
      _validateTagKey(key) {
        return tagKeyExpr.test(key);
      }
      _validateTagValue(value) {
        return tagValueExpr.test(value);
      }
      _getPriority(sampled, debug) {
        if (debug) {
          return USER_KEEP;
        } else if (sampled === "1") {
          return AUTO_KEEP;
        } else if (sampled === "0") {
          return AUTO_REJECT;
        }
      }
      _getB3TraceId(spanContext) {
        if (spanContext._traceId.toBuffer().length <= 8 && spanContext._trace.tags["_dd.p.tid"]) {
          return spanContext._trace.tags["_dd.p.tid"] + spanContext._traceId.toString(16);
        }
        return spanContext._traceId.toString(16);
      }
    };
    module2.exports = TextMapPropagator;
  }
});

// packages/dd-trace/src/opentracing/propagation/http.js
var require_http = __commonJS({
  "packages/dd-trace/src/opentracing/propagation/http.js"(exports2, module2) {
    "use strict";
    var TextMapPropagator = require_text_map();
    var HttpPropagator = class extends TextMapPropagator {
    };
    module2.exports = HttpPropagator;
  }
});

// packages/dd-trace/src/opentracing/propagation/binary.js
var require_binary = __commonJS({
  "packages/dd-trace/src/opentracing/propagation/binary.js"(exports2, module2) {
    "use strict";
    var BinaryPropagator = class {
      inject(spanContext, carrier) {
      }
      extract(carrier) {
        return null;
      }
    };
    module2.exports = BinaryPropagator;
  }
});

// packages/dd-trace/src/opentracing/propagation/log.js
var require_log2 = __commonJS({
  "packages/dd-trace/src/opentracing/propagation/log.js"(exports2, module2) {
    "use strict";
    var id = require_id();
    var DatadogSpanContext = require_span_context();
    var LogPropagator = class {
      constructor(config) {
        this._config = config;
      }
      inject(spanContext, carrier) {
        if (!carrier)
          return;
        carrier.dd = {};
        if (spanContext) {
          if (this._config.traceId128BitLoggingEnabled && spanContext._trace.tags["_dd.p.tid"]) {
            carrier.dd.trace_id = spanContext._trace.tags["_dd.p.tid"] + spanContext._traceId.toString(16);
          } else {
            carrier.dd.trace_id = spanContext.toTraceId();
          }
          carrier.dd.span_id = spanContext.toSpanId();
        }
        if (this._config.service)
          carrier.dd.service = this._config.service;
        if (this._config.version)
          carrier.dd.version = this._config.version;
        if (this._config.env)
          carrier.dd.env = this._config.env;
      }
      extract(carrier) {
        if (!carrier || !carrier.dd || !carrier.dd.trace_id || !carrier.dd.span_id) {
          return null;
        }
        if (carrier.dd.trace_id.length === 32) {
          const hi = carrier.dd.trace_id.substring(0, 16);
          const lo = carrier.dd.trace_id.substring(16, 32);
          const spanContext = new DatadogSpanContext({
            traceId: id(lo, 16),
            spanId: id(carrier.dd.span_id, 10)
          });
          spanContext._trace.tags["_dd.p.tid"] = hi;
          return spanContext;
        } else {
          return new DatadogSpanContext({
            traceId: id(carrier.dd.trace_id, 10),
            spanId: id(carrier.dd.span_id, 10)
          });
        }
      }
    };
    module2.exports = LogPropagator;
  }
});

// packages/dd-trace/src/exporters/log/index.js
var require_log3 = __commonJS({
  "packages/dd-trace/src/exporters/log/index.js"(exports2, module2) {
    "use strict";
    var log = require_log();
    var TRACE_PREFIX = '{"traces":[[';
    var TRACE_SUFFIX = "]]}\n";
    var TRACE_FORMAT_OVERHEAD = TRACE_PREFIX.length + TRACE_SUFFIX.length;
    var MAX_SIZE = 64 * 1024;
    var LogExporter = class {
      export(spans) {
        log.debug(() => `Adding trace to queue: ${JSON.stringify(spans)}`);
        let size = TRACE_FORMAT_OVERHEAD;
        let queue = [];
        for (const span of spans) {
          const spanStr = JSON.stringify(span);
          if (spanStr.length + TRACE_FORMAT_OVERHEAD > MAX_SIZE) {
            log.debug("Span too large to send to logs, dropping");
            continue;
          }
          if (spanStr.length + size > MAX_SIZE) {
            this._printSpans(queue);
            queue = [];
            size = TRACE_FORMAT_OVERHEAD;
          }
          size += spanStr.length + 1;
          queue.push(spanStr);
        }
        if (queue.length > 0) {
          this._printSpans(queue);
        }
      }
      _printSpans(queue) {
        let logLine = TRACE_PREFIX;
        let firstTrace = true;
        for (const spanStr of queue) {
          if (firstTrace) {
            firstTrace = false;
            logLine += spanStr;
          } else {
            logLine += "," + spanStr;
          }
        }
        logLine += TRACE_SUFFIX;
        process.stdout.write(logLine);
      }
    };
    module2.exports = LogExporter;
  }
});

// packages/dd-trace/src/encode/0.5.js
var require__2 = __commonJS({
  "packages/dd-trace/src/encode/0.5.js"(exports2, module2) {
    "use strict";
    var { truncateSpan, normalizeSpan } = require_tags_processors();
    var { AgentEncoder: BaseEncoder } = require__();
    var ARRAY_OF_TWO = 146;
    var ARRAY_OF_TWELVE = 156;
    function formatSpan(span) {
      return normalizeSpan(truncateSpan(span, false));
    }
    var AgentEncoder = class extends BaseEncoder {
      makePayload() {
        const prefixSize = 1;
        const stringSize = this._stringBytes.length + 5;
        const traceSize = this._traceBytes.length + 5;
        const buffer = Buffer.allocUnsafe(prefixSize + stringSize + traceSize);
        let offset = 0;
        buffer[offset++] = ARRAY_OF_TWO;
        offset = this._writeStrings(buffer, offset);
        offset = this._writeTraces(buffer, offset);
        this._reset();
        return buffer;
      }
      _encode(bytes, trace) {
        this._encodeArrayPrefix(bytes, trace);
        for (let span of trace) {
          span = formatSpan(span);
          this._encodeByte(bytes, ARRAY_OF_TWELVE);
          this._encodeString(bytes, span.service);
          this._encodeString(bytes, span.name);
          this._encodeString(bytes, span.resource);
          this._encodeId(bytes, span.trace_id);
          this._encodeId(bytes, span.span_id);
          this._encodeId(bytes, span.parent_id);
          this._encodeLong(bytes, span.start || 0);
          this._encodeLong(bytes, span.duration || 0);
          this._encodeInteger(bytes, span.error);
          this._encodeMap(bytes, span.meta || {});
          this._encodeMap(bytes, span.metrics || {});
          this._encodeString(bytes, span.type);
        }
      }
      _encodeString(bytes, value = "") {
        this._cacheString(value);
        this._encodeInteger(bytes, this._stringMap[value]);
      }
      _cacheString(value) {
        if (!(value in this._stringMap)) {
          this._stringMap[value] = this._stringCount++;
          this._stringBytes.write(value);
        }
      }
      _writeStrings(buffer, offset) {
        offset = this._writeArrayPrefix(buffer, offset, this._stringCount);
        offset += this._stringBytes.buffer.copy(buffer, offset, 0, this._stringBytes.length);
        return offset;
      }
    };
    module2.exports = { AgentEncoder };
  }
});

// packages/dd-trace/src/exporters/agent/writer.js
var require_writer4 = __commonJS({
  "packages/dd-trace/src/exporters/agent/writer.js"(exports2, module2) {
    "use strict";
    var request = require_request();
    var { startupLog } = require_startup_log();
    var metrics = require_metrics();
    var log = require_log();
    var tracerVersion = require_package().version;
    var BaseWriter = require_writer2();
    var METRIC_PREFIX = "datadog.tracer.node.exporter.agent";
    var Writer = class extends BaseWriter {
      constructor({ prioritySampler, lookup, protocolVersion, headers }) {
        super(...arguments);
        const AgentEncoder = getEncoder(protocolVersion);
        this._prioritySampler = prioritySampler;
        this._lookup = lookup;
        this._protocolVersion = protocolVersion;
        this._encoder = new AgentEncoder(this);
        this._headers = headers;
      }
      _sendPayload(data, count, done) {
        metrics.increment(`${METRIC_PREFIX}.requests`, true);
        const { _headers, _lookup, _protocolVersion, _url } = this;
        makeRequest(_protocolVersion, data, count, _url, _headers, _lookup, true, (err, res, status) => {
          if (status) {
            metrics.increment(`${METRIC_PREFIX}.responses`, true);
            metrics.increment(`${METRIC_PREFIX}.responses.by.status`, `status:${status}`, true);
          } else if (err) {
            metrics.increment(`${METRIC_PREFIX}.errors`, true);
            metrics.increment(`${METRIC_PREFIX}.errors.by.name`, `name:${err.name}`, true);
            if (err.code) {
              metrics.increment(`${METRIC_PREFIX}.errors.by.code`, `code:${err.code}`, true);
            }
          }
          startupLog({ agentError: err });
          if (err) {
            log.error(err);
            done();
            return;
          }
          log.debug(`Response from the agent: ${res}`);
          try {
            this._prioritySampler.update(JSON.parse(res).rate_by_service);
          } catch (e) {
            log.error(e);
            metrics.increment(`${METRIC_PREFIX}.errors`, true);
            metrics.increment(`${METRIC_PREFIX}.errors.by.name`, `name:${e.name}`, true);
          }
          done();
        });
      }
    };
    function setHeader(headers, key, value) {
      if (value) {
        headers[key] = value;
      }
    }
    function getEncoder(protocolVersion) {
      if (protocolVersion === "0.5") {
        return require__2().AgentEncoder;
      } else {
        return require__().AgentEncoder;
      }
    }
    function makeRequest(version, data, count, url, headers, lookup, needsStartupLog, cb) {
      const options = {
        path: `/v${version}/traces`,
        method: "PUT",
        headers: {
          ...headers,
          "Content-Type": "application/msgpack",
          "Datadog-Meta-Tracer-Version": tracerVersion,
          "X-Datadog-Trace-Count": String(count)
        },
        lookup,
        url
      };
      setHeader(options.headers, "Datadog-Meta-Lang", "nodejs");
      setHeader(options.headers, "Datadog-Meta-Lang-Version", process.version);
      setHeader(options.headers, "Datadog-Meta-Lang-Interpreter", process.jsEngine || "v8");
      log.debug(() => `Request to the agent: ${JSON.stringify(options)}`);
      request(data, options, (err, res, status) => {
        if (needsStartupLog) {
          startupLog({
            agentError: status !== 404 && status !== 200 ? err : void 0
          });
        }
        cb(err, res, status);
      });
    }
    module2.exports = Writer;
  }
});

// packages/dd-trace/src/exporters/agent/index.js
var require_agent = __commonJS({
  "packages/dd-trace/src/exporters/agent/index.js"(exports2, module2) {
    "use strict";
    var { URL: URL2, format } = require("url");
    var log = require_log();
    var Writer = require_writer4();
    var AgentExporter = class {
      constructor(config, prioritySampler) {
        this._config = config;
        const { url, hostname, port, lookup, protocolVersion, stats = {} } = config;
        this._url = url || new URL2(format({
          protocol: "http:",
          hostname: hostname || "localhost",
          port
        }));
        const headers = {};
        if (stats.enabled) {
          headers["Datadog-Client-Computed-Stats"] = "yes";
        }
        this._writer = new Writer({
          url: this._url,
          prioritySampler,
          lookup,
          protocolVersion,
          headers
        });
        this._timer = void 0;
        process.once("beforeExit", () => this._writer.flush());
      }
      setUrl(url) {
        try {
          url = new URL2(url);
          this._url = url;
          this._writer.setUrl(url);
        } catch (e) {
          log.warn(e.stack);
        }
      }
      export(spans) {
        this._writer.append(spans);
        const { flushInterval } = this._config;
        if (flushInterval === 0) {
          this._writer.flush();
        } else if (flushInterval > 0 && !this._timer) {
          this._timer = setTimeout(() => {
            this._writer.flush();
            this._timer = clearTimeout(this._timer);
          }, flushInterval).unref();
        }
      }
      flush(done = () => {
      }) {
        this._writer.flush(done);
      }
    };
    module2.exports = AgentExporter;
  }
});

// packages/dd-trace/src/exporter.js
var require_exporter = __commonJS({
  "packages/dd-trace/src/exporter.js"(exports2, module2) {
    "use strict";
    var exporters = require_exporters();
    var fs = require("fs");
    var constants = require_constants();
    module2.exports = (name) => {
      const inAWSLambda = process.env.AWS_LAMBDA_FUNCTION_NAME !== void 0;
      const usingLambdaExtension = inAWSLambda && fs.existsSync(constants.DATADOG_LAMBDA_EXTENSION_PATH);
      switch (name) {
        case exporters.LOG:
          return require_log3();
        case exporters.AGENT:
          return require_agent();
        default:
          return inAWSLambda && !usingLambdaExtension ? require_log3() : require_agent();
      }
    };
  }
});

// packages/dd-trace/src/opentracing/tracer.js
var require_tracer2 = __commonJS({
  "packages/dd-trace/src/opentracing/tracer.js"(exports2, module2) {
    "use strict";
    var os = require("os");
    var Span = require_span2();
    var SpanProcessor = require_span_processor();
    var PrioritySampler = require_priority_sampler();
    var TextMapPropagator = require_text_map();
    var HttpPropagator = require_http();
    var BinaryPropagator = require_binary();
    var LogPropagator = require_log2();
    var formats = require_formats();
    var log = require_log();
    var metrics = require_metrics();
    var getExporter = require_exporter();
    var SpanContext = require_span_context();
    var REFERENCE_CHILD_OF = "child_of";
    var REFERENCE_FOLLOWS_FROM = "follows_from";
    var DatadogTracer = class {
      constructor(config) {
        const Exporter = getExporter(config.experimental.exporter);
        this._service = config.service;
        this._version = config.version;
        this._env = config.env;
        this._tags = config.tags;
        this._logInjection = config.logInjection;
        this._debug = config.debug;
        this._prioritySampler = new PrioritySampler(config.env, config.sampler);
        this._exporter = new Exporter(config, this._prioritySampler);
        this._processor = new SpanProcessor(this._exporter, this._prioritySampler, config);
        this._url = this._exporter._url;
        this._enableGetRumData = config.experimental.enableGetRumData;
        this._traceId128BitGenerationEnabled = config.traceId128BitGenerationEnabled;
        this._propagators = {
          [formats.TEXT_MAP]: new TextMapPropagator(config),
          [formats.HTTP_HEADERS]: new HttpPropagator(config),
          [formats.BINARY]: new BinaryPropagator(config),
          [formats.LOG]: new LogPropagator(config)
        };
        if (config.reportHostname) {
          this._hostname = os.hostname();
        }
      }
      startSpan(name, options = {}) {
        const parent = options.childOf ? getContext(options.childOf) : getParent(options.references);
        const tags = {
          "service.name": this._service
        };
        const span = new Span(this, this._processor, this._prioritySampler, {
          operationName: options.operationName || name,
          parent,
          tags,
          startTime: options.startTime,
          hostname: this._hostname,
          traceId128BitGenerationEnabled: this._traceId128BitGenerationEnabled
        }, this._debug);
        span.addTags(this._tags);
        span.addTags(options.tags);
        return span;
      }
      inject(spanContext, format, carrier) {
        if (spanContext instanceof Span) {
          spanContext = spanContext.context();
        }
        try {
          this._prioritySampler.sample(spanContext);
          this._propagators[format].inject(spanContext, carrier);
        } catch (e) {
          log.error(e);
          metrics.increment("datadog.tracer.node.inject.errors", true);
        }
      }
      extract(format, carrier) {
        try {
          return this._propagators[format].extract(carrier);
        } catch (e) {
          log.error(e);
          metrics.increment("datadog.tracer.node.extract.errors", true);
          return null;
        }
      }
    };
    function getContext(spanContext) {
      if (spanContext instanceof Span) {
        spanContext = spanContext.context();
      }
      if (!(spanContext instanceof SpanContext)) {
        spanContext = null;
      }
      return spanContext;
    }
    function getParent(references = []) {
      let parent = null;
      for (let i = 0; i < references.length; i++) {
        const ref = references[i];
        const type = ref.type();
        if (type === REFERENCE_CHILD_OF) {
          parent = ref.referencedContext();
          break;
        } else if (type === REFERENCE_FOLLOWS_FROM) {
          if (!parent) {
            parent = ref.referencedContext();
          }
        }
      }
      return parent;
    }
    module2.exports = DatadogTracer;
  }
});

// packages/dd-trace/src/scope.js
var require_scope2 = __commonJS({
  "packages/dd-trace/src/scope.js"(exports2, module2) {
    "use strict";
    var { storage } = require_datadog_core();
    var originals = /* @__PURE__ */ new WeakMap();
    var Scope = class {
      active() {
        const store = storage.getStore();
        return store && store.span || null;
      }
      activate(span, callback) {
        if (typeof callback !== "function")
          return callback;
        const oldStore = storage.getStore();
        const newStore = span ? span._store : oldStore;
        storage.enterWith({ ...newStore, span });
        try {
          return callback();
        } catch (e) {
          if (span && typeof span.setTag === "function") {
            span.setTag("error", e);
          }
          throw e;
        } finally {
          storage.enterWith(oldStore);
        }
      }
      bind(fn, span) {
        if (typeof fn !== "function")
          return fn;
        const scope = this;
        const spanOrActive = this._spanOrActive(span);
        const bound = function() {
          return scope.activate(spanOrActive, () => {
            return fn.apply(this, arguments);
          });
        };
        originals.set(bound, fn);
        return bound;
      }
      _spanOrActive(span) {
        return span !== void 0 ? span : this.active();
      }
      _isPromise(promise) {
        return promise && typeof promise.then === "function";
      }
    };
    module2.exports = Scope;
  }
});

// packages/dd-trace/src/tracer.js
var require_tracer3 = __commonJS({
  "packages/dd-trace/src/tracer.js"(exports2, module2) {
    "use strict";
    var Tracer = require_tracer2();
    var tags = require_tags();
    var Scope = require_scope2();
    var { storage } = require_datadog_core();
    var { isError } = require_util();
    var { setStartupLogConfig } = require_startup_log();
    var { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require_constants();
    var SPAN_TYPE = tags.SPAN_TYPE;
    var RESOURCE_NAME = tags.RESOURCE_NAME;
    var SERVICE_NAME = tags.SERVICE_NAME;
    var MEASURED = tags.MEASURED;
    var DatadogTracer = class extends Tracer {
      constructor(config) {
        super(config);
        this._scope = new Scope();
        setStartupLogConfig(config);
      }
      trace(name, options, fn) {
        options = Object.assign({
          childOf: this.scope().active()
        }, options);
        if (!options.childOf && options.orphanable === false) {
          return fn(null, () => {
          });
        }
        const span = this.startSpan(name, options);
        addTags(span, options);
        try {
          if (fn.length > 1) {
            return this.scope().activate(span, () => fn(span, (err) => {
              addError(span, err);
              span.finish();
            }));
          }
          const result = this.scope().activate(span, () => fn(span));
          if (result && typeof result.then === "function") {
            return result.then(
              (value) => {
                span.finish();
                return value;
              },
              (err) => {
                addError(span, err);
                span.finish();
                throw err;
              }
            );
          } else {
            span.finish();
          }
          return result;
        } catch (e) {
          addError(span, e);
          span.finish();
          throw e;
        }
      }
      wrap(name, options, fn) {
        const tracer = this;
        return function() {
          const store = storage.getStore();
          if (store && store.noop)
            return fn.apply(this, arguments);
          let optionsObj = options;
          if (typeof optionsObj === "function" && typeof fn === "function") {
            optionsObj = optionsObj.apply(this, arguments);
          }
          if (optionsObj && optionsObj.orphanable === false && !tracer.scope().active()) {
            return fn.apply(this, arguments);
          }
          const lastArgId = arguments.length - 1;
          const cb = arguments[lastArgId];
          if (typeof cb === "function") {
            const scopeBoundCb = tracer.scope().bind(cb);
            return tracer.trace(name, optionsObj, (span, done) => {
              arguments[lastArgId] = function(err) {
                done(err);
                return scopeBoundCb.apply(this, arguments);
              };
              return fn.apply(this, arguments);
            });
          } else {
            return tracer.trace(name, optionsObj, () => fn.apply(this, arguments));
          }
        };
      }
      setUrl(url) {
        this._exporter.setUrl(url);
      }
      scope() {
        return this._scope;
      }
      getRumData() {
        if (!this._enableGetRumData) {
          return "";
        }
        const span = this.scope().active().context();
        const traceId = span.toTraceId();
        const traceTime = Date.now();
        return `<meta name="dd-trace-id" content="${traceId}" /><meta name="dd-trace-time" content="${traceTime}" />`;
      }
    };
    function addError(span, error) {
      if (isError(error)) {
        span.addTags({
          [ERROR_TYPE]: error.name,
          [ERROR_MESSAGE]: error.message,
          [ERROR_STACK]: error.stack
        });
      }
    }
    function addTags(span, options) {
      const tags2 = {};
      if (options.type)
        tags2[SPAN_TYPE] = options.type;
      if (options.service)
        tags2[SERVICE_NAME] = options.service;
      if (options.resource)
        tags2[RESOURCE_NAME] = options.resource;
      tags2[MEASURED] = options.measured;
      span.addTags(tags2);
    }
    module2.exports = DatadogTracer;
  }
});

// packages/dd-trace/src/config.js
var require_config = __commonJS({
  "packages/dd-trace/src/config.js"(exports2, module2) {
    "use strict";
    var fs = require("fs");
    var os = require("os");
    var URL2 = require("url").URL;
    var log = require_log();
    var pkg = require_pkg();
    var coalesce = require("koalas");
    var tagger = require_tagger();
    var { isTrue, isFalse } = require_util();
    var uuid = require("crypto-randomuuid");
    var fromEntries = Object.fromEntries || ((entries) => entries.reduce((obj, [k, v]) => Object.assign(obj, { [k]: v }), {}));
    var qsRegex = '(?:p(?:ass)?w(?:or)?d|pass(?:_?phrase)?|secret|(?:api_?|private_?|public_?|access_?|secret_?)key(?:_?id)?|token|consumer_?(?:id|key|secret)|sign(?:ed|ature)?|auth(?:entication|orization)?)(?:(?:\\s|%20)*(?:=|%3D)[^&]+|(?:"|%22)(?:\\s|%20)*(?::|%3A)(?:\\s|%20)*(?:"|%22)(?:%2[^2]|%[^2]|[^"%])+(?:"|%22))|bearer(?:\\s|%20)+[a-z0-9\\._\\-]+|token(?::|%3A)[a-z0-9]{13}|gh[opsu]_[0-9a-zA-Z]{36}|ey[I-L](?:[\\w=-]|%3D)+\\.ey[I-L](?:[\\w=-]|%3D)+(?:\\.(?:[\\w.+\\/=-]|%3D|%2F|%2B)+)?|[\\-]{5}BEGIN(?:[a-z\\s]|%20)+PRIVATE(?:\\s|%20)KEY[\\-]{5}[^\\-]+[\\-]{5}END(?:[a-z\\s]|%20)+PRIVATE(?:\\s|%20)KEY|ssh-rsa(?:\\s|%20)*(?:[a-z0-9\\/\\.+]|%2F|%5C|%2B){100,}';
    function maybeFile(filepath) {
      if (!filepath)
        return;
      try {
        return fs.readFileSync(filepath, "utf8");
      } catch (e) {
        log.error(e);
        return void 0;
      }
    }
    function safeJsonParse(input) {
      try {
        return JSON.parse(input);
      } catch (err) {
        return void 0;
      }
    }
    function remapify(input, mappings) {
      if (!input)
        return;
      const output = {};
      for (const [key, value] of Object.entries(input)) {
        output[key in mappings ? mappings[key] : key] = value;
      }
      return output;
    }
    function propagationStyle(key, option, defaultValue) {
      if (typeof option === "object" && !Array.isArray(option)) {
        option = option[key];
      }
      if (Array.isArray(option))
        return option.map((v) => v.toLowerCase());
      if (typeof option !== "undefined") {
        log.warn("Unexpected input for config.tracePropagationStyle");
      }
      const envKey = `DD_TRACE_PROPAGATION_STYLE_${key.toUpperCase()}`;
      const envVar = coalesce(process.env[envKey], process.env.DD_TRACE_PROPAGATION_STYLE);
      if (typeof envVar !== "undefined") {
        return envVar.split(",").filter((v) => v !== "").map((v) => v.trim().toLowerCase());
      }
      return defaultValue;
    }
    var Config = class {
      constructor(options) {
        options = options || {};
        this.debug = isTrue(coalesce(
          process.env.DD_TRACE_DEBUG,
          false
        ));
        this.logger = options.logger;
        this.logLevel = coalesce(
          options.logLevel,
          process.env.DD_TRACE_LOG_LEVEL,
          "debug"
        );
        log.use(this.logger);
        log.toggle(this.debug, this.logLevel, this);
        this.tags = {};
        tagger.add(this.tags, process.env.DD_TAGS);
        tagger.add(this.tags, process.env.DD_TRACE_TAGS);
        tagger.add(this.tags, process.env.DD_TRACE_GLOBAL_TAGS);
        tagger.add(this.tags, options.tags);
        const DD_TRACING_ENABLED = coalesce(
          process.env.DD_TRACING_ENABLED,
          true
        );
        const DD_PROFILING_ENABLED = coalesce(
          options.profiling,
          // TODO: remove when enabled by default
          process.env.DD_EXPERIMENTAL_PROFILING_ENABLED,
          process.env.DD_PROFILING_ENABLED,
          false
        );
        const DD_PROFILING_EXPORTERS = coalesce(
          process.env.DD_PROFILING_EXPORTERS,
          "agent"
        );
        const DD_PROFILING_SOURCE_MAP = process.env.DD_PROFILING_SOURCE_MAP;
        const DD_LOGS_INJECTION = coalesce(
          options.logInjection,
          process.env.DD_LOGS_INJECTION,
          false
        );
        const DD_RUNTIME_METRICS_ENABLED = coalesce(
          options.runtimeMetrics,
          // TODO: remove when enabled by default
          process.env.DD_RUNTIME_METRICS_ENABLED,
          false
        );
        const DD_DBM_PROPAGATION_MODE = coalesce(
          options.dbmPropagationMode,
          process.env.DD_DBM_PROPAGATION_MODE,
          "disabled"
        );
        const DD_AGENT_HOST = coalesce(
          options.hostname,
          process.env.DD_AGENT_HOST,
          process.env.DD_TRACE_AGENT_HOSTNAME,
          "127.0.0.1"
        );
        const DD_TRACE_AGENT_PORT = coalesce(
          options.port,
          process.env.DD_TRACE_AGENT_PORT,
          "8126"
        );
        const DD_TRACE_AGENT_URL = coalesce(
          options.url,
          process.env.DD_TRACE_AGENT_URL,
          process.env.DD_TRACE_URL,
          null
        );
        const DD_IS_CIVISIBILITY = coalesce(
          options.isCiVisibility,
          false
        );
        const DD_CIVISIBILITY_AGENTLESS_URL = process.env.DD_CIVISIBILITY_AGENTLESS_URL;
        const DD_CIVISIBILITY_ITR_ENABLED = coalesce(
          process.env.DD_CIVISIBILITY_ITR_ENABLED,
          true
        );
        const DD_SERVICE = options.service || process.env.DD_SERVICE || process.env.DD_SERVICE_NAME || this.tags.service || process.env.AWS_LAMBDA_FUNCTION_NAME || pkg.name || "node";
        const DD_SERVICE_MAPPING = coalesce(
          options.serviceMapping,
          process.env.DD_SERVICE_MAPPING ? fromEntries(
            process.env.DD_SERVICE_MAPPING.split(",").map((x) => x.trim().split(":"))
          ) : {}
        );
        const DD_ENV = coalesce(
          options.env,
          process.env.DD_ENV,
          this.tags.env
        );
        const DD_VERSION = coalesce(
          options.version,
          process.env.DD_VERSION,
          this.tags.version,
          pkg.version
        );
        const DD_TRACE_STARTUP_LOGS = coalesce(
          options.startupLogs,
          process.env.DD_TRACE_STARTUP_LOGS,
          false
        );
        const DD_TRACE_TELEMETRY_ENABLED = coalesce(
          process.env.DD_TRACE_TELEMETRY_ENABLED,
          !process.env.AWS_LAMBDA_FUNCTION_NAME
        );
        const DD_TELEMETRY_DEBUG_ENABLED = coalesce(
          process.env.DD_TELEMETRY_DEBUG_ENABLED,
          false
        );
        const DD_TRACE_AGENT_PROTOCOL_VERSION = coalesce(
          options.protocolVersion,
          process.env.DD_TRACE_AGENT_PROTOCOL_VERSION,
          "0.4"
        );
        const DD_TRACE_PARTIAL_FLUSH_MIN_SPANS = coalesce(
          parseInt(options.flushMinSpans),
          parseInt(process.env.DD_TRACE_PARTIAL_FLUSH_MIN_SPANS),
          1e3
        );
        const DD_TRACE_OBFUSCATION_QUERY_STRING_REGEXP = coalesce(
          process.env.DD_TRACE_OBFUSCATION_QUERY_STRING_REGEXP,
          qsRegex
        );
        const DD_TRACE_CLIENT_IP_ENABLED = coalesce(
          options.clientIpEnabled,
          process.env.DD_TRACE_CLIENT_IP_ENABLED && isTrue(process.env.DD_TRACE_CLIENT_IP_ENABLED),
          false
        );
        const DD_TRACE_CLIENT_IP_HEADER = coalesce(
          options.clientIpHeader,
          process.env.DD_TRACE_CLIENT_IP_HEADER,
          null
        );
        const DD_TRACE_B3_ENABLED = coalesce(
          options.experimental && options.experimental.b3,
          process.env.DD_TRACE_EXPERIMENTAL_B3_ENABLED,
          false
        );
        const defaultPropagationStyle = ["tracecontext", "datadog"];
        if (isTrue(DD_TRACE_B3_ENABLED)) {
          defaultPropagationStyle.push("b3");
          defaultPropagationStyle.push("b3 single header");
        }
        if (process.env.DD_TRACE_PROPAGATION_STYLE && (process.env.DD_TRACE_PROPAGATION_STYLE_INJECT || process.env.DD_TRACE_PROPAGATION_STYLE_EXTRACT)) {
          log.warn(
            "Use either the DD_TRACE_PROPAGATION_STYLE environment variable or separate DD_TRACE_PROPAGATION_STYLE_INJECT and DD_TRACE_PROPAGATION_STYLE_EXTRACT environment variables"
          );
        }
        const DD_TRACE_PROPAGATION_STYLE_INJECT = propagationStyle(
          "inject",
          options.tracePropagationStyle,
          defaultPropagationStyle
        );
        const DD_TRACE_PROPAGATION_STYLE_EXTRACT = propagationStyle(
          "extract",
          options.tracePropagationStyle,
          defaultPropagationStyle
        );
        const DD_TRACE_RUNTIME_ID_ENABLED = coalesce(
          options.experimental && options.experimental.runtimeId,
          process.env.DD_TRACE_EXPERIMENTAL_RUNTIME_ID_ENABLED,
          false
        );
        const DD_TRACE_EXPORTER = coalesce(
          options.experimental && options.experimental.exporter,
          process.env.DD_TRACE_EXPERIMENTAL_EXPORTER
        );
        const DD_TRACE_GET_RUM_DATA_ENABLED = coalesce(
          options.experimental && options.experimental.enableGetRumData,
          process.env.DD_TRACE_EXPERIMENTAL_GET_RUM_DATA_ENABLED,
          false
        );
        const DD_TRACE_X_DATADOG_TAGS_MAX_LENGTH = coalesce(
          process.env.DD_TRACE_X_DATADOG_TAGS_MAX_LENGTH,
          "512"
        );
        const DD_TRACE_STATS_COMPUTATION_ENABLED = coalesce(
          options.stats,
          process.env.DD_TRACE_STATS_COMPUTATION_ENABLED,
          false
        );
        const DD_TRACE_128_BIT_TRACEID_GENERATION_ENABLED = coalesce(
          options.traceId128BitGenerationEnabled,
          process.env.DD_TRACE_128_BIT_TRACEID_GENERATION_ENABLED,
          false
        );
        const DD_TRACE_128_BIT_TRACEID_LOGGING_ENABLED = coalesce(
          options.traceId128BitLoggingEnabled,
          process.env.DD_TRACE_128_BIT_TRACEID_LOGGING_ENABLED,
          false
        );
        let appsec = options.appsec != null ? options.appsec : options.experimental && options.experimental.appsec;
        if (typeof appsec === "boolean") {
          appsec = {
            enabled: appsec
          };
        } else if (appsec == null) {
          appsec = {};
        }
        const DD_APPSEC_ENABLED = coalesce(
          appsec.enabled,
          process.env.DD_APPSEC_ENABLED && isTrue(process.env.DD_APPSEC_ENABLED)
        );
        const DD_APPSEC_RULES = coalesce(
          appsec.rules,
          process.env.DD_APPSEC_RULES
        );
        const DD_APPSEC_TRACE_RATE_LIMIT = coalesce(
          parseInt(appsec.rateLimit),
          parseInt(process.env.DD_APPSEC_TRACE_RATE_LIMIT),
          100
        );
        const DD_APPSEC_WAF_TIMEOUT = coalesce(
          parseInt(appsec.wafTimeout),
          parseInt(process.env.DD_APPSEC_WAF_TIMEOUT),
          5e3
          // µs
        );
        const DD_APPSEC_OBFUSCATION_PARAMETER_KEY_REGEXP = coalesce(
          appsec.obfuscatorKeyRegex,
          process.env.DD_APPSEC_OBFUSCATION_PARAMETER_KEY_REGEXP,
          `(?i)(?:p(?:ass)?w(?:or)?d|pass(?:_?phrase)?|secret|(?:api_?|private_?|public_?)key)|token|consumer_?(?:id|key|secret)|sign(?:ed|ature)|bearer|authorization`
        );
        const DD_APPSEC_OBFUSCATION_PARAMETER_VALUE_REGEXP = coalesce(
          appsec.obfuscatorValueRegex,
          process.env.DD_APPSEC_OBFUSCATION_PARAMETER_VALUE_REGEXP,
          `(?i)(?:p(?:ass)?w(?:or)?d|pass(?:_?phrase)?|secret|(?:api_?|private_?|public_?|access_?|secret_?)key(?:_?id)?|token|consumer_?(?:id|key|secret)|sign(?:ed|ature)?|auth(?:entication|orization)?)(?:\\s*=[^;]|"\\s*:\\s*"[^"]+")|bearer\\s+[a-z0-9\\._\\-]+|token:[a-z0-9]{13}|gh[opsu]_[0-9a-zA-Z]{36}|ey[I-L][\\w=-]+\\.ey[I-L][\\w=-]+(?:\\.[\\w.+\\/=-]+)?|[\\-]{5}BEGIN[a-z\\s]+PRIVATE\\sKEY[\\-]{5}[^\\-]+[\\-]{5}END[a-z\\s]+PRIVATE\\sKEY|ssh-rsa\\s*[a-z0-9\\/\\.+]{100,}`
        );
        const DD_APPSEC_HTTP_BLOCKED_TEMPLATE_HTML = coalesce(
          maybeFile(appsec.blockedTemplateHtml),
          maybeFile(process.env.DD_APPSEC_HTTP_BLOCKED_TEMPLATE_HTML)
        );
        const DD_APPSEC_HTTP_BLOCKED_TEMPLATE_JSON = coalesce(
          maybeFile(appsec.blockedTemplateJson),
          maybeFile(process.env.DD_APPSEC_HTTP_BLOCKED_TEMPLATE_JSON)
        );
        const inAWSLambda = process.env.AWS_LAMBDA_FUNCTION_NAME !== void 0;
        const remoteConfigOptions = options.remoteConfig || {};
        const DD_REMOTE_CONFIGURATION_ENABLED = coalesce(
          process.env.DD_REMOTE_CONFIGURATION_ENABLED && isTrue(process.env.DD_REMOTE_CONFIGURATION_ENABLED),
          !inAWSLambda
        );
        const DD_REMOTE_CONFIG_POLL_INTERVAL_SECONDS = coalesce(
          parseInt(remoteConfigOptions.pollInterval),
          parseInt(process.env.DD_REMOTE_CONFIG_POLL_INTERVAL_SECONDS),
          5
          // seconds
        );
        const iastOptions = options.experimental && options.experimental.iast;
        const DD_IAST_ENABLED = coalesce(
          iastOptions && (iastOptions === true || iastOptions.enabled === true),
          process.env.DD_IAST_ENABLED,
          false
        );
        const DD_TELEMETRY_LOG_COLLECTION_ENABLED = coalesce(
          process.env.DD_TELEMETRY_LOG_COLLECTION_ENABLED,
          DD_IAST_ENABLED
        );
        const defaultIastRequestSampling = 30;
        const iastRequestSampling = coalesce(
          parseInt(iastOptions && iastOptions.requestSampling),
          parseInt(process.env.DD_IAST_REQUEST_SAMPLING),
          defaultIastRequestSampling
        );
        const DD_IAST_REQUEST_SAMPLING = iastRequestSampling < 0 || iastRequestSampling > 100 ? defaultIastRequestSampling : iastRequestSampling;
        const DD_IAST_MAX_CONCURRENT_REQUESTS = coalesce(
          parseInt(iastOptions && iastOptions.maxConcurrentRequests),
          parseInt(process.env.DD_IAST_MAX_CONCURRENT_REQUESTS),
          2
        );
        const DD_IAST_MAX_CONTEXT_OPERATIONS = coalesce(
          parseInt(iastOptions && iastOptions.maxContextOperations),
          parseInt(process.env.DD_IAST_MAX_CONTEXT_OPERATIONS),
          2
        );
        const DD_IAST_DEDUPLICATION_ENABLED = coalesce(
          iastOptions && iastOptions.deduplicationEnabled,
          process.env.DD_IAST_DEDUPLICATION_ENABLED && isTrue(process.env.DD_IAST_DEDUPLICATION_ENABLED),
          true
        );
        const DD_CIVISIBILITY_GIT_UPLOAD_ENABLED = coalesce(
          process.env.DD_CIVISIBILITY_GIT_UPLOAD_ENABLED,
          true
        );
        const ingestion = options.ingestion || {};
        const dogstatsd = coalesce(options.dogstatsd, {});
        const sampler = {
          sampleRate: coalesce(
            options.sampleRate,
            process.env.DD_TRACE_SAMPLE_RATE,
            ingestion.sampleRate
          ),
          rateLimit: coalesce(options.rateLimit, process.env.DD_TRACE_RATE_LIMIT, ingestion.rateLimit),
          rules: coalesce(
            options.samplingRules,
            safeJsonParse(process.env.DD_TRACE_SAMPLING_RULES),
            []
          ).map((rule) => {
            return remapify(rule, {
              sample_rate: "sampleRate"
            });
          }),
          spanSamplingRules: coalesce(
            options.spanSamplingRules,
            safeJsonParse(maybeFile(process.env.DD_SPAN_SAMPLING_RULES_FILE)),
            safeJsonParse(process.env.DD_SPAN_SAMPLING_RULES),
            []
          ).map((rule) => {
            return remapify(rule, {
              sample_rate: "sampleRate",
              max_per_second: "maxPerSecond"
            });
          })
        };
        const defaultFlushInterval = inAWSLambda ? 0 : 2e3;
        this.tracing = !isFalse(DD_TRACING_ENABLED);
        this.dbmPropagationMode = DD_DBM_PROPAGATION_MODE;
        this.logInjection = isTrue(DD_LOGS_INJECTION);
        this.env = DD_ENV;
        this.url = DD_CIVISIBILITY_AGENTLESS_URL ? new URL2(DD_CIVISIBILITY_AGENTLESS_URL) : getAgentUrl(DD_TRACE_AGENT_URL, options);
        this.site = coalesce(options.site, process.env.DD_SITE, "datadoghq.com");
        this.hostname = DD_AGENT_HOST || this.url && this.url.hostname;
        this.port = String(DD_TRACE_AGENT_PORT || this.url && this.url.port);
        this.flushInterval = coalesce(parseInt(options.flushInterval, 10), defaultFlushInterval);
        this.flushMinSpans = DD_TRACE_PARTIAL_FLUSH_MIN_SPANS;
        this.sampleRate = coalesce(Math.min(Math.max(sampler.sampleRate, 0), 1), 1);
        this.queryStringObfuscation = DD_TRACE_OBFUSCATION_QUERY_STRING_REGEXP;
        this.clientIpEnabled = DD_TRACE_CLIENT_IP_ENABLED;
        this.clientIpHeader = DD_TRACE_CLIENT_IP_HEADER;
        this.plugins = !!coalesce(options.plugins, true);
        this.service = DD_SERVICE;
        this.serviceMapping = DD_SERVICE_MAPPING;
        this.version = DD_VERSION;
        this.dogstatsd = {
          hostname: coalesce(dogstatsd.hostname, process.env.DD_DOGSTATSD_HOSTNAME, this.hostname),
          port: String(coalesce(dogstatsd.port, process.env.DD_DOGSTATSD_PORT, 8125))
        };
        this.runtimeMetrics = isTrue(DD_RUNTIME_METRICS_ENABLED);
        this.tracePropagationStyle = {
          inject: DD_TRACE_PROPAGATION_STYLE_INJECT,
          extract: DD_TRACE_PROPAGATION_STYLE_EXTRACT
        };
        this.experimental = {
          runtimeId: isTrue(DD_TRACE_RUNTIME_ID_ENABLED),
          exporter: DD_TRACE_EXPORTER,
          enableGetRumData: isTrue(DD_TRACE_GET_RUM_DATA_ENABLED)
        };
        this.sampler = sampler;
        this.reportHostname = isTrue(coalesce(options.reportHostname, process.env.DD_TRACE_REPORT_HOSTNAME, false));
        this.scope = process.env.DD_TRACE_SCOPE;
        this.profiling = {
          enabled: isTrue(DD_PROFILING_ENABLED),
          sourceMap: !isFalse(DD_PROFILING_SOURCE_MAP),
          exporters: DD_PROFILING_EXPORTERS
        };
        this.lookup = options.lookup;
        this.startupLogs = isTrue(DD_TRACE_STARTUP_LOGS);
        this.telemetry = {
          enabled: DD_TRACE_EXPORTER !== "datadog" && isTrue(DD_TRACE_TELEMETRY_ENABLED),
          logCollection: isTrue(DD_TELEMETRY_LOG_COLLECTION_ENABLED),
          debug: isTrue(DD_TELEMETRY_DEBUG_ENABLED)
        };
        this.protocolVersion = DD_TRACE_AGENT_PROTOCOL_VERSION;
        this.tagsHeaderMaxLength = parseInt(DD_TRACE_X_DATADOG_TAGS_MAX_LENGTH);
        this.appsec = {
          enabled: DD_APPSEC_ENABLED,
          // rules: DD_APPSEC_RULES ? safeJsonParse(maybeFile(DD_APPSEC_RULES)) : require('./appsec/recommended.json'),
          customRulesProvided: !!DD_APPSEC_RULES,
          rateLimit: DD_APPSEC_TRACE_RATE_LIMIT,
          wafTimeout: DD_APPSEC_WAF_TIMEOUT,
          obfuscatorKeyRegex: DD_APPSEC_OBFUSCATION_PARAMETER_KEY_REGEXP,
          obfuscatorValueRegex: DD_APPSEC_OBFUSCATION_PARAMETER_VALUE_REGEXP,
          blockedTemplateHtml: DD_APPSEC_HTTP_BLOCKED_TEMPLATE_HTML,
          blockedTemplateJson: DD_APPSEC_HTTP_BLOCKED_TEMPLATE_JSON
        };
        this.remoteConfig = {
          enabled: DD_REMOTE_CONFIGURATION_ENABLED,
          pollInterval: DD_REMOTE_CONFIG_POLL_INTERVAL_SECONDS
        };
        this.iast = {
          enabled: isTrue(DD_IAST_ENABLED),
          requestSampling: DD_IAST_REQUEST_SAMPLING,
          maxConcurrentRequests: DD_IAST_MAX_CONCURRENT_REQUESTS,
          maxContextOperations: DD_IAST_MAX_CONTEXT_OPERATIONS,
          deduplicationEnabled: DD_IAST_DEDUPLICATION_ENABLED
        };
        this.isCiVisibility = isTrue(DD_IS_CIVISIBILITY);
        this.isIntelligentTestRunnerEnabled = this.isCiVisibility && isTrue(DD_CIVISIBILITY_ITR_ENABLED);
        this.isGitUploadEnabled = this.isCiVisibility && (this.isIntelligentTestRunnerEnabled && !isFalse(DD_CIVISIBILITY_GIT_UPLOAD_ENABLED));
        this.stats = {
          enabled: isTrue(DD_TRACE_STATS_COMPUTATION_ENABLED)
        };
        this.traceId128BitGenerationEnabled = isTrue(DD_TRACE_128_BIT_TRACEID_GENERATION_ENABLED);
        this.traceId128BitLoggingEnabled = isTrue(DD_TRACE_128_BIT_TRACEID_LOGGING_ENABLED);
        tagger.add(this.tags, {
          service: this.service,
          env: this.env,
          version: this.version,
          "runtime-id": uuid()
        });
      }
    };
    function getAgentUrl(url, options) {
      if (url)
        return new URL2(url);
      if (os.type() === "Windows_NT")
        return;
      if (!options.hostname && !options.port && !process.env.DD_AGENT_HOST && !process.env.DD_TRACE_AGENT_HOSTNAME && !process.env.DD_TRACE_AGENT_PORT && fs.existsSync("/var/run/datadog/apm.socket")) {
        return new URL2("unix:///var/run/datadog/apm.socket");
      }
    }
    module2.exports = Config;
  }
});

// packages/dd-trace/src/require-package-json.js
var require_require_package_json = __commonJS({
  "packages/dd-trace/src/require-package-json.js"(exports2, module2) {
    "use strict";
    var path = require("path");
    var fs = require("fs");
    function requirePackageJson(name, module3) {
      if (path.isAbsolute(name)) {
        const candidate = path.join(name, "package.json");
        return JSON.parse(fs.readFileSync(candidate, "utf8"));
      }
      for (const modulePath of module3.paths) {
        const candidate = path.join(modulePath, name, "package.json");
        try {
          return JSON.parse(fs.readFileSync(candidate, "utf8"));
        } catch (e) {
          continue;
        }
      }
      throw new Error(`could not find ${name}/package.json`);
    }
    module2.exports = requirePackageJson;
  }
});

// packages/dd-trace/src/telemetry/send-data.js
var require_send_data = __commonJS({
  "packages/dd-trace/src/telemetry/send-data.js"(exports2, module2) {
    var request = require_request();
    var seqId = 0;
    function sendData(config, application, host, reqType, payload = {}) {
      const {
        hostname,
        port,
        url
      } = config;
      const { logger, tags, serviceMapping, ...trimmedPayload } = payload;
      const options = {
        url,
        hostname,
        port,
        method: "POST",
        path: "/telemetry/proxy/api/v2/apmtelemetry",
        headers: {
          "content-type": "application/json",
          "dd-telemetry-api-version": "v1",
          "dd-telemetry-request-type": reqType
        }
      };
      const data = JSON.stringify({
        api_version: "v1",
        request_type: reqType,
        tracer_time: Math.floor(Date.now() / 1e3),
        runtime_id: config.tags["runtime-id"],
        seq_id: ++seqId,
        payload: trimmedPayload,
        application,
        host
      });
      request(data, options, () => {
      });
    }
    module2.exports = { sendData };
  }
});

// packages/dd-trace/src/telemetry/dependencies.js
var require_dependencies = __commonJS({
  "packages/dd-trace/src/telemetry/dependencies.js"(exports2, module2) {
    "use strict";
    var path = require("path");
    var parse = require("module-details-from-path");
    var requirePackageJson = require_require_package_json();
    var { sendData } = require_send_data();
    var dc = require_diagnostics_channel();
    var { fileURLToPath } = require("url");
    var savedDependencies = /* @__PURE__ */ new Set();
    var detectedDependencyNames = /* @__PURE__ */ new Set();
    var FILE_URI_START = `file://`;
    var moduleLoadStartChannel = dc.channel("dd-trace:moduleLoadStart");
    var immediate;
    var config;
    var application;
    var host;
    function waitAndSend(config2, application2, host2) {
      if (!immediate) {
        immediate = setImmediate(() => {
          immediate = null;
          if (savedDependencies.size > 0) {
            const dependencies = Array.from(savedDependencies.values()).splice(0, 1e3).map((pair) => {
              savedDependencies.delete(pair);
              const [name, version] = pair.split(" ");
              return { name, version };
            });
            sendData(config2, application2, host2, "app-dependencies-loaded", { dependencies });
            if (savedDependencies.size > 0) {
              waitAndSend(config2, application2, host2);
            }
          }
        });
        immediate.unref();
      }
    }
    function onModuleLoad(data) {
      if (data) {
        let filename = data.filename;
        if (filename && filename.startsWith(FILE_URI_START)) {
          try {
            filename = fileURLToPath(filename);
          } catch (e) {
          }
        }
        const parseResult = filename && parse(filename);
        const request = data.request || parseResult && parseResult.name;
        if (filename && request && isDependency(filename, request) && !detectedDependencyNames.has(request)) {
          detectedDependencyNames.add(request);
          if (parseResult) {
            const { name, basedir } = parseResult;
            if (basedir) {
              try {
                const { version } = requirePackageJson(basedir, module2);
                savedDependencies.add(`${name} ${version}`);
                waitAndSend(config, application, host);
              } catch (e) {
              }
            }
          }
        }
      }
    }
    function start(_config, _application, _host) {
      config = _config;
      application = _application;
      host = _host;
      moduleLoadStartChannel.subscribe(onModuleLoad);
    }
    function isDependency(filename, request) {
      const isDependencyWithSlash = isDependencyWithSeparator(filename, request, "/");
      if (isDependencyWithSlash && process.platform === "win32") {
        return isDependencyWithSeparator(filename, request, path.sep);
      }
      return isDependencyWithSlash;
    }
    function isDependencyWithSeparator(filename, request, sep) {
      return request.indexOf(`..${sep}`) !== 0 && request.indexOf(`.${sep}`) !== 0 && request.indexOf(sep) !== 0 && request.indexOf(`:${sep}`) !== 1;
    }
    function stop() {
      config = null;
      application = null;
      host = null;
      detectedDependencyNames.clear();
      savedDependencies.clear();
      if (moduleLoadStartChannel.hasSubscribers) {
        moduleLoadStartChannel.unsubscribe(onModuleLoad);
      }
    }
    module2.exports = { start, stop };
  }
});

// packages/dd-trace/src/telemetry/index.js
var require_telemetry = __commonJS({
  "packages/dd-trace/src/telemetry/index.js"(exports2, module2) {
    "use strict";
    var tracerVersion = require_package().version;
    var dc = require_diagnostics_channel();
    var os = require("os");
    var dependencies = require_dependencies();
    var { sendData } = require_send_data();
    var HEARTBEAT_INTERVAL = process.env.DD_TELEMETRY_HEARTBEAT_INTERVAL ? Number(process.env.DD_TELEMETRY_HEARTBEAT_INTERVAL) * 1e3 : 6e4;
    var telemetryStartChannel = dc.channel("datadog:telemetry:start");
    var telemetryStopChannel = dc.channel("datadog:telemetry:stop");
    var config;
    var pluginManager;
    var application;
    var host;
    var interval;
    var sentIntegrations = /* @__PURE__ */ new Set();
    function getIntegrations() {
      const newIntegrations = [];
      for (const pluginName in pluginManager._pluginsByName) {
        if (sentIntegrations.has(pluginName)) {
          continue;
        }
        newIntegrations.push({
          name: pluginName,
          enabled: pluginManager._pluginsByName[pluginName]._enabled,
          auto_enabled: true
        });
        sentIntegrations.add(pluginName);
      }
      return newIntegrations;
    }
    function flatten(input, result = [], prefix = [], traversedObjects = null) {
      traversedObjects = traversedObjects || /* @__PURE__ */ new WeakSet();
      if (traversedObjects.has(input)) {
        return;
      }
      traversedObjects.add(input);
      for (const [key, value] of Object.entries(input)) {
        if (typeof value === "object" && value !== null) {
          flatten(value, result, [...prefix, key], traversedObjects);
        } else {
          result.push({ name: [...prefix, key].join("."), value });
        }
      }
      return result;
    }
    function appStarted() {
      return {
        integrations: getIntegrations(),
        dependencies: [],
        configuration: flatten(config),
        additional_payload: []
      };
    }
    function onBeforeExit() {
      process.removeListener("beforeExit", onBeforeExit);
      sendData(config, application, host, "app-closing");
    }
    function createAppObject() {
      return {
        service_name: config.service,
        env: config.env,
        service_version: config.version,
        tracer_version: tracerVersion,
        language_name: "nodejs",
        language_version: process.versions.node
      };
    }
    function createHostObject() {
      const osName = os.type();
      if (osName === "Linux" || osName === "Darwin") {
        return {
          hostname: os.hostname(),
          os: osName,
          architecture: os.arch(),
          kernel_version: os.version(),
          kernel_release: os.release(),
          kernel_name: osName
        };
      }
      if (osName === "Windows_NT") {
        return {
          hostname: os.hostname(),
          os: osName,
          architecture: os.arch(),
          os_version: os.version()
        };
      }
      return {
        hostname: os.hostname(),
        // TODO is this enough?
        os: osName
      };
    }
    function getTelemetryData() {
      return { config, application, host, heartbeatInterval: HEARTBEAT_INTERVAL };
    }
    function start(aConfig, thePluginManager) {
      if (!aConfig.telemetry.enabled) {
        return;
      }
      config = aConfig;
      pluginManager = thePluginManager;
      application = createAppObject();
      host = createHostObject();
      dependencies.start(config, application, host);
      sendData(config, application, host, "app-started", appStarted());
      interval = setInterval(() => {
        sendData(config, application, host, "app-heartbeat");
      }, HEARTBEAT_INTERVAL);
      interval.unref();
      process.on("beforeExit", onBeforeExit);
      telemetryStartChannel.publish(getTelemetryData());
    }
    function stop() {
      if (!config) {
        return;
      }
      clearInterval(interval);
      process.removeListener("beforeExit", onBeforeExit);
      telemetryStopChannel.publish(getTelemetryData());
      config = void 0;
    }
    function updateIntegrations() {
      if (!config || !config.telemetry.enabled) {
        return;
      }
      const integrations = getIntegrations();
      if (integrations.length === 0) {
        return;
      }
      sendData(config, application, host, "app-integrations-change", { integrations });
    }
    module2.exports = {
      start,
      stop,
      updateIntegrations
    };
  }
});

// packages/dd-trace/src/plugins/index.js
var require_plugins = __commonJS({
  "packages/dd-trace/src/plugins/index.js"(exports2, module2) {
    "use strict";
    module2.exports = {
      // get '@aws-sdk/smithy-client' () { return require('../../../datadog-plugin-aws-sdk/src') },
      // get '@cucumber/cucumber' () { return require('../../../datadog-plugin-cucumber/src') },
      // get '@playwright/test' () { return require('../../../datadog-plugin-playwright/src') },
      // get '@elastic/elasticsearch' () { return require('../../../datadog-plugin-elasticsearch/src') },
      // get '@elastic/transport' () { return require('../../../datadog-plugin-elasticsearch/src') },
      // get '@google-cloud/pubsub' () { return require('../../../datadog-plugin-google-cloud-pubsub/src') },
      // get '@grpc/grpc-js' () { return require('../../../datadog-plugin-grpc/src') },
      // get '@hapi/hapi' () { return require('../../../datadog-plugin-hapi/src') },
      // get '@jest/core' () { return require('../../../datadog-plugin-jest/src') },
      // get '@koa/router' () { return require('../../../datadog-plugin-koa/src') },
      // get '@node-redis/client' () { return require('../../../datadog-plugin-redis/src') },
      // get '@opensearch-project/opensearch' () { return require('../../../datadog-plugin-opensearch/src') },
      // get '@redis/client' () { return require('../../../datadog-plugin-redis/src') },
      // get 'amqp10' () { return require('../../../datadog-plugin-amqp10/src') },
      // get 'amqplib' () { return require('../../../datadog-plugin-amqplib/src') },
      // get 'aws-sdk' () { return require('../../../datadog-plugin-aws-sdk/src') },
      // get 'bunyan' () { return require('../../../datadog-plugin-bunyan/src') },
      // get 'cassandra-driver' () { return require('../../../datadog-plugin-cassandra-driver/src') },
      // get 'connect' () { return require('../../../datadog-plugin-connect/src') },
      // get 'couchbase' () { return require('../../../datadog-plugin-couchbase/src') },
      // get 'cypress' () { return require('../../../datadog-plugin-cypress/src') },
      // get 'dns' () { return require('../../../datadog-plugin-dns/src') },
      // get 'elasticsearch' () { return require('../../../datadog-plugin-elasticsearch/src') },
      // get 'express' () { return require('../../../datadog-plugin-express/src') },
      // get 'fastify' () { return require('../../../datadog-plugin-fastify/src') },
      // get 'find-my-way' () { return require('../../../datadog-plugin-find-my-way/src') },
      // get 'graphql' () { return require('../../../datadog-plugin-graphql/src') },
      // get 'grpc' () { return require('../../../datadog-plugin-grpc/src') },
      // get 'hapi' () { return require('../../../datadog-plugin-hapi/src') },
      // get 'http' () { return require('../../../datadog-plugin-http/src') },
      // get 'http2' () { return require('../../../datadog-plugin-http2/src') },
      // get 'https' () { return require('../../../datadog-plugin-http/src') },
      // get 'ioredis' () { return require('../../../datadog-plugin-ioredis/src') },
      // get 'jest-circus' () { return require('../../../datadog-plugin-jest/src') },
      // get 'jest-config' () { return require('../../../datadog-plugin-jest/src') },
      // get 'jest-environment-node' () { return require('../../../datadog-plugin-jest/src') },
      // get 'jest-environment-jsdom' () { return require('../../../datadog-plugin-jest/src') },
      // get 'jest-jasmine2' () { return require('../../../datadog-plugin-jest/src') },
      // get 'jest-worker' () { return require('../../../datadog-plugin-jest/src') },
      // get 'koa' () { return require('../../../datadog-plugin-koa/src') },
      // get 'koa-router' () { return require('../../../datadog-plugin-koa/src') },
      // get 'kafkajs' () { return require('../../../datadog-plugin-kafkajs/src') },
      // get 'mariadb' () { return require('../../../datadog-plugin-mariadb/src') },
      // get 'memcached' () { return require('../../../datadog-plugin-memcached/src') },
      // get 'microgateway-core' () { return require('../../../datadog-plugin-microgateway-core/src') },
      // get 'mocha' () { return require('../../../datadog-plugin-mocha/src') },
      // get 'mocha-each' () { return require('../../../datadog-plugin-mocha/src') },
      // get 'moleculer' () { return require('../../../datadog-plugin-moleculer/src') },
      // get 'mongodb' () { return require('../../../datadog-plugin-mongodb-core/src') },
      // get 'mongodb-core' () { return require('../../../datadog-plugin-mongodb-core/src') },
      // get 'mysql' () { return require('../../../datadog-plugin-mysql/src') },
      // get 'mysql2' () { return require('../../../datadog-plugin-mysql2/src') },
      // get 'net' () { return require('../../../datadog-plugin-net/src') },
      // get 'next' () { return require('../../../datadog-plugin-next/src') },
      // get 'oracledb' () { return require('../../../datadog-plugin-oracledb/src') },
      // get 'paperplane' () { return require('../../../datadog-plugin-paperplane/src') },
      // get 'pg' () { return require('../../../datadog-plugin-pg/src') },
      // get 'pino' () { return require('../../../datadog-plugin-pino/src') },
      // get 'pino-pretty' () { return require('../../../datadog-plugin-pino/src') },
      // get 'redis' () { return require('../../../datadog-plugin-redis/src') },
      // get 'restify' () { return require('../../../datadog-plugin-restify/src') },
      // get 'rhea' () { return require('../../../datadog-plugin-rhea/src') },
      // get 'router' () { return require('../../../datadog-plugin-router/src') },
      // get 'sharedb' () { return require('../../../datadog-plugin-sharedb/src') },
      // get 'tedious' () { return require('../../../datadog-plugin-tedious/src') },
      // get 'winston' () { return require('../../../datadog-plugin-winston/src') }
    };
  }
});

// packages/dd-trace/src/iitm.js
var require_iitm = __commonJS({
  "packages/dd-trace/src/iitm.js"(exports2, module2) {
    "use strict";
    var semver = require("semver");
    var logger = require_log();
    var { addHook } = require("import-in-the-middle");
    var dc = require_diagnostics_channel();
    if (semver.satisfies(process.versions.node, ">=14.13.1")) {
      const moduleLoadStartChannel = dc.channel("dd-trace:moduleLoadStart");
      addHook((name, namespace) => {
        if (moduleLoadStartChannel.hasSubscribers) {
          moduleLoadStartChannel.publish({
            filename: name,
            module: namespace
          });
        }
      });
      module2.exports = require("import-in-the-middle");
    } else {
      logger.warn("ESM is not fully supported by this version of Node.js, so dd-trace will not intercept ESM loading.");
      module2.exports = () => ({
        unhook: () => {
        }
      });
      module2.exports.addHook = () => {
      };
      module2.exports.removeHook = () => {
      };
    }
  }
});

// packages/dd-trace/src/ritm.js
var require_ritm = __commonJS({
  "packages/dd-trace/src/ritm.js"(exports2, module2) {
    "use strict";
    var path = require("path");
    var Module = require("module");
    var parse = require("module-details-from-path");
    var dc = require_diagnostics_channel();
    var origRequire = Module.prototype.require;
    module2.exports = Hook;
    var moduleHooks = /* @__PURE__ */ Object.create(null);
    var cache = /* @__PURE__ */ Object.create(null);
    var patching = /* @__PURE__ */ Object.create(null);
    var patchedRequire = null;
    var moduleLoadStartChannel = dc.channel("dd-trace:moduleLoadStart");
    var moduleLoadEndChannel = dc.channel("dd-trace:moduleLoadEnd");
    function Hook(modules, options, onrequire) {
      if (!(this instanceof Hook))
        return new Hook(modules, options, onrequire);
      if (typeof modules === "function") {
        onrequire = modules;
        modules = null;
        options = {};
      } else if (typeof options === "function") {
        onrequire = options;
        options = {};
      }
      modules = modules || [];
      options = options || {};
      this.modules = modules;
      this.options = options;
      this.onrequire = onrequire;
      if (Array.isArray(modules)) {
        for (const mod of modules) {
          const hooks = moduleHooks[mod];
          if (hooks) {
            hooks.push(onrequire);
          } else {
            moduleHooks[mod] = [onrequire];
          }
        }
      }
      if (patchedRequire)
        return;
      patchedRequire = Module.prototype.require = function(request) {
        const filename = Module._resolveFilename(request, this);
        const core = filename.indexOf(path.sep) === -1;
        let name, basedir, hooks;
        if (cache[filename]) {
          if (require.cache[filename] && require.cache[filename].exports !== cache[filename].original) {
            return require.cache[filename].exports;
          }
          return cache[filename].exports;
        }
        const patched = patching[filename];
        if (patched) {
          return origRequire.apply(this, arguments);
        } else {
          patching[filename] = true;
        }
        const payload = {
          filename,
          request
        };
        if (moduleLoadStartChannel.hasSubscribers) {
          moduleLoadStartChannel.publish(payload);
        }
        const exports3 = origRequire.apply(this, arguments);
        payload.module = exports3;
        if (moduleLoadEndChannel.hasSubscribers) {
          moduleLoadEndChannel.publish(payload);
        }
        delete patching[filename];
        if (core) {
          hooks = moduleHooks[filename];
          if (!hooks)
            return exports3;
          name = filename;
        } else {
          const inAWSLambda = process.env.AWS_LAMBDA_FUNCTION_NAME !== void 0;
          const hasLambdaHandler = process.env.DD_LAMBDA_HANDLER !== void 0;
          const segments = filename.split(path.sep);
          const filenameFromNodeModule = segments.lastIndexOf("node_modules") !== -1;
          const stat = inAWSLambda && hasLambdaHandler && !filenameFromNodeModule ? { name: filename } : parse(filename);
          if (!stat)
            return exports3;
          name = stat.name;
          basedir = stat.basedir;
          hooks = moduleHooks[name];
          if (!hooks)
            return exports3;
          const paths = Module._resolveLookupPaths(name, this, true);
          if (!paths) {
            return exports3;
          }
          const res = Module._findPath(name, [basedir, ...paths]);
          if (res !== filename) {
            name = name + path.sep + path.relative(basedir, filename);
          }
        }
        cache[filename] = { exports: exports3 };
        cache[filename].original = exports3;
        for (const hook of hooks) {
          cache[filename].exports = hook(cache[filename].exports, name, basedir);
        }
        return cache[filename].exports;
      };
    }
    Hook.reset = function() {
      Module.prototype.require = origRequire;
      patchedRequire = null;
      patching = /* @__PURE__ */ Object.create(null);
      cache = /* @__PURE__ */ Object.create(null);
      moduleHooks = /* @__PURE__ */ Object.create(null);
    };
    Hook.prototype.unhook = function() {
      for (const mod of this.modules) {
        const hooks = (moduleHooks[mod] || []).filter((hook) => hook !== this.onrequire);
        if (hooks.length > 0) {
          moduleHooks[mod] = hooks;
        } else {
          delete moduleHooks[mod];
        }
      }
      if (Object.keys(moduleHooks).length === 0) {
        Hook.reset();
      }
    };
  }
});

// packages/dd-trace/src/dcitm.js
var require_dcitm = __commonJS({
  "packages/dd-trace/src/dcitm.js"(exports2, module2) {
    "use strict";
    var dc = require("diagnostics_channel");
    var CHANNEL_PREFIX = "dd-trace:bundledModuleLoadStart";
    if (!dc.subscribe) {
      dc.subscribe = (channel, cb) => {
        dc.channel(channel).subscribe(cb);
      };
    }
    if (!dc.unsubscribe) {
      dc.unsubscribe = (channel, cb) => {
        if (dc.channel(channel).hasSubscribers) {
          dc.channel(channel).unsubscribe(cb);
        }
      };
    }
    module2.exports = DcitmHook;
    function DcitmHook(moduleNames, options, onrequire) {
      if (!(this instanceof DcitmHook))
        return new DcitmHook(moduleNames, options, onrequire);
      function onModuleLoad(payload) {
        payload.module = onrequire(payload.module, payload.path, void 0, payload.version);
      }
      for (const moduleName of moduleNames) {
        dc.subscribe(`${CHANNEL_PREFIX}:${moduleName}`, onModuleLoad);
      }
      this.unhook = function dcitmUnload() {
        for (const moduleName of moduleNames) {
          dc.unsubscribe(`${CHANNEL_PREFIX}:${moduleName}`, onModuleLoad);
        }
      };
    }
  }
});

// packages/datadog-instrumentations/src/helpers/hook.js
var require_hook = __commonJS({
  "packages/datadog-instrumentations/src/helpers/hook.js"(exports2, module2) {
    "use strict";
    var path = require("path");
    var iitm = require_iitm();
    var ritm = require_ritm();
    var dcitm = require_dcitm();
    function Hook(modules, onrequire) {
      if (!(this instanceof Hook))
        return new Hook(modules, onrequire);
      this._patched = /* @__PURE__ */ Object.create(null);
      const safeHook = (moduleExports, moduleName, moduleBaseDir, moduleVersion) => {
        const parts = [moduleBaseDir, moduleName].filter((v) => v);
        const filename = path.join(...parts);
        if (this._patched[filename])
          return moduleExports;
        this._patched[filename] = true;
        return onrequire(moduleExports, moduleName, moduleBaseDir, moduleVersion);
      };
      this._ritmHook = ritm(modules, {}, safeHook);
      this._iitmHook = iitm(modules, {}, (moduleExports, moduleName, moduleBaseDir) => {
        if (moduleExports && moduleExports.default) {
          moduleExports.default = safeHook(moduleExports.default, moduleName, moduleBaseDir);
          return moduleExports;
        } else {
          return safeHook(moduleExports, moduleName, moduleBaseDir);
        }
      });
      this._dcitmHook = dcitm(modules, {}, safeHook);
    }
    Hook.prototype.unhook = function() {
      this._ritmHook.unhook();
      this._iitmHook.unhook();
      this._dcitmHook.unhook();
      this._patched = /* @__PURE__ */ Object.create(null);
    };
    module2.exports = Hook;
  }
});

// packages/datadog-instrumentations/src/helpers/hooks.js
var require_hooks = __commonJS({
  "packages/datadog-instrumentations/src/helpers/hooks.js"(exports2, module2) {
    "use strict";
    module2.exports = {
      // '@aws-sdk/smithy-client': () => require('../aws-sdk'),
      // '@cucumber/cucumber': () => require('../cucumber'),
      // '@playwright/test': () => require('../playwright'),
      // '@elastic/elasticsearch': () => require('../elasticsearch'),
      // '@elastic/transport': () => require('../elasticsearch'),
      // '@google-cloud/pubsub': () => require('../google-cloud-pubsub'),
      // '@grpc/grpc-js': () => require('../grpc'),
      // '@hapi/hapi': () => require('../hapi'),
      // '@jest/core': () => require('../jest'),
      // '@jest/reporters': () => require('../jest'),
      // '@koa/router': () => require('../koa'),
      // '@node-redis/client': () => require('../redis'),
      // '@opensearch-project/opensearch': () => require('../opensearch'),
      // '@redis/client': () => require('../redis'),
      // 'amqp10': () => require('../amqp10'),
      // 'amqplib': () => require('../amqplib'),
      // 'aws-sdk': () => require('../aws-sdk'),
      // 'bluebird': () => require('../bluebird'),
      // 'body-parser': () => require('../body-parser'),
      // 'bunyan': () => require('../bunyan'),
      // 'cassandra-driver': () => require('../cassandra-driver'),
      // 'child_process': () => require('../child-process'),
      // 'node:child_process': () => require('../child-process'),
      // 'connect': () => require('../connect'),
      // 'couchbase': () => require('../couchbase'),
      // 'crypto': () => require('../crypto'),
      // 'cypress': () => require('../cypress'),
      // 'dns': () => require('../dns'),
      // 'elasticsearch': () => require('../elasticsearch'),
      // 'express': () => require('../express'),
      // 'fastify': () => require('../fastify'),
      // 'find-my-way': () => require('../find-my-way'),
      // 'fs': () => require('../fs'),
      // 'node:fs': () => require('../fs'),
      // 'graphql': () => require('../graphql'),
      // 'grpc': () => require('../grpc'),
      // 'hapi': () => require('../hapi'),
      // 'http': () => require('../http'),
      // 'http2': () => require('../http2'),
      // 'https': () => require('../http'),
      // 'ioredis': () => require('../ioredis'),
      // 'jest-circus': () => require('../jest'),
      // 'jest-config': () => require('../jest'),
      // 'jest-environment-node': () => require('../jest'),
      // 'jest-environment-jsdom': () => require('../jest'),
      // 'jest-jasmine2': () => require('../jest'),
      // 'jest-worker': () => require('../jest'),
      // 'koa': () => require('../koa'),
      // 'koa-router': () => require('../koa'),
      // 'kafkajs': () => require('../kafkajs'),
      // 'ldapjs': () => require('../ldapjs'),
      // 'limitd-client': () => require('../limitd-client'),
      // 'mariadb': () => require('../mariadb'),
      // 'memcached': () => require('../memcached'),
      // 'microgateway-core': () => require('../microgateway-core'),
      // 'mocha': () => require('../mocha'),
      // 'mocha-each': () => require('../mocha'),
      // 'moleculer': () => require('../moleculer'),
      // 'mongodb': () => require('../mongodb-core'),
      // 'mongodb-core': () => require('../mongodb-core'),
      // 'mongoose': () => require('../mongoose'),
      // 'mysql': () => require('../mysql'),
      // 'mysql2': () => require('../mysql2'),
      // 'net': () => require('../net'),
      // 'next': () => require('../next'),
      // 'oracledb': () => require('../oracledb'),
      // 'paperplane': () => require('../paperplane'),
      // 'pg': () => require('../pg'),
      // 'pino': () => require('../pino'),
      // 'pino-pretty': () => require('../pino'),
      // 'promise-js': () => require('../promise-js'),
      // 'promise': () => require('../promise'),
      // 'q': () => require('../q'),
      // 'qs': () => require('../qs'),
      // 'redis': () => require('../redis'),
      // 'restify': () => require('../restify'),
      // 'rhea': () => require('../rhea'),
      // 'router': () => require('../router'),
      // 'sharedb': () => require('../sharedb'),
      // 'tedious': () => require('../tedious'),
      // 'when': () => require('../when'),
      // 'winston': () => require('../winston')
    };
  }
});

// packages/datadog-instrumentations/src/helpers/instrumentations.js
var require_instrumentations = __commonJS({
  "packages/datadog-instrumentations/src/helpers/instrumentations.js"(exports2, module2) {
    "use strict";
    var sym = Symbol.for("_ddtrace_instrumentations");
    global[sym] = global[sym] || {};
    module2.exports = global[sym];
  }
});

// packages/datadog-instrumentations/src/helpers/register.js
var require_register = __commonJS({
  "packages/datadog-instrumentations/src/helpers/register.js"(exports2, module2) {
    "use strict";
    var { channel } = require_diagnostics_channel();
    var path = require("path");
    var semver = require("semver");
    var Hook = require_hook();
    var requirePackageJson = require_require_package_json();
    var log = require_log();
    var hooks = require_hooks();
    var instrumentations = require_instrumentations();
    var names = Object.keys(hooks);
    var pathSepExpr = new RegExp(`\\${path.sep}`, "g");
    var loadChannel = channel("dd-trace:instrumentation:load");
    for (const packageName of names) {
      Hook([packageName], (moduleExports, moduleName, moduleBaseDir, moduleVersion) => {
        moduleName = moduleName.replace(pathSepExpr, "/");
        hooks[packageName]();
        for (const { name, file, versions, hook } of instrumentations[packageName]) {
          const fullFilename = filename(name, file);
          if (moduleName === fullFilename) {
            const version = moduleVersion || getVersion(moduleBaseDir);
            if (matchVersion(version, versions)) {
              try {
                loadChannel.publish({ name, version, file });
                moduleExports = hook(moduleExports, version);
              } catch (e) {
                log.error(e);
              }
            }
          }
        }
        return moduleExports;
      });
    }
    function matchVersion(version, ranges) {
      return !version || ranges && ranges.some((range) => semver.satisfies(semver.coerce(version), range));
    }
    function getVersion(moduleBaseDir) {
      if (moduleBaseDir) {
        return requirePackageJson(moduleBaseDir, module2).version;
      }
    }
    function filename(name, file) {
      return [name, file].filter((val) => val).join("/");
    }
    module2.exports = {
      filename,
      pathSepExpr
    };
  }
});

// packages/datadog-instrumentations/index.js
var require_datadog_instrumentations = __commonJS({
  "packages/datadog-instrumentations/index.js"() {
    "use strict";
    require_register();
  }
});

// packages/datadog-instrumentations/src/helpers/instrument.js
var require_instrument = __commonJS({
  "packages/datadog-instrumentations/src/helpers/instrument.js"(exports2) {
    "use strict";
    var dc = require_diagnostics_channel();
    var semver = require("semver");
    var instrumentations = require_instrumentations();
    var { AsyncResource } = require("async_hooks");
    var channelMap = {};
    exports2.channel = function(name) {
      const maybe = channelMap[name];
      if (maybe)
        return maybe;
      const ch = dc.channel(name);
      channelMap[name] = ch;
      return ch;
    };
    exports2.addHook = function addHook({ name, versions, file }, hook) {
      if (!instrumentations[name]) {
        instrumentations[name] = [];
      }
      instrumentations[name].push({ name, versions, file, hook });
    };
    if (semver.satisfies(process.versions.node, ">=17.8.0")) {
      exports2.AsyncResource = AsyncResource;
    } else {
      exports2.AsyncResource = class extends AsyncResource {
        static bind(fn, type, thisArg) {
          type = type || fn.name;
          return new exports2.AsyncResource(type || "bound-anonymous-fn").bind(fn, thisArg);
        }
        bind(fn, thisArg) {
          let bound;
          if (thisArg === void 0) {
            const resource = this;
            bound = function(...args) {
              args.unshift(fn, this);
              return Reflect.apply(resource.runInAsyncScope, resource, args);
            };
          } else {
            bound = this.runInAsyncScope.bind(this, fn, thisArg);
          }
          Object.defineProperties(bound, {
            "length": {
              configurable: true,
              enumerable: false,
              value: fn.length,
              writable: false
            },
            "asyncResource": {
              configurable: true,
              enumerable: true,
              value: this,
              writable: true
            }
          });
          return bound;
        }
      };
    }
  }
});

// packages/dd-trace/src/lambda/runtime/errors.js
var require_errors = __commonJS({
  "packages/dd-trace/src/lambda/runtime/errors.js"(exports2, module2) {
    "use strict";
    var ExtendedError = class extends Error {
      constructor(reason) {
        super(reason);
        Object.setPrototypeOf(this, new.target.prototype);
      }
    };
    var ImpendingTimeout = class extends ExtendedError {
    };
    ImpendingTimeout.prototype.name = "Impending Timeout";
    module2.exports = {
      ImpendingTimeout
    };
  }
});

// packages/dd-trace/src/lambda/handler.js
var require_handler = __commonJS({
  "packages/dd-trace/src/lambda/handler.js"(exports2) {
    "use strict";
    var log = require_log();
    var { channel } = require_instrument();
    var { ERROR_MESSAGE, ERROR_TYPE } = require_constants();
    var { ImpendingTimeout } = require_errors();
    var globalTracer = global._ddtrace;
    var tracer = globalTracer._tracer;
    var timeoutChannel = channel("apm:aws:lambda:timeout");
    timeoutChannel.subscribe((_) => {
      crashFlush();
    });
    var __lambdaTimeout;
    function checkTimeout(context) {
      const remainingTimeInMillis = context.getRemainingTimeInMillis();
      let apmFlushDeadline = parseInt(process.env.DD_APM_FLUSH_DEADLINE_MILLISECONDS) || 100;
      apmFlushDeadline = apmFlushDeadline < 0 ? 100 : apmFlushDeadline;
      __lambdaTimeout = setTimeout(() => {
        timeoutChannel.publish(void 0);
      }, remainingTimeInMillis - apmFlushDeadline);
    }
    function crashFlush() {
      const activeSpan = tracer.scope().active();
      if (activeSpan !== null) {
        const error = new ImpendingTimeout("Datadog detected an impending timeout");
        activeSpan.addTags({
          [ERROR_MESSAGE]: error.message,
          [ERROR_TYPE]: error.name
        });
      } else {
        log.debug("An impending timeout was reached, but no root span was found. No error will be tagged.");
      }
      tracer._processor.killAll();
      if (activeSpan !== null) {
        activeSpan.finish();
      }
    }
    function extractContext(args) {
      let context = args.length > 1 ? args[1] : void 0;
      if (context === void 0 || context.getRemainingTimeInMillis === void 0) {
        context = args.length > 2 ? args[2] : void 0;
        if (context === void 0 || context.getRemainingTimeInMillis === void 0) {
          throw Error("Could not extract context");
        }
      }
      return context;
    }
    exports2.datadog = function datadog(lambdaHandler) {
      return (...args) => {
        const patched = lambdaHandler.apply(this, args);
        try {
          const context = extractContext(args);
          checkTimeout(context);
          if (patched) {
            patched.then((_) => clearTimeout(__lambdaTimeout));
          }
        } catch (e) {
          log.debug("Error patching AWS Lambda handler. Timeout spans will not be generated.");
        }
        return patched;
      };
    };
  }
});

// packages/datadog-shimmer/src/shimmer.js
var require_shimmer = __commonJS({
  "packages/datadog-shimmer/src/shimmer.js"(exports2, module2) {
    "use strict";
    var unwrappers = /* @__PURE__ */ new WeakMap();
    function copyProperties(original, wrapped) {
      Object.setPrototypeOf(wrapped, original);
      const props = Object.getOwnPropertyDescriptors(original);
      const keys = Reflect.ownKeys(props);
      for (const key of keys) {
        try {
          Object.defineProperty(wrapped, key, props[key]);
        } catch (e) {
        }
      }
    }
    function wrapFn(original, delegate) {
      assertFunction(delegate);
      assertNotClass(original);
      const shim = function shim2() {
        return delegate.apply(this, arguments);
      };
      unwrappers.set(shim, () => {
        delegate = original;
      });
      copyProperties(original, shim);
      return shim;
    }
    function wrapMethod(target, name, wrapper) {
      assertMethod(target, name);
      assertFunction(wrapper);
      const original = target[name];
      const wrapped = wrapper(original);
      const descriptor = Object.getOwnPropertyDescriptor(target, name);
      const attributes = {
        configurable: true,
        ...descriptor
      };
      copyProperties(original, wrapped);
      if (descriptor) {
        unwrappers.set(wrapped, () => Object.defineProperty(target, name, descriptor));
        if (descriptor.get || descriptor.set) {
          attributes.get = () => wrapped;
        } else {
          attributes.value = wrapped;
        }
        if (descriptor.configurable === false) {
          return Object.create(target, {
            [name]: attributes
          });
        }
      } else {
        unwrappers.set(wrapped, () => delete target[name]);
        attributes.value = wrapped;
        attributes.writable = true;
      }
      Object.defineProperty(target, name, attributes);
      return target;
    }
    function wrap(target, name, wrapper) {
      return typeof name === "function" ? wrapFn(target, name) : wrapMethod(target, name, wrapper);
    }
    function unwrap(target, name) {
      if (!target)
        return target;
      const unwrapper = unwrappers.get(name ? target[name] : target);
      if (!unwrapper)
        return target;
      unwrapper();
      return target;
    }
    function massWrap(targets, names, wrapper) {
      targets = toArray(targets);
      names = toArray(names);
      for (const target of targets) {
        for (const name of names) {
          wrap(target, name, wrapper);
        }
      }
    }
    function massUnwrap(targets, names) {
      targets = toArray(targets);
      names = toArray(names);
      for (const target of targets) {
        for (const name of names) {
          unwrap(target, name);
        }
      }
    }
    function toArray(maybeArray) {
      return Array.isArray(maybeArray) ? maybeArray : [maybeArray];
    }
    function assertMethod(target, name) {
      if (!target) {
        throw new Error("No target object provided.");
      }
      if (typeof target !== "object" && typeof target !== "function") {
        throw new Error("Invalid target.");
      }
      if (!target[name]) {
        throw new Error(`No original method ${name}.`);
      }
      if (typeof target[name] !== "function") {
        throw new Error(`Original method ${name} is not a function.`);
      }
    }
    function assertFunction(target) {
      if (!target) {
        throw new Error("No function provided.");
      }
      if (typeof target !== "function") {
        throw new Error("Target is not a function.");
      }
    }
    function assertNotClass(target) {
      if (Function.prototype.toString.call(target).startsWith("class")) {
        throw new Error("Target is a native class constructor and cannot be wrapped.");
      }
    }
    module2.exports = {
      wrap,
      massWrap,
      unwrap,
      massUnwrap
    };
  }
});

// packages/datadog-shimmer/index.js
var require_datadog_shimmer = __commonJS({
  "packages/datadog-shimmer/index.js"(exports2, module2) {
    "use strict";
    module2.exports = require_shimmer();
  }
});

// packages/dd-trace/src/lambda/runtime/patch.js
var require_patch = __commonJS({
  "packages/dd-trace/src/lambda/runtime/patch.js"() {
    "use strict";
    var path = require("path");
    var { _extractModuleNameAndHandlerPath, _extractModuleRootAndHandler, _getLambdaFilePath } = require_ritm2();
    var { datadog } = require_handler();
    var { addHook } = require_instrument();
    var shimmer = require_datadog_shimmer();
    var patchDatadogLambdaModule = (datadogLambdaModule) => {
      shimmer.wrap(datadogLambdaModule, "datadog", patchDatadogLambdaHandler);
      return datadogLambdaModule;
    };
    function patchDatadogLambdaHandler(datadogHandler) {
      return (userHandler) => {
        return datadogHandler(datadog(userHandler));
      };
    }
    var patchLambdaModule = (handlerPath) => (lambdaModule) => {
      shimmer.wrap(lambdaModule, handlerPath, patchLambdaHandler);
      return lambdaModule;
    };
    function patchLambdaHandler(lambdaHandler) {
      return datadog(lambdaHandler);
    }
    var lambdaTaskRoot = process.env.LAMBDA_TASK_ROOT;
    var originalLambdaHandler = process.env.DD_LAMBDA_HANDLER;
    if (originalLambdaHandler !== void 0) {
      const [moduleRoot, moduleAndHandler] = _extractModuleRootAndHandler(originalLambdaHandler);
      const [_module, handlerPath] = _extractModuleNameAndHandlerPath(moduleAndHandler);
      const lambdaStylePath = path.resolve(lambdaTaskRoot, moduleRoot, _module);
      const lambdaFilePath = _getLambdaFilePath(lambdaStylePath);
      addHook({ name: lambdaFilePath }, patchLambdaModule(handlerPath));
    } else {
      addHook({ name: "datadog-lambda-js" }, patchDatadogLambdaModule);
    }
  }
});

// packages/dd-trace/src/lambda/runtime/ritm.js
var require_ritm2 = __commonJS({
  "packages/dd-trace/src/lambda/runtime/ritm.js"(exports2, module2) {
    "use strict";
    var fs = require("fs");
    var path = require("path");
    var log = require_log();
    var Hook = require_hook();
    var instrumentations = require_instrumentations();
    var {
      filename,
      pathSepExpr
    } = require_register();
    function _extractModuleRootAndHandler(fullHandler) {
      const handlerString = path.basename(fullHandler);
      const moduleRoot = fullHandler.substring(0, fullHandler.indexOf(handlerString));
      return [moduleRoot, handlerString];
    }
    function _extractModuleNameAndHandlerPath(handler) {
      const FUNCTION_EXPR = /^([^.]*)\.(.*)$/;
      const match = handler.match(FUNCTION_EXPR);
      if (!match || match.length !== 3) {
        return;
      }
      return [match[1], match[2]];
    }
    function _getLambdaFilePath(lambdaStylePath) {
      let lambdaFilePath = lambdaStylePath;
      if (fs.existsSync(lambdaStylePath + ".js")) {
        lambdaFilePath += ".js";
      } else if (fs.existsSync(lambdaStylePath + ".mjs")) {
        lambdaFilePath += ".mjs";
      } else if (fs.existsSync(lambdaStylePath + ".cjs")) {
        lambdaFilePath += ".cjs";
      }
      return lambdaFilePath;
    }
    var registerLambdaHook = () => {
      const lambdaTaskRoot = process.env.LAMBDA_TASK_ROOT;
      const originalLambdaHandler = process.env.DD_LAMBDA_HANDLER;
      if (originalLambdaHandler !== void 0) {
        const [moduleRoot, moduleAndHandler] = _extractModuleRootAndHandler(originalLambdaHandler);
        const [_module] = _extractModuleNameAndHandlerPath(moduleAndHandler);
        const lambdaStylePath = path.resolve(lambdaTaskRoot, moduleRoot, _module);
        const lambdaFilePath = _getLambdaFilePath(lambdaStylePath);
        Hook([lambdaFilePath], (moduleExports) => {
          require_patch();
          for (const { hook } of instrumentations[lambdaFilePath]) {
            try {
              moduleExports = hook(moduleExports);
            } catch (e) {
              log.error(e);
            }
          }
          return moduleExports;
        });
      } else {
        const moduleToPatch = "datadog-lambda-js";
        Hook([moduleToPatch], (moduleExports, moduleName, _) => {
          moduleName = moduleName.replace(pathSepExpr, "/");
          require_patch();
          for (const { name, file, hook } of instrumentations[moduleToPatch]) {
            const fullFilename = filename(name, file);
            if (moduleName === fullFilename) {
              try {
                moduleExports = hook(moduleExports);
              } catch (e) {
                log.error(e);
              }
            }
          }
          return moduleExports;
        });
      }
    };
    module2.exports = {
      _extractModuleRootAndHandler,
      _extractModuleNameAndHandlerPath,
      _getLambdaFilePath,
      registerLambdaHook
    };
  }
});

// packages/dd-trace/src/lambda/index.js
var require_lambda = __commonJS({
  "packages/dd-trace/src/lambda/index.js"() {
    "use strict";
    var { registerLambdaHook } = require_ritm2();
    registerLambdaHook();
  }
});

// packages/dd-trace/src/plugin_manager.js
var require_plugin_manager = __commonJS({
  "packages/dd-trace/src/plugin_manager.js"(exports2, module2) {
    "use strict";
    var { channel } = require_diagnostics_channel();
    var { isFalse } = require_util();
    var plugins = require_plugins();
    var log = require_log();
    var loadChannel = channel("dd-trace:instrumentation:load");
    require_datadog_instrumentations();
    if (process.env.AWS_LAMBDA_FUNCTION_NAME !== void 0) {
      require_lambda();
    }
    var { DD_TRACE_DISABLED_PLUGINS } = process.env;
    var disabledPlugins = new Set(
      DD_TRACE_DISABLED_PLUGINS && DD_TRACE_DISABLED_PLUGINS.split(",").map((plugin) => plugin.trim())
    );
    var pluginClasses = {};
    loadChannel.subscribe(({ name }) => {
      const Plugin = plugins[name];
      if (!Plugin || typeof Plugin !== "function")
        return;
      if (!pluginClasses[Plugin.id]) {
        const envName = `DD_TRACE_${Plugin.id.toUpperCase()}_ENABLED`;
        const enabled = process.env[envName.replace(/[^a-z0-9_]/ig, "_")];
        if (isFalse(enabled) || disabledPlugins.has(Plugin.id)) {
          log.debug(`Plugin "${Plugin.id}" was disabled via configuration option.`);
          pluginClasses[Plugin.id] = null;
        } else {
          pluginClasses[Plugin.id] = Plugin;
        }
      }
    });
    module2.exports = class PluginManager {
      constructor(tracer) {
        this._tracer = tracer;
        this._tracerConfig = null;
        this._pluginsByName = {};
        this._configsByName = {};
        this._loadedSubscriber = ({ name }) => {
          const Plugin = plugins[name];
          if (!Plugin || typeof Plugin !== "function")
            return;
          this.loadPlugin(Plugin.id);
        };
        loadChannel.subscribe(this._loadedSubscriber);
      }
      loadPlugin(name) {
        const Plugin = pluginClasses[name];
        if (!Plugin)
          return;
        if (!this._pluginsByName[name]) {
          this._pluginsByName[name] = new Plugin(this._tracer);
        }
        if (!this._tracerConfig)
          return;
        const pluginConfig = this._configsByName[name] || {
          enabled: this._tracerConfig.plugins !== false
        };
        this._pluginsByName[name].configure({
          ...this._getSharedConfig(name),
          ...pluginConfig
        });
      }
      // TODO: merge config instead of replacing
      configurePlugin(name, pluginConfig) {
        const enabled = this._isEnabled(pluginConfig);
        this._configsByName[name] = {
          ...pluginConfig,
          enabled
        };
        this.loadPlugin(name);
      }
      // like instrumenter.enable()
      configure(config = {}) {
        this._tracerConfig = config;
        for (const name in pluginClasses) {
          this.loadPlugin(name);
        }
      }
      // This is basically just for testing. like intrumenter.disable()
      destroy() {
        for (const name in this._pluginsByName) {
          this._pluginsByName[name].configure({ enabled: false });
        }
        loadChannel.unsubscribe(this._loadedSubscriber);
      }
      _isEnabled(pluginConfig) {
        if (typeof pluginConfig === "boolean")
          return pluginConfig;
        if (!pluginConfig)
          return true;
        return pluginConfig.enabled !== false;
      }
      // TODO: figure out a better way to handle this
      _getSharedConfig(name) {
        const {
          logInjection,
          serviceMapping,
          queryStringObfuscation,
          site,
          url,
          dbmPropagationMode
        } = this._tracerConfig;
        const sharedConfig = {};
        if (logInjection !== void 0) {
          sharedConfig.logInjection = logInjection;
        }
        if (queryStringObfuscation !== void 0) {
          sharedConfig.queryStringObfuscation = queryStringObfuscation;
        }
        sharedConfig.dbmPropagationMode = dbmPropagationMode;
        if (serviceMapping && serviceMapping[name]) {
          sharedConfig.service = serviceMapping[name];
        }
        sharedConfig.site = site;
        sharedConfig.url = url;
        return sharedConfig;
      }
    };
  }
});

// packages/dd-trace/src/exporters/common/form-data.js
var require_form_data = __commonJS({
  "packages/dd-trace/src/exporters/common/form-data.js"(exports2, module2) {
    "use strict";
    var { Readable } = require("stream");
    var id = require_id();
    var FormData = class extends Readable {
      constructor() {
        super();
        this._boundary = id().toString();
        this._data = [];
      }
      append(key, value, options = {}) {
        this._appendBoundary();
        if (options.filename) {
          this._appendFile(key, value, options);
        } else {
          this._appendMetadata(key, value, options);
        }
      }
      getHeaders() {
        return { "Content-Type": "multipart/form-data; boundary=" + this._boundary };
      }
      _appendBoundary() {
        this._data.push(`--${this._boundary}\r
`);
      }
      _appendMetadata(key, value) {
        this._data.push(`Content-Disposition: form-data; name="${key}"\r
\r
${value}\r
`);
      }
      _appendFile(key, value, { filename, contentType = "application/octet-stream" }) {
        this._data.push(`Content-Disposition: form-data; name="${key}"; filename="${filename}"\r
`);
        this._data.push(`Content-Type: ${contentType}\r
\r
`);
        this._data.push(value);
        this._data.push("\r\n");
      }
      _read() {
        this.push(this._data.shift());
        if (this._data.length === 0) {
          this.push(`--${this._boundary}--\r
`);
          this.push(null);
        }
      }
    };
    module2.exports = FormData;
  }
});

// packages/dd-trace/src/profiling/exporters/agent.js
var require_agent2 = __commonJS({
  "packages/dd-trace/src/profiling/exporters/agent.js"(exports2, module2) {
    "use strict";
    var retry = require("retry");
    var { request } = require("http");
    var docker = require_docker();
    var FormData = require_form_data();
    var { storage } = require_datadog_core();
    var version = require_package().version;
    var containerId = docker.id();
    function sendRequest(options, form, callback) {
      const store = storage.getStore();
      storage.enterWith({ noop: true });
      const req = request(options, (res) => {
        if (res.statusCode >= 400) {
          const error = new Error(`HTTP Error ${res.statusCode}`);
          error.status = res.statusCode;
          callback(error);
        } else {
          callback(null, res);
        }
      });
      req.on("error", callback);
      if (form)
        form.pipe(req);
      storage.enterWith(store);
    }
    function getBody(stream, callback) {
      const chunks = [];
      stream.on("error", callback);
      stream.on("data", (chunk) => chunks.push(chunk));
      stream.on("end", () => {
        callback(null, Buffer.concat(chunks));
      });
    }
    function computeRetries(uploadTimeout) {
      let tries = 0;
      while (tries < 2 || uploadTimeout > 1e3) {
        tries++;
        uploadTimeout /= 2;
      }
      return [tries, Math.floor(uploadTimeout)];
    }
    var AgentExporter = class {
      constructor({ url, logger, uploadTimeout } = {}) {
        this._url = url;
        this._logger = logger;
        const [backoffTries, backoffTime] = computeRetries(uploadTimeout);
        this._backoffTime = backoffTime;
        this._backoffTries = backoffTries;
      }
      export({ profiles, start, end, tags }) {
        const types = Object.keys(profiles);
        const fields = [
          ["recording-start", start.toISOString()],
          ["recording-end", end.toISOString()],
          ["language", "javascript"],
          ["runtime", "nodejs"],
          ["runtime_version", process.version],
          ["profiler_version", version],
          ["format", "pprof"],
          ["tags[]", "language:javascript"],
          ["tags[]", "runtime:nodejs"],
          ["tags[]", `runtime_version:${process.version}`],
          ["tags[]", `profiler_version:${version}`],
          ["tags[]", "format:pprof"],
          ...Object.entries(tags).map(([key, value]) => ["tags[]", `${key}:${value}`])
        ];
        this._logger.debug(() => {
          const body = fields.map(([key, value]) => `  ${key}: ${value}`).join("\n");
          return `Building agent export report: ${"\n" + body}`;
        });
        for (let index = 0; index < types.length; index++) {
          const type = types[index];
          const buffer = profiles[type];
          this._logger.debug(() => {
            const bytes = buffer.toString("hex").match(/../g).join(" ");
            return `Adding ${type} profile to agent export: ` + bytes;
          });
          fields.push([`types[${index}]`, type]);
          fields.push([`data[${index}]`, buffer, {
            filename: `${type}.pb.gz`,
            contentType: "application/octet-stream",
            knownLength: buffer.length
          }]);
        }
        return new Promise((resolve, reject) => {
          const operation = retry.operation({
            randomize: true,
            minTimeout: this._backoffTime,
            retries: this._backoffTries,
            unref: true
          });
          operation.attempt((attempt) => {
            const form = new FormData();
            for (const [key, value, options2] of fields) {
              form.append(key, value, options2);
            }
            const options = {
              method: "POST",
              path: "/profiling/v1/input",
              headers: form.getHeaders(),
              timeout: this._backoffTime * Math.pow(2, attempt)
            };
            if (containerId) {
              options.headers["Datadog-Container-ID"] = containerId;
            }
            if (this._url.protocol === "unix:") {
              options.socketPath = this._url.pathname;
            } else {
              options.protocol = this._url.protocol;
              options.hostname = this._url.hostname;
              options.port = this._url.port;
            }
            this._logger.debug(() => {
              return `Submitting profiler agent report attempt #${attempt} to: ${JSON.stringify(options)}`;
            });
            sendRequest(options, form, (err, response) => {
              if (operation.retry(err)) {
                this._logger.error(`Error from the agent: ${err.message}`);
                return;
              } else if (err) {
                reject(new Error("Profiler agent export back-off period expired"));
                return;
              }
              getBody(response, (err2, body) => {
                if (err2) {
                  this._logger.error(`Error reading agent response: ${err2.message}`);
                } else {
                  this._logger.debug(() => {
                    const bytes = (body.toString("hex").match(/../g) || []).join(" ");
                    return `Agent export response: ${bytes}`;
                  });
                }
              });
              resolve();
            });
          });
        });
      }
    };
    module2.exports = { AgentExporter, computeRetries };
  }
});

// packages/dd-trace/src/profiling/exporters/file.js
var require_file = __commonJS({
  "packages/dd-trace/src/profiling/exporters/file.js"(exports2, module2) {
    "use strict";
    var fs = require("fs");
    var { promisify } = require("util");
    var writeFile = promisify(fs.writeFile);
    function formatDateTime(t) {
      const pad = (n) => String(n).padStart(2, "0");
      return `${t.getUTCFullYear()}${pad(t.getUTCMonth() + 1)}${pad(t.getUTCDate())}T${pad(t.getUTCHours())}${pad(t.getUTCMinutes())}${pad(t.getUTCSeconds())}Z`;
    }
    var FileExporter = class {
      constructor({ pprofPrefix } = {}) {
        this._pprofPrefix = pprofPrefix || "";
      }
      export({ profiles, end }) {
        const types = Object.keys(profiles);
        const dateStr = formatDateTime(end);
        const tasks = types.map((type) => {
          return writeFile(`${this._pprofPrefix}${type}_${dateStr}.pprof`, profiles[type]);
        });
        return Promise.all(tasks);
      }
    };
    module2.exports = { FileExporter };
  }
});

// packages/dd-trace/src/profiling/loggers/console.js
var require_console = __commonJS({
  "packages/dd-trace/src/profiling/loggers/console.js"(exports2, module2) {
    "use strict";
    var mapping = {
      error: 3,
      warn: 4,
      info: 6,
      debug: 7
    };
    var ConsoleLogger = class {
      constructor(options = {}) {
        this._level = mapping[options.level] || mapping["error"];
      }
      debug(message) {
        this._log("debug", message);
      }
      info(message) {
        this._log("info", message);
      }
      warn(message) {
        this._log("warn", message);
      }
      error(message) {
        this._log("error", message);
      }
      _log(level, message) {
        if (mapping[level] > this._level)
          return;
        console[level](message);
      }
    };
    module2.exports = { ConsoleLogger };
  }
});

// packages/dd-trace/src/profiling/profilers/cpu.js
var require_cpu = __commonJS({
  "packages/dd-trace/src/profiling/profilers/cpu.js"(exports2, module2) {
    "use strict";
    var { storage } = require_datadog_core();
    var dc = require_diagnostics_channel();
    var beforeCh = dc.channel("dd-trace:storage:before");
    var afterCh = dc.channel("dd-trace:storage:after");
    function getActiveSpan() {
      const store = storage.getStore();
      if (!store)
        return;
      return store.span;
    }
    function getStartedSpans(activeSpan) {
      const context = activeSpan.context();
      if (!context)
        return;
      return context._trace.started;
    }
    function getSpanContextTags(span) {
      return span.context()._tags;
    }
    function isWebServerSpan(tags) {
      return tags["span.type"] === "web";
    }
    function endpointNameFromTags(tags) {
      return tags["resource.name"] || [
        tags["http.method"],
        tags["http.route"]
      ].filter((v) => v).join(" ");
    }
    var NativeCpuProfiler = class {
      constructor(options = {}) {
        this.type = "cpu";
        this._frequency = options.frequency || 99;
        this._mapper = void 0;
        this._pprof = void 0;
        this._started = false;
        this._cpuProfiler = void 0;
        this._endpointCollection = options.endpointCollection;
        this._enter = this._enter.bind(this);
        this._exit = this._exit.bind(this);
      }
      _enter() {
        if (!this._cpuProfiler)
          return;
        const active = getActiveSpan();
        if (!active)
          return;
        const activeCtx = active.context();
        if (!activeCtx)
          return;
        const spans = getStartedSpans(active);
        if (!spans || !spans.length)
          return;
        const firstCtx = spans[0].context();
        if (!firstCtx)
          return;
        const labels = {
          "local root span id": firstCtx.toSpanId(),
          "span id": activeCtx.toSpanId()
        };
        if (this._endpointCollection) {
          const webServerTags = spans.map(getSpanContextTags).filter(isWebServerSpan)[0];
          if (webServerTags) {
            labels["trace endpoint"] = endpointNameFromTags(webServerTags);
          }
        }
        this._cpuProfiler.labels = labels;
      }
      _exit() {
        if (!this._cpuProfiler)
          return;
        this._cpuProfiler.labels = {};
      }
      start({ mapper } = {}) {
        if (this._started)
          return;
        this._started = true;
        this._mapper = mapper;
        if (!this._pprof) {
          this._pprof = require("@datadog/pprof");
          this._cpuProfiler = new this._pprof.CpuProfiler();
        }
        this._cpuProfiler.start(this._frequency);
        this._enter();
        beforeCh.subscribe(this._enter);
        afterCh.subscribe(this._exit);
      }
      profile() {
        if (!this._started)
          return;
        return this._cpuProfiler.profile();
      }
      encode(profile) {
        return this._pprof.encode(profile);
      }
      stop() {
        if (!this._started)
          return;
        this._started = false;
        this._cpuProfiler.stop();
        beforeCh.unsubscribe(this._enter);
        afterCh.unsubscribe(this._exit);
      }
    };
    module2.exports = NativeCpuProfiler;
  }
});

// packages/dd-trace/src/profiling/profilers/wall.js
var require_wall = __commonJS({
  "packages/dd-trace/src/profiling/profilers/wall.js"(exports2, module2) {
    "use strict";
    var NativeWallProfiler = class {
      constructor(options = {}) {
        this.type = "wall";
        this._samplingInterval = options.samplingInterval || 1e6 / 99;
        this._mapper = void 0;
        this._pprof = void 0;
      }
      start({ mapper } = {}) {
        this._mapper = mapper;
        this._pprof = require("@datadog/pprof");
        if (!process._startProfilerIdleNotifier) {
          process._startProfilerIdleNotifier = () => {
          };
        }
        if (!process._stopProfilerIdleNotifier) {
          process._stopProfilerIdleNotifier = () => {
          };
        }
        this._record();
      }
      profile() {
        if (!this._stop)
          return;
        return this._stop(true);
      }
      encode(profile) {
        return this._pprof.encode(profile);
      }
      stop() {
        if (!this._stop)
          return;
        this._stop();
        this._stop = void 0;
      }
      _record() {
        this._stop = this._pprof.time.start(
          this._samplingInterval,
          null,
          this._mapper,
          false
        );
      }
    };
    module2.exports = NativeWallProfiler;
  }
});

// packages/dd-trace/src/profiling/constants.js
var require_constants2 = __commonJS({
  "packages/dd-trace/src/profiling/constants.js"(exports2, module2) {
    "use strict";
    var snapshotKinds = Object.freeze({
      PERIODIC: "periodic",
      ON_SHUTDOWN: "on_shutdown",
      ON_OUT_OF_MEMORY: "on_oom"
    });
    var oomExportStrategies = Object.freeze({
      PROCESS: "process",
      ASYNC_CALLBACK: "async",
      INTERRUPT_CALLBACK: "interrupt",
      LOGS: "logs"
    });
    module2.exports = { snapshotKinds, oomExportStrategies };
  }
});

// packages/dd-trace/src/profiling/profilers/space.js
var require_space = __commonJS({
  "packages/dd-trace/src/profiling/profilers/space.js"(exports2, module2) {
    "use strict";
    var { oomExportStrategies } = require_constants2();
    function strategiesToCallbackMode(strategies, callbackMode) {
      const hasInterrupt = strategies.includes(oomExportStrategies.INTERRUPT_CALLBACK) ? callbackMode.Interrupt : 0;
      const hasCallback = strategies.includes(oomExportStrategies.ASYNC_CALLBACK) ? callbackMode.Async : 0;
      return hasInterrupt | hasCallback;
    }
    var NativeSpaceProfiler = class {
      constructor(options = {}) {
        this.type = "space";
        this._samplingInterval = options.samplingInterval || 512 * 1024;
        this._stackDepth = options.stackDepth || 64;
        this._pprof = void 0;
        this._oomMonitoring = options.oomMonitoring || {};
      }
      start({ mapper, nearOOMCallback } = {}) {
        this._mapper = mapper;
        this._pprof = require("@datadog/pprof");
        this._pprof.heap.start(this._samplingInterval, this._stackDepth);
        if (this._oomMonitoring.enabled) {
          const strategies = this._oomMonitoring.exportStrategies;
          this._pprof.heap.monitorOutOfMemory(
            this._oomMonitoring.heapLimitExtensionSize,
            this._oomMonitoring.maxHeapExtensionCount,
            strategies.includes(oomExportStrategies.LOGS),
            strategies.includes(oomExportStrategies.PROCESS) ? this._oomMonitoring.exportCommand : [],
            (profile) => nearOOMCallback(this.type, this._pprof.encodeSync(profile)),
            strategiesToCallbackMode(strategies, this._pprof.heap.CallbackMode)
          );
        }
      }
      profile() {
        return this._pprof.heap.profile(void 0, this._mapper);
      }
      encode(profile) {
        return this._pprof.encode(profile);
      }
      stop() {
        this._pprof.heap.stop();
      }
    };
    module2.exports = NativeSpaceProfiler;
  }
});

// packages/dd-trace/src/profiling/tagger.js
var require_tagger2 = __commonJS({
  "packages/dd-trace/src/profiling/tagger.js"(exports2, module2) {
    "use strict";
    var tagger = {
      parse(tags) {
        if (!tags)
          return {};
        switch (typeof tags) {
          case "object":
            if (Array.isArray(tags)) {
              return tags.reduce((prev, next) => {
                const parts = next.split(":");
                const key = parts.shift().trim();
                const value = parts.join(":").trim();
                if (!key || !value)
                  return prev;
                return Object.assign(prev, { [key]: value });
              }, {});
            } else {
              return tagger.parse(Object.keys(tags).filter((key) => tags[key] !== void 0 && tags[key] !== null).map((key) => `${key}:${tags[key]}`));
            }
          case "string":
            return tagger.parse(tags.split(","));
          default:
            return {};
        }
      }
    };
    module2.exports = { tagger };
  }
});

// packages/dd-trace/src/profiling/config.js
var require_config2 = __commonJS({
  "packages/dd-trace/src/profiling/config.js"(exports2, module2) {
    "use strict";
    var coalesce = require("koalas");
    var os = require("os");
    var path = require("path");
    var { URL: URL2, format, pathToFileURL } = require("url");
    var { AgentExporter } = require_agent2();
    var { FileExporter } = require_file();
    var { ConsoleLogger } = require_console();
    var CpuProfiler = require_cpu();
    var WallProfiler = require_wall();
    var SpaceProfiler = require_space();
    var { oomExportStrategies, snapshotKinds } = require_constants2();
    var { tagger } = require_tagger2();
    var { isTrue } = require_util();
    var Config = class {
      constructor(options = {}) {
        const {
          DD_PROFILING_ENABLED,
          DD_PROFILING_PROFILERS,
          DD_PROFILING_ENDPOINT_COLLECTION_ENABLED,
          DD_ENV,
          DD_TAGS,
          DD_SERVICE,
          DD_VERSION,
          DD_TRACE_AGENT_URL,
          DD_AGENT_HOST,
          DD_TRACE_AGENT_PORT,
          DD_PROFILING_UPLOAD_TIMEOUT,
          DD_PROFILING_SOURCE_MAP,
          DD_PROFILING_UPLOAD_PERIOD,
          DD_PROFILING_PPROF_PREFIX,
          DD_PROFILING_EXPERIMENTAL_OOM_MONITORING_ENABLED,
          DD_PROFILING_EXPERIMENTAL_OOM_HEAP_LIMIT_EXTENSION_SIZE,
          DD_PROFILING_EXPERIMENTAL_OOM_MAX_HEAP_EXTENSION_COUNT,
          DD_PROFILING_EXPERIMENTAL_OOM_EXPORT_STRATEGIES
        } = process.env;
        const enabled = isTrue(coalesce(options.enabled, DD_PROFILING_ENABLED, true));
        const env = coalesce(options.env, DD_ENV);
        const service = options.service || DD_SERVICE || "node";
        const host = os.hostname();
        const version = coalesce(options.version, DD_VERSION);
        const functionname = process.env.AWS_LAMBDA_FUNCTION_NAME;
        const flushInterval = coalesce(options.interval, Number(DD_PROFILING_UPLOAD_PERIOD) * 1e3, 65 * 1e3);
        const uploadTimeout = coalesce(
          options.uploadTimeout,
          Number(DD_PROFILING_UPLOAD_TIMEOUT),
          60 * 1e3
        );
        const sourceMap = coalesce(
          options.sourceMap,
          DD_PROFILING_SOURCE_MAP,
          true
        );
        const endpointCollection = coalesce(
          options.endpointCollection,
          DD_PROFILING_ENDPOINT_COLLECTION_ENABLED,
          false
        );
        const pprofPrefix = coalesce(
          options.pprofPrefix,
          DD_PROFILING_PPROF_PREFIX
        );
        this.enabled = enabled;
        this.service = service;
        this.env = env;
        this.host = host;
        this.functionname = functionname;
        this.version = version;
        this.tags = Object.assign(
          tagger.parse(DD_TAGS),
          tagger.parse(options.tags),
          tagger.parse({ env, host, service, version, functionname })
        );
        this.logger = ensureLogger(options.logger);
        this.flushInterval = flushInterval;
        this.uploadTimeout = uploadTimeout;
        this.sourceMap = sourceMap;
        this.endpointCollection = endpointCollection;
        this.pprofPrefix = pprofPrefix;
        const hostname = coalesce(options.hostname, DD_AGENT_HOST) || "localhost";
        const port = coalesce(options.port, DD_TRACE_AGENT_PORT) || 8126;
        this.url = new URL2(coalesce(options.url, DD_TRACE_AGENT_URL, format({
          protocol: "http:",
          hostname,
          port
        })));
        this.exporters = ensureExporters(options.exporters || [
          new AgentExporter(this)
        ], this);
        const oomMonitoringEnabled = isTrue(coalesce(
          options.oomMonitoring,
          DD_PROFILING_EXPERIMENTAL_OOM_MONITORING_ENABLED,
          false
        ));
        const heapLimitExtensionSize = coalesce(
          options.oomHeapLimitExtensionSize,
          Number(DD_PROFILING_EXPERIMENTAL_OOM_HEAP_LIMIT_EXTENSION_SIZE),
          0
        );
        const maxHeapExtensionCount = coalesce(
          options.oomMaxHeapExtensionCount,
          Number(DD_PROFILING_EXPERIMENTAL_OOM_MAX_HEAP_EXTENSION_COUNT),
          0
        );
        const exportStrategies = ensureOOMExportStrategies(coalesce(
          options.oomExportStrategies,
          DD_PROFILING_EXPERIMENTAL_OOM_EXPORT_STRATEGIES
        ), this);
        const exportCommand = oomMonitoringEnabled ? buildExportCommand(this) : void 0;
        this.oomMonitoring = {
          enabled: oomMonitoringEnabled,
          heapLimitExtensionSize,
          maxHeapExtensionCount,
          exportStrategies,
          exportCommand
        };
        const profilers = coalesce(options.profilers, DD_PROFILING_PROFILERS, [
          new WallProfiler(this),
          new SpaceProfiler(this)
        ]);
        this.profilers = ensureProfilers(profilers, this);
      }
    };
    module2.exports = { Config };
    function getExportStrategy(name, options) {
      const strategy = Object.values(oomExportStrategies).find((value) => value === name);
      if (strategy === void 0) {
        options.logger.error(`Unknown oom export strategy "${name}"`);
      }
      return strategy;
    }
    function ensureOOMExportStrategies(strategies, options) {
      if (!strategies) {
        return [];
      }
      if (typeof strategies === "string") {
        strategies = strategies.split(",");
      }
      for (let i = 0; i < strategies.length; i++) {
        const strategy = strategies[i];
        if (typeof strategy === "string") {
          strategies[i] = getExportStrategy(strategy, options);
        }
      }
      return [...new Set(strategies)];
    }
    function getExporter(name, options) {
      switch (name) {
        case "agent":
          return new AgentExporter(options);
        case "file":
          return new FileExporter(options);
      }
    }
    function ensureExporters(exporters, options) {
      if (typeof exporters === "string") {
        exporters = exporters.split(",");
      }
      for (let i = 0; i < exporters.length; i++) {
        const exporter = exporters[i];
        if (typeof exporter === "string") {
          exporters[i] = getExporter(exporter, options);
        }
      }
      return exporters;
    }
    function getProfiler(name, options) {
      switch (name) {
        case "cpu":
        case "wall":
          return new WallProfiler(options);
        case "space":
          return new SpaceProfiler(options);
        case "cpu-experimental":
          return new CpuProfiler(options);
        default:
          options.logger.error(`Unknown profiler "${name}"`);
      }
    }
    function ensureProfilers(profilers, options) {
      if (typeof profilers === "string") {
        profilers = profilers.split(",");
      }
      for (let i = 0; i < profilers.length; i++) {
        const profiler = profilers[i];
        if (typeof profiler === "string") {
          profilers[i] = getProfiler(profiler, options);
        }
      }
      return profilers.filter((v) => v);
    }
    function ensureLogger(logger) {
      if (typeof logger !== "object" || typeof logger.debug !== "function" || typeof logger.info !== "function" || typeof logger.warn !== "function" || typeof logger.error !== "function") {
        return new ConsoleLogger();
      }
      return logger;
    }
    function buildExportCommand(options) {
      const tags = [
        ...Object.entries(options.tags),
        ["snapshot", snapshotKinds.ON_OUT_OF_MEMORY]
      ].map(([key, value]) => `${key}:${value}`).join(",");
      const urls = [];
      for (const exporter of options.exporters) {
        if (exporter instanceof AgentExporter) {
          urls.push(options.url.toString());
        } else if (exporter instanceof FileExporter) {
          urls.push(pathToFileURL(options.pprofPrefix).toString());
        }
      }
      return [
        process.execPath,
        path.join(__dirname, "exporter_cli.js"),
        urls.join(","),
        tags,
        "space"
      ];
    }
  }
});

// packages/dd-trace/src/profiling/profiler.js
var require_profiler = __commonJS({
  "packages/dd-trace/src/profiling/profiler.js"(exports2, module2) {
    "use strict";
    var { EventEmitter } = require("events");
    var { Config } = require_config2();
    var { snapshotKinds } = require_constants2();
    function maybeSourceMap(sourceMap) {
      if (!sourceMap)
        return;
      const { SourceMapper } = require("@datadog/pprof");
      return SourceMapper.create([
        process.cwd()
      ]);
    }
    var Profiler = class extends EventEmitter {
      constructor() {
        super();
        this._enabled = false;
        this._logger = void 0;
        this._config = void 0;
        this._timer = void 0;
        this._lastStart = void 0;
        this._timeoutInterval = void 0;
      }
      start(options) {
        this._start(options).catch(() => {
        });
        return this;
      }
      async _start(options) {
        if (this._enabled)
          return;
        const config = this._config = new Config(options);
        if (!config.enabled)
          return;
        this._logger = config.logger;
        this._enabled = true;
        this._setInterval();
        let mapper;
        try {
          mapper = await maybeSourceMap(config.sourceMap);
        } catch (err) {
          this._logger.error(err);
        }
        try {
          for (const profiler of config.profilers) {
            profiler.start({
              mapper,
              nearOOMCallback: this._nearOOMExport.bind(this)
            });
            this._logger.debug(`Started ${profiler.type} profiler`);
          }
          this._capture(this._timeoutInterval);
        } catch (e) {
          this._logger.error(e);
          this._stop();
        }
      }
      _nearOOMExport(profileType, encodedProfile) {
        const start = this._lastStart;
        const end = /* @__PURE__ */ new Date();
        this._submit({
          [profileType]: encodedProfile
        }, start, end, snapshotKinds.ON_OUT_OF_MEMORY);
      }
      _setInterval() {
        this._timeoutInterval = this._config.flushInterval;
      }
      async stop() {
        if (!this._enabled)
          return;
        this._collect(snapshotKinds.ON_SHUTDOWN);
        this._stop();
      }
      _stop() {
        if (!this._enabled)
          return;
        this._enabled = false;
        for (const profiler of this._config.profilers) {
          profiler.stop();
          this._logger.debug(`Stopped ${profiler.type} profiler`);
        }
        clearTimeout(this._timer);
        this._timer = void 0;
        return this;
      }
      _capture(timeout) {
        if (!this._enabled)
          return;
        this._lastStart = /* @__PURE__ */ new Date();
        if (!this._timer || timeout !== this._timeoutInterval) {
          this._timer = setTimeout(() => this._collect(snapshotKinds.PERIODIC), timeout);
          this._timer.unref();
        } else {
          this._timer.refresh();
        }
      }
      async _collect(snapshotKind) {
        if (!this._enabled)
          return;
        const start = this._lastStart;
        const end = /* @__PURE__ */ new Date();
        const profiles = [];
        const encodedProfiles = {};
        try {
          for (const profiler of this._config.profilers) {
            const profile = profiler.profile();
            if (!profile)
              continue;
            profiles.push({ profiler, profile });
          }
          for (const { profiler, profile } of profiles) {
            encodedProfiles[profiler.type] = await profiler.encode(profile);
            this._logger.debug(() => {
              const profileJson = JSON.stringify(profile, (key, value) => {
                return typeof value === "bigint" ? value.toString() : value;
              });
              return `Collected ${profiler.type} profile: ` + profileJson;
            });
          }
          this._capture(this._timeoutInterval);
          await this._submit(encodedProfiles, start, end, snapshotKind);
          this._logger.debug("Submitted profiles");
        } catch (err) {
          this._logger.error(err);
          this._stop();
        }
      }
      _submit(profiles, start, end, snapshotKind) {
        if (!Object.keys(profiles).length) {
          return Promise.reject(new Error("No profiles to submit"));
        }
        const { tags } = this._config;
        const tasks = [];
        tags.snapshot = snapshotKind;
        for (const exporter of this._config.exporters) {
          const task = exporter.export({ profiles, start, end, tags }).catch((err) => this._logger.error(err));
          tasks.push(task);
        }
        return Promise.all(tasks);
      }
    };
    var ServerlessProfiler = class extends Profiler {
      constructor() {
        super();
        this._profiledIntervals = 0;
        this._interval = 1;
        this._flushAfterIntervals = void 0;
      }
      _setInterval() {
        this._timeoutInterval = this._interval * 1e3;
        this._flushAfterIntervals = this._config.flushInterval / 1e3;
      }
      async _collect(snapshotKind) {
        if (this._profiledIntervals >= this._flushAfterIntervals) {
          this._profiledIntervals = 0;
          await super._collect(snapshotKind);
        } else {
          this._profiledIntervals += 1;
          this._capture(this._timeoutInterval);
        }
      }
    };
    module2.exports = { Profiler, ServerlessProfiler };
  }
});

// packages/dd-trace/src/profiling/index.js
var require_profiling = __commonJS({
  "packages/dd-trace/src/profiling/index.js"(exports2, module2) {
    "use strict";
    var { Profiler, ServerlessProfiler } = require_profiler();
    var CpuProfiler = require_cpu();
    var WallProfiler = require_wall();
    var SpaceProfiler = require_space();
    var { AgentExporter } = require_agent2();
    var { FileExporter } = require_file();
    var { ConsoleLogger } = require_console();
    var profiler = process.env.AWS_LAMBDA_FUNCTION_NAME ? new ServerlessProfiler() : new Profiler();
    module2.exports = {
      profiler,
      AgentExporter,
      FileExporter,
      CpuProfiler,
      WallProfiler,
      SpaceProfiler,
      ConsoleLogger
    };
  }
});

// packages/dd-trace/src/profiler.js
var require_profiler2 = __commonJS({
  "packages/dd-trace/src/profiler.js"(exports2, module2) {
    "use strict";
    var log = require_log();
    var { profiler } = require_profiling();
    process.once("beforeExit", () => {
      profiler.stop();
    });
    module2.exports = {
      start: (config) => {
        const { service, version, env, url, hostname, port, tags } = config;
        const { enabled, sourceMap, exporters } = config.profiling;
        const logger = {
          debug: (message) => log.debug(message),
          info: (message) => log.info(message),
          warn: (message) => log.warn(message),
          error: (message) => log.error(message)
        };
        profiler.start({
          enabled,
          service,
          version,
          env,
          logger,
          sourceMap,
          exporters,
          url,
          hostname,
          port,
          tags
        });
      },
      stop: () => {
        profiler.stop();
      }
    };
  }
});

// packages/dd-trace/src/proxy.js
var require_proxy2 = __commonJS({
  "packages/dd-trace/src/proxy.js"(exports2, module2) {
    "use strict";
    var NoopProxy = require_proxy();
    var DatadogTracer = require_tracer3();
    var Config = require_config();
    var metrics = require_metrics();
    var log = require_log();
    var { setStartupLogPluginManager } = require_startup_log();
    var telemetry = require_telemetry();
    var PluginManager = require_plugin_manager();
    var Tracer = class extends NoopProxy {
      constructor() {
        super();
        this._initialized = false;
        this._pluginManager = new PluginManager(this);
      }
      init(options) {
        if (this._initialized)
          return this;
        this._initialized = true;
        try {
          const config = new Config(options);
          if (config.remoteConfig.enabled && !config.isCiVisibility) {
          }
          if (config.profiling.enabled) {
            try {
              const profiler = require_profiler2();
              profiler.start(config);
            } catch (e) {
              log.error(e);
            }
          }
          if (config.runtimeMetrics) {
            metrics.start(config);
          }
          if (config.tracing) {
            this._tracer = new DatadogTracer(config);
            this._pluginManager.configure(config);
            setStartupLogPluginManager(this._pluginManager);
            telemetry.start(config, this._pluginManager);
          }
        } catch (e) {
          log.error(e);
        }
        return this;
      }
      use() {
        this._pluginManager.configurePlugin(...arguments);
        return this;
      }
    };
    module2.exports = Tracer;
  }
});

// packages/dd-trace/src/index.js
var require_src2 = __commonJS({
  "packages/dd-trace/src/index.js"(exports2, module2) {
    "use strict";
    var { isFalse } = require_util();
    var inJestWorker = typeof jest !== "undefined";
    module2.exports = isFalse(process.env.DD_TRACE_ENABLED) || inJestWorker ? require_proxy() : require_proxy2();
  }
});

// packages/dd-trace/index.js
var require_dd_trace = __commonJS({
  "packages/dd-trace/index.js"(exports2, module2) {
    "use strict";
    if (!global._ddtrace) {
      const TracerProxy = require_src2();
      Object.defineProperty(global, "_ddtrace", {
        value: new TracerProxy(),
        enumerable: false,
        configurable: true,
        writable: true
      });
      global._ddtrace.default = global._ddtrace;
      global._ddtrace.tracer = global._ddtrace;
    }
    module2.exports = global._ddtrace;
  }
});

// index-src.js
module.exports = require_dd_trace();
