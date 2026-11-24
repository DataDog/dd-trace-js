import type { ExtractorConfig, TraceContext } from '../../src/context/types';

const typed: ExtractorConfig<{ traceId: string }, { requestId: string }> = {
  traceExtractor: (event, context) => ({
    traceId: event.traceId, parentId: context.requestId, sampleMode: 2, source: 'event',
  }),
};
typed.traceExtractor?.({ traceId: '123' }, { requestId: '456' });
// @ts-expect-error The caller's event shape is preserved.
typed.traceExtractor?.('payload', { requestId: '456' });
// @ts-expect-error The caller's context shape is preserved.
typed.traceExtractor?.({ traceId: '123' }, {});

const asyncLegacy: ExtractorConfig<string, { requestId: string }> = {
  traceExtractor: async (event, context) => ({
    traceID: event, parentID: context.requestId, sampleMode: 0, source: 'ddtrace',
  }),
};
const generic: ExtractorConfig = {
  traceExtractor: () => ({ traceId: '123', parentId: '456', sampleMode: -1, source: 'xray' }),
};
// @ts-expect-error Extractors return trace context, not propagation headers.
const headers: ExtractorConfig = { traceExtractor: () => ({ 'x-datadog-trace-id': '123' }) };
// @ts-expect-error Sampling priorities remain numeric.
const invalidSampling: TraceContext = { sampleMode: '2', source: 'event' };
// @ts-expect-error Source values retain the released shim's contract.
const invalidSource: TraceContext = { sampleMode: 2, source: 'custom' };
void [asyncLegacy, generic, headers, invalidSampling, invalidSource];
