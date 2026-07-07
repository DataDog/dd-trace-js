"use strict";

const assert = require("node:assert/strict");
const { Buffer } = require("node:buffer");

const { afterEach, describe, it } = require("mocha");
const { channel } = require("dc-polyfill");

const { getHeadersSize } = require("../../dd-trace/src/datastreams");
const log = require("../../dd-trace/src/log");
const EventBridge = require("../src/services/eventbridge");

const EVENTBRIDGE_REQUEST_MAX_BYTES = 1024 * 1024;
const requestStartChannel = channel("apm:aws:request:start:eventbridge");
const activePlugins = [];
const tracerConfig = {
  cloudPayloadTagging: {},
  codeOriginForSpans: {
    enabled: false,
    experimental: {
      exit_spans: {
        enabled: false,
      },
    },
  },
  peerServiceMapping: {},
  spanComputePeerService: false,
};

function createSpan() {
  const tags = {};
  return {
    addTags(newTags) {
      Object.assign(tags, newTags);
    },
    context() {
      return {
        getTag(key) {
          return tags[key];
        },
        getTags() {
          return tags;
        },
      };
    },
    finish() {},
    setTag(key, value) {
      tags[key] = value;
    },
  };
}

/**
 * @param {number} size
 * @returns {string}
 */
function makeEventDetail(size) {
  const prefix = '{"myGreatData":"';
  const suffix = '"}';
  return `${prefix}${"a".repeat(size - Buffer.byteLength(prefix) - Buffer.byteLength(suffix))}${suffix}`;
}

/**
 * Construct a fully wired EventBridge plugin and exercise it through the
 * AWS diagnostic channel used by instrumented requests in production.
 *
 * @param {object} [options]
 * @param {boolean} [options.dsmEnabled]
 * @param {boolean} [options.batchPropagationEnabled]
 * @param {(span: unknown, format: string, carrier: object) => void} [options.inject]
 * @param {(edgeTags: string[], span: unknown, payloadSize: number) => object|null|undefined} [options.setCheckpoint]
 * @returns {EventBridge}
 */
function buildChannelPlugin({
  dsmEnabled,
  batchPropagationEnabled,
  inject = () => {},
  setCheckpoint = () => null,
} = {}) {
  const tracer = {
    _nomenclature: {
      opName: () => "aws.request",
      serviceName: () => "test-aws-eventbridge",
    },
    _service: "test",
    inject,
    setCheckpoint,
    startSpan: () => createSpan(),
  };
  const plugin = new EventBridge(tracer, tracerConfig);
  const config = { enabled: true };

  if (dsmEnabled !== undefined) {
    config.dsmEnabled = dsmEnabled;
  }

  if (batchPropagationEnabled !== undefined) {
    config.batchPropagationEnabled = batchPropagationEnabled;
  }

  plugin.configure(config);
  activePlugins.push(plugin);

  return plugin;
}

/**
 * Helper-only tests below need tight control over `injectToEntry` ordering
 * and fallback behaviour, so they intentionally bypass the diagnostic-channel
 * constructor path.
 *
 * @param {object} [options]
 * @param {boolean} [options.dsmEnabled]
 * @param {boolean} [options.batchPropagationEnabled]
 * @param {(span: unknown, format: string, carrier: object) => void} [options.inject]
 * @param {object|null} [options.dataStreamsContext]
 * @returns {EventBridge & { dsmCalls: Array<{ detail: string }> }}
 */
function buildHelperPlugin({
  dsmEnabled = false,
  batchPropagationEnabled = false,
  inject = () => {},
  dataStreamsContext = null,
} = {}) {
  const plugin = Object.create(EventBridge.prototype);
  plugin._tracer = { inject, setCheckpoint: () => null };
  plugin.config = { dsmEnabled, batchPropagationEnabled };
  plugin.dsmCalls = [];
  plugin.setDSMCheckpoint = (span, entry, ddInfo) => {
    plugin.dsmCalls.push({
      detail: entry.Detail,
      ddInfo: ddInfo && { ...ddInfo },
    });
    return dataStreamsContext;
  };
  return plugin;
}

