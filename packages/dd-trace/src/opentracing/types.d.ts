// Vendored from opentracing 0.14.7 under the Apache-2.0 license.
// This ambient declaration keeps dd-trace's public types OpenTracing-compatible
// without requiring the opentracing package at runtime or type-check time.

declare module 'opentracing' {
  export class BinaryCarrier {
    buffer: ArrayLike<number>;
    constructor (buffer: ArrayLike<number>);
  }

  export class SpanContext {
    toTraceId (): string;
    toSpanId (): string;
  }

  export interface SpanOptions {
    childOf?: Span | SpanContext;
    references?: Reference[];
    tags?: { [key: string]: any };
    startTime?: number;
  }

  export class Reference {
    protected _type: string;
    protected _referencedContext: SpanContext;

    constructor (type: string, referencedContext: SpanContext | Span);
    type (): string;
    referencedContext (): SpanContext;
  }

  export class Tracer {
    startSpan (name: string, options?: SpanOptions): Span;
    inject (spanContext: SpanContext | Span, format: string, carrier: any): void;
    extract (format: string, carrier: any): SpanContext | null;

    protected _startSpan (name: string, fields: SpanOptions): Span;
    protected _inject (spanContext: SpanContext, format: string, carrier: any): void;
    protected _extract (format: string, carrier: any): SpanContext | null;
  }

  export class Span {
    context (): SpanContext;
    tracer (): Tracer;
    setOperationName (name: string): this;
    setBaggageItem (key: string, value: string): this;
    getBaggageItem (key: string): string | undefined;
    setTag (key: string, value: any): this;
    addTags (keyValueMap: { [key: string]: any }): this;
    log (keyValuePairs: { [key: string]: any }, timestamp?: number): this;
    logEvent (eventName: string, payload: any): void;
    finish (finishTime?: number): void;

    protected _context (): SpanContext;
    protected _tracer (): Tracer;
    protected _setOperationName (name: string): void;
    protected _setBaggageItem (key: string, value: string): void;
    protected _getBaggageItem (key: string): string | undefined;
    protected _addTags (keyValueMap: { [key: string]: any }): void;
    protected _log (keyValuePairs: { [key: string]: any }, timestamp?: number): void;
    protected _finish (finishTime?: number): void;
  }

  class MockContext extends SpanContext {
    private _span;
    constructor (span: MockSpan);
    span (): MockSpan;
  }

  interface DebugInfo {
    uuid: string;
    operation: string;
    millis: [number, number, number];
    tags?: { [key: string]: any };
  }

  class MockSpan extends Span {
    private _operationName;
    private _tags;
    private _logs;
    _finishMs: number;
    private _mockTracer;
    private _uuid;
    private _startMs;
    _startStack?: string;

    constructor (tracer: MockTracer);
    protected _context (): MockContext;
    protected _setOperationName (name: string): void;
    protected _addTags (set: { [key: string]: any }): void;
    protected _log (fields: { [key: string]: any }, timestamp?: number): void;
    protected _finish (finishTime?: number): void;
    uuid (): string;
    operationName (): string;
    durationMs (): number;
    tags (): { [key: string]: any };
    tracer (): Tracer;
    private _generateUUID;
    addReference (ref: Reference): void;
    debug (): DebugInfo;
  }

  class MockReport {
    spans: MockSpan[];
    private spansByUUID;
    private spansByTag;
    private debugSpans;
    private unfinishedSpans;

    constructor (spans: MockSpan[]);
    firstSpanWithTagValue (key: string, val: any): MockSpan | null;
  }

  export class MockTracer extends Tracer {
    private _spans;

    constructor ();
    protected _startSpan (name: string, fields: SpanOptions): MockSpan;
    protected _inject (span: MockContext, format: any, carrier: any): never;
    protected _extract (format: any, carrier: any): never;
    private _allocSpan;
    clear (): void;
    report (): MockReport;
  }

  export const FORMAT_BINARY: 'binary';
  export const FORMAT_TEXT_MAP: 'text_map';
  export const FORMAT_HTTP_HEADERS: 'http_headers';
  export const REFERENCE_CHILD_OF: 'child_of';
  export const REFERENCE_FOLLOWS_FROM: 'follows_from';

  export function childOf (spanContext: SpanContext | Span): Reference;
  export function followsFrom (spanContext: SpanContext | Span): Reference;
  export function initGlobalTracer (tracer: Tracer): void;
  export function globalTracer (): Tracer;

  export namespace Tags {
    const SPAN_KIND: 'span.kind';
    const SPAN_KIND_RPC_CLIENT: 'client';
    const SPAN_KIND_RPC_SERVER: 'server';
    const SPAN_KIND_MESSAGING_PRODUCER: 'producer';
    const SPAN_KIND_MESSAGING_CONSUMER: 'consumer';
    const ERROR: 'error';
    const COMPONENT: 'component';
    const SAMPLING_PRIORITY: 'sampling.priority';
    const PEER_SERVICE: 'peer.service';
    const PEER_HOSTNAME: 'peer.hostname';
    const PEER_ADDRESS: 'peer.address';
    const PEER_HOST_IPV4: 'peer.ipv4';
    const PEER_HOST_IPV6: 'peer.ipv6';
    const PEER_PORT: 'peer.port';
    const HTTP_URL: 'http.url';
    const HTTP_METHOD: 'http.method';
    const HTTP_STATUS_CODE: 'http.status_code';
    const MESSAGE_BUS_DESTINATION: 'message_bus.destination';
    const DB_INSTANCE: 'db.instance';
    const DB_STATEMENT: 'db.statement';
    const DB_TYPE: 'db.type';
    const DB_USER: 'db.user';
  }
}
