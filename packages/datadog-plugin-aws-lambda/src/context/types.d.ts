/** Private Lambda extraction contract; the shim owns the customer-facing callback types. */
export interface TraceContext {
  traceId?: string;
  parentId?: string;
  /** @deprecated Use traceId. */
  traceID?: string;
  /** @deprecated Use parentId. */
  parentID?: string;
  sampleMode: -1 | 0 | 1 | 2;
  source: 'event' | 'xray' | 'ddtrace';
}

/** Event and context types come from the caller, without requiring AWS types in the tracer. */
export interface ExtractorConfig<TEvent = unknown, TContext = unknown> {
  traceExtractor?: (event: TEvent, context: TContext) => TraceContext | Promise<TraceContext>;
  decodeAuthorizerContext?: boolean;
}