/**
 * @param {EventBridge} plugin
 * @param {object} request
 * @returns {void}
 */
function publishRequest(plugin, request) {
  assert.ok(plugin);

  requestStartChannel.runStores(
    {
      awsRegion: "us-east-1",
      awsService: "EventBridge",
      cbExists: false,
      operation: request.operation,
      request,
      serviceIdentifier: "eventbridge",
    },
    () => {},
  );
}

afterEach(() => {
  while (activePlugins.length > 0) {
    activePlugins.pop().configure(false);
  }
});

describe("EventBridge plugin generateTags", () => {
  it("returns undefined when the source is missing", () => {
    const plugin = Object.create(EventBridge.prototype);

    assert.strictEqual(plugin.generateTags({}, "putEvents"), undefined);
  });

  it("generates tags when the source is present", () => {
    const plugin = Object.create(EventBridge.prototype);

    assert.deepStrictEqual(
      plugin.generateTags({
        source: "checkout",
        Name: "rule-a",
      }),
      {
        "resource.name": "checkout",
        "aws.eventbridge.source": "checkout",
        "messaging.system": "aws_eventbridge",
        rulename: "rule-a",
      },
    );
  });
});

describe("EventBridge plugin injectToEntry", () => {
  it("measures the trace context via setDSMCheckpoint without rewriting the detail first", () => {
    const plugin = buildHelperPlugin({
      dsmEnabled: true,
      inject: (span, format, carrier) => {
        carrier["x-datadog-trace-id"] = "123";
      },
    });
    const entry = { Detail: '{"hello":"world"}' };

    plugin.injectToEntry(null, entry, true, true);

    assert.strictEqual(plugin.dsmCalls.length, 1);
    // The detail is left untouched at measurement time; the trace context is
    // passed separately so the payload size can account for it.
    assert.strictEqual(plugin.dsmCalls[0].detail, '{"hello":"world"}');
    assert.deepStrictEqual(plugin.dsmCalls[0].ddInfo, {
      "x-datadog-trace-id": "123",
    });
  });

  it("keeps the trace-only `_datadog` payload when DSM yields no context", () => {
    const plugin = buildHelperPlugin({
      dsmEnabled: true,
      inject: (span, format, carrier) => {
        carrier["x-datadog-trace-id"] = "123";
      },
    });
    const entry = { Detail: '{"hello":"world"}' };

    plugin.injectToEntry(null, entry, true, true);

    assert.deepStrictEqual(JSON.parse(entry.Detail)._datadog, {
      "x-datadog-trace-id": "123",
    });
  });

  it("adds the encoded DSM context to `_datadog`", () => {
    const plugin = buildHelperPlugin({
      dsmEnabled: true,
      dataStreamsContext: {
        hash: Buffer.alloc(8),
        pathwayStartNs: 0,
        edgeStartNs: 0,
      },
    });
    const entry = { Detail: '{"hello":"world"}' };

    plugin.injectToEntry(null, entry, false, true);

    const injected = JSON.parse(entry.Detail)._datadog;
    assert.ok(
      typeof injected["dd-pathway-ctx-base64"] === "string" &&
        injected["dd-pathway-ctx-base64"].length > 0,
    );
  });

  it("keeps the trace-only detail when the DSM payload no longer fits", () => {
    const plugin = buildHelperPlugin({
      dsmEnabled: true,
      inject: (span, format, carrier) => {
        carrier["x-datadog-trace-id"] = "123";
      },
      dataStreamsContext: {
        hash: Buffer.alloc(8),
        pathwayStartNs: 0,
        edgeStartNs: 0,
      },
    });
    const entry = { Detail: '{"hello":"world"}' };
    let injectDetailCalls = 0;
    plugin.injectDetail = (detail, ddInfo) => {
      injectDetailCalls++;
      // First call is the DSM-inclusive carrier (too large); the fallback
      // injects the trace-only context.
      return injectDetailCalls === 1
        ? undefined
        : `{"hello":"world","_datadog":${JSON.stringify(ddInfo)}}`;
    };

    plugin.injectToEntry(null, entry, true, true);

    assert.strictEqual(injectDetailCalls, 2);
    assert.deepStrictEqual(JSON.parse(entry.Detail)._datadog, {
      "x-datadog-trace-id": "123",
    });
  });

  it("leaves the detail untouched when no context fits and there is nothing to fall back to", () => {
    const plugin = buildHelperPlugin({
      dsmEnabled: true,
      dataStreamsContext: {
        hash: Buffer.alloc(8),
        pathwayStartNs: 0,
        edgeStartNs: 0,
      },
    });
    const entry = { Detail: '{"hello":"world"}' };
    plugin.injectDetail = () => undefined;

    plugin.injectToEntry(null, entry, false, true);

    assert.strictEqual(entry.Detail, '{"hello":"world"}');
  });
});

describe("EventBridge plugin requestInject", () => {
  it("injects only the first batch entry by default", () => {
    const plugin = buildChannelPlugin({
      inject: (span, format, carrier) => {
        carrier["x-datadog-trace-id"] = "123";
      },
    });
    const request = {
      operation: "putEvents",
      params: {
        Entries: [{ Detail: '{"id":1}' }, { Detail: '{"id":2}' }],
      },
    };

    publishRequest(plugin, request);

    assert.deepStrictEqual(
      JSON.parse(request.params.Entries[0].Detail)._datadog,
      {
        "x-datadog-trace-id": "123",
      },
    );
    assert.strictEqual(request.params.Entries[1].Detail, '{"id":2}');
  });

  it("defaults to trace-only first-entry propagation when config is unset", () => {
    const plugin = buildChannelPlugin({
      inject: (span, format, carrier) => {
        carrier["x-datadog-trace-id"] = "123";
      },
    });
    const request = {
      operation: "putEvents",
      params: {
        Entries: [{ Detail: '{"id":1}' }, { Detail: '{"id":2}' }],
      },
    };

    publishRequest(plugin, request);

    assert.deepStrictEqual(
      JSON.parse(request.params.Entries[0].Detail)._datadog,
      {
        "x-datadog-trace-id": "123",
      },
    );
    assert.strictEqual(request.params.Entries[1].Detail, '{"id":2}');
  });

  it("skips rewriting non-propagated batch entries by default", () => {
    const plugin = buildChannelPlugin({
      inject: (span, format, carrier) => {
        carrier["x-datadog-trace-id"] = "123";
      },
    });
    let injectDetailCalls = 0;
    plugin.injectDetail = (...args) => {
      injectDetailCalls++;
      return EventBridge.prototype.injectDetail.apply(plugin, args);
    };
    const request = {
      operation: "putEvents",
      params: {
        Entries: [{ Detail: '{"id":1}' }, { Detail: '{ "id": 2 }' }],
      },
    };

    publishRequest(plugin, request);

    assert.strictEqual(injectDetailCalls, 1);
    assert.strictEqual(request.params.Entries[1].Detail, '{ "id": 2 }');
  });

  it("injects DSM context into every batch entry by default", () => {
    const plugin = buildChannelPlugin({
      dsmEnabled: true,
      setCheckpoint: () => ({
        hash: Buffer.alloc(8),
        pathwayStartNs: 0,
        edgeStartNs: 0,
      }),
    });
    const request = {
      operation: "putEvents",
      params: {
        Entries: [{ Detail: '{"id":1}' }, { Detail: '{"id":2}' }],
      },
    };

    publishRequest(plugin, request);

    const first = JSON.parse(request.params.Entries[0].Detail)._datadog;
    const second = JSON.parse(request.params.Entries[1].Detail)._datadog;
    assert.ok(
      typeof first["dd-pathway-ctx-base64"] === "string" &&
        first["dd-pathway-ctx-base64"].length > 0,
    );
    assert.ok(
      typeof second["dd-pathway-ctx-base64"] === "string" &&
        second["dd-pathway-ctx-base64"].length > 0,
    );
  });

  it("injects all batch entries when batchPropagationEnabled is enabled", () => {
    const plugin = buildChannelPlugin({
      batchPropagationEnabled: true,
      inject: (span, format, carrier) => {
        carrier["x-datadog-trace-id"] = "123";
      },
    });
    const request = {
      operation: "putEvents",
      params: {
        Entries: [{ Detail: '{"id":1}' }, { Detail: '{"id":2}' }],
      },
    };

    publishRequest(plugin, request);

    assert.deepStrictEqual(
      JSON.parse(request.params.Entries[0].Detail)._datadog,
      {
        "x-datadog-trace-id": "123",
      },
    );
    assert.deepStrictEqual(
      JSON.parse(request.params.Entries[1].Detail)._datadog,
      {
        "x-datadog-trace-id": "123",
      },
    );
  });

  it("skips batch propagation when the injected request would exceed 1mb", () => {
    const plugin = buildChannelPlugin({
      batchPropagationEnabled: true,
    });
    const originalInfo = log.info;
    const calls = [];
    log.info = (...args) => calls.push(args);
    plugin.getInjectedEntryDetail = () => makeEventDetail(501 * 1024);
    const request = {
      operation: "putEvents",
      params: {
        Entries: [{ Detail: '{"id":1}' }, { Detail: '{"id":2}' }],
      },
    };
    const originalDetails = request.params.Entries.map((entry) => entry.Detail);

    try {
      publishRequest(plugin, request);
    } finally {
      log.info = originalInfo;
    }

    assert.deepStrictEqual(
      request.params.Entries.map((entry) => entry.Detail),
      originalDetails,
    );
    assert.strictEqual(calls.length, 1);
    assert.ok(calls[0][0].includes("Payload size too large"));
    assert.ok(2 * 550 * 1024 > EVENTBRIDGE_REQUEST_MAX_BYTES);
  });

  it("uses the event bus and detail type in the DSM checkpoint tags", () => {
    const calls = [];
    const plugin = buildHelperPlugin();
    plugin._tracer.setCheckpoint = (...args) => {
      calls.push(args);
      return null;
    };
    const entry = {
      EventBusName: "payments",
      DetailType: "invoice.created",
      Detail: '{"id":1}',
    };

    EventBridge.prototype.setDSMCheckpoint.call(plugin, null, entry);

    assert.deepStrictEqual(calls, [
      [
        [
          "direction:out",
          "exchange:payments",
          "topic:invoice.created",
          "type:eventbridge",
        ],
        null,
        getHeadersSize(entry),
      ],
    ]);
  });

  it("uses the default event bus and detail type in the DSM checkpoint tags", () => {
    const calls = [];
    const plugin = buildHelperPlugin();
    plugin._tracer.setCheckpoint = (...args) => {
      calls.push(args);
      return null;
    };
    const entry = { Detail: '{"id":1}' };

    EventBridge.prototype.setDSMCheckpoint.call(plugin, null, entry);

    assert.deepStrictEqual(calls, [
      [
        [
          "direction:out",
          "exchange:default",
          "topic:unknown",
          "type:eventbridge",
        ],
        null,
        getHeadersSize(entry),
      ],
    ]);
  });
});

describe("EventBridge plugin injectDetail", () => {
  it("logs and returns undefined when the detail is invalid JSON", () => {
    const plugin = buildHelperPlugin();
    const originalError = log.error;
    const calls = [];
    log.error = (...args) => calls.push(args);

    try {
      assert.strictEqual(plugin.injectDetail("not-json", {}), undefined);
    } finally {
      log.error = originalError;
    }

    assert.strictEqual(calls.length, 1);
  });

  it("returns injected detail and leaves size checks to requestInject", () => {
    const plugin = buildHelperPlugin();

    const finalData = plugin.injectDetail(
      JSON.stringify({
        data: "a".repeat(1024 * 256),
      }),
      { trace: "123" },
    );

    assert.deepStrictEqual(JSON.parse(finalData)._datadog, { trace: "123" });
  });
});
