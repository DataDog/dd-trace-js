import tracer, { Span, SpanOptions, TracerOptions } from '..'
import tracerV5 = require('../index.d.v5')

declare module '..' {
  interface TracerOptions {
    customOption?: boolean
  }
}

declare module '../index.d.v5' {
  interface TracerOptions {
    customOption?: boolean
  }
}

interface TagObject {
  string: string
  number: number
  optional?: boolean
  buffer: Buffer
  url: URL
}

interface Tags {
  string: string
  number: number
  boolean: boolean
  object: TagObject
  optional?: boolean
}

interface EmptyTags {}

interface ErrorShapedTag {
  name: string
  message: string
  code: number
}

interface ErrorMetaTags {
  'error.type': string
  'error.message': string
  'error.stack': string
}

type TagUnion = { supported: string } | { unsupported: { nested: { value: string } } }

declare const span: Span
declare const errorMetaKey: 'error.type' | 'error.message' | 'error.stack'
declare const errorOrBoolean: Error | boolean
declare const errorMetaTags: ErrorMetaTags
declare const errorShapedTag: ErrorShapedTag
declare const emptyTags: EmptyTags
declare const opaqueObject: object
declare const bigintTag: bigint
declare const dynamicTagKey: string
declare const mixedStringTagKey: 'service.name' | 'custom'
declare const mixedTagValue: string | Date
declare const stringTagKey: 'service.name' | 'span.type'
declare const symbolTag: unique symbol
declare const tagObject: TagObject
declare const tags: Tags
declare const tagUnion: TagUnion
declare const unknownTag: unknown
declare const unknownTags: Record<string, unknown>
declare const v5Span: ReturnType<typeof tracerV5.startSpan>

span.setTag('string', 'value')
span.setTag('number', 1)
span.setTag('boolean', true)
span.setTag('error', new Error('boom'))
span.setTag('buffer', Buffer.from('value'))
span.setTag('url', new URL('https://example.com'))
span.setTag('object', tagObject)
span.setTag('error', errorShapedTag)
span.setTag('error', errorOrBoolean)
span.setTag('error.message', 'boom')
span.setTag(errorMetaKey, 'boom')
span.setTag('service.name', 'service')
span.setTag('span.type', 'type')
span.setTag('resource.name', 'resource')
span.setTag('span.kind', 'server')
span.setTag('manual.keep', true)
span.setTag('manual.drop', false)
span.setTag('analytics.event', true)
span.setTag('sampling.priority', 1)
span.setTag('http.status_code', 200)
span.setTag('http.status_code', '200')
span.setTag(stringTagKey, 'value')
span.setTag(dynamicTagKey, 42)
span.addTags({
  'analytics.event': false,
  'http.status_code': 200,
  'manual.keep': true,
  'sampling.priority': 1,
  'service.name': 'service',
})
span.addTags({ error: new Error('boom') })
span.addTags({ error: errorOrBoolean })
span.addTags(errorMetaTags)
span.addTags(tags)
span.addTags({})
span.addTags(emptyTags)
tracer.startSpan('test', { tags })
tracer.trace('test', { tags }, () => {})
tracer.wrap('test', { tags }, () => {})
tracer.wrap('test', () => ({ tags }), () => {})
tracer.init({ tags })
tracer.init({ tags: {} })
tracer.init({ tags: emptyTags })

const spanOptions: SpanOptions = { tags }
const opaqueSpanOptions: SpanOptions = { tags: unknownTags }
const defaultSpanOptions: SpanOptions = { tags: { error: new Error('boom') } }
const tracerOptions: TracerOptions = { customOption: true, tags: { string: 'value' } }
const tracerOptionsWithError: TracerOptions = { tags: { error: new Error('boom') } }
const tracerOptionsWithNamedTags: TracerOptions = { tags }
const mutableSpanOptions: SpanOptions = {}
const mutableTracerOptions: TracerOptions = {}
mutableSpanOptions.tags = {}
mutableTracerOptions.tags = {}
mutableSpanOptions.tags['custom.tag'] = 'value'
mutableTracerOptions.tags['custom.tag'] = 'value'
tracer.startSpan('test', spanOptions)
tracer.startSpan('test', defaultSpanOptions)
tracer.init(tracerOptions)
tracer.init(tracerOptionsWithError)
tracer.init(tracerOptionsWithNamedTags)
void spanOptions
void opaqueSpanOptions
void defaultSpanOptions
void tracerOptions
void tracerOptionsWithError
void tracerOptionsWithNamedTags
void mutableSpanOptions
void mutableTracerOptions

// Supplying a result type keeps the legacy broad options contract because TypeScript cannot infer later type arguments.
tracer.trace<void>('test', { tags: { 'service.name': 42 } }, () => {})
tracer.wrap<() => void>('test', { tags: { 'service.name': 42 } }, () => {})

// @ts-expect-error Nested object tag values are not supported.
span.setTag('nested', { child: { value: 'value' } })
// @ts-expect-error Array tag values are not supported.
span.setTag('array', ['value'])
// @ts-expect-error Function tag values are not supported.
span.setTag('function', () => {})
// @ts-expect-error Date tag values are not supported.
span.setTag('date', new Date())
// @ts-expect-error Map tag values are not supported.
span.setTag('map', new Map())
// @ts-expect-error Set tag values are not supported.
span.setTag('set', new Set())
// @ts-expect-error RegExp tag values are not supported.
span.setTag('regexp', /value/)
// @ts-expect-error Promise tag values are not supported.
span.setTag('promise', Promise.resolve())
// @ts-expect-error Typed array tag values other than Buffer are not supported.
span.setTag('typed-array', new Uint8Array())
// @ts-expect-error BigInt tag values are not supported.
span.setTag('bigint', bigintTag)
// @ts-expect-error Symbol tag values are not supported.
span.setTag('symbol', symbolTag)
// @ts-expect-error Values typed only as object may contain unsupported nested values.
span.setTag('object', opaqueObject)
// @ts-expect-error Unknown values must be narrowed before they are used as tags.
span.setTag('unknown', unknownTag)
// @ts-expect-error Error-shaped values are only supported by the error tag.
span.setTag('payload', errorShapedTag)
// @ts-expect-error Error values are only supported by the error tag.
span.setTag('exception', new Error('boom'))
// @ts-expect-error Strings on the error tag do not set error.message.
span.setTag('error', 'boom')
// @ts-expect-error Unrelated objects are not error values.
span.setTag('error', tagObject)
// @ts-expect-error Error metadata tags only support strings.
span.setTag('error.message', new Error('boom'))
// @ts-expect-error Error metadata tags do not support null values.
span.setTag('error.message', null)
// @ts-expect-error Error metadata tags do not support undefined values.
span.setTag('error.type', undefined)
// @ts-expect-error The error tag does not support null values.
span.setTag('error', null)
// @ts-expect-error Null tag values are not supported.
span.setTag('null', null)
// @ts-expect-error Undefined tag values are not supported.
span.setTag('undefined', undefined)
// @ts-expect-error Nested object tag values are not supported.
span.addTags({ nested: { child: { value: 'value' } } })
// @ts-expect-error Nested object properties typed only as undefined are not supported.
span.setTag('object', { missing: undefined })
// @ts-expect-error Symbol properties on object tag values are not supported.
span.setTag('object', { [symbolTag]: 'value' })
// @ts-expect-error Arrays are not tag maps.
span.addTags(['value'])
// @ts-expect-error Functions are not tag maps.
span.addTags(() => {})
// @ts-expect-error Unsupported members of tag unions are not supported.
span.addTags(tagUnion)
// @ts-expect-error Opaque tag maps must be narrowed before direct validation.
span.addTags(unknownTags)
// @ts-expect-error Symbol tag names are not supported.
span.addTags({ [symbolTag]: 'value' })
// @ts-expect-error service.name only supports strings.
span.addTags({ 'service.name': 42 })
// @ts-expect-error Values for finite key unions must be valid for every key.
span.setTag(mixedStringTagKey, 42)
// @ts-expect-error Value unions must not contain unsupported members.
span.setTag('custom', mixedTagValue)
// @ts-expect-error span.type only supports strings.
span.setTag('span.type', true)
// @ts-expect-error resource.name only supports strings.
span.setTag('resource.name', tagObject)
// @ts-expect-error span.kind only supports strings.
span.setTag('span.kind', true)
// @ts-expect-error Manual sampling tags only support booleans.
span.setTag('manual.keep', 1)
// @ts-expect-error Analytics events only support booleans.
span.setTag('analytics.event', 'true')
// @ts-expect-error Sampling priority only supports numbers.
span.setTag('sampling.priority', '1')
// @ts-expect-error HTTP status codes only support strings and numbers.
span.setTag('http.status_code', true)
// @ts-expect-error Reserved tag values are validated when adding multiple tags.
span.addTags({ 'manual.keep': 1 })
// @ts-expect-error Nested object tag values are not supported.
tracer.startSpan('test', { tags: { nested: { child: { value: 'value' } } } })
// @ts-expect-error Reserved tag values are validated in span options.
tracer.startSpan('test', { tags: { 'service.name': 42 } })
// @ts-expect-error Nested object tag values are not supported.
tracer.trace('test', { tags: { nested: { child: { value: 'value' } } } }, () => {})
// @ts-expect-error Nested object tag values are not supported.
tracer.wrap('test', { tags: { nested: { child: { value: 'value' } } } }, () => {})
// @ts-expect-error Nested object tag values are not supported.
tracer.wrap('test', () => ({ tags: { nested: { child: { value: 'value' } } } }), () => {})
// @ts-expect-error Nested object tag values are not supported.
tracer.init({ tags: { nested: { child: { value: 'value' } } } })
// @ts-expect-error Arrays are not tag maps.
tracer.init({ tags: ['value'] })
// @ts-expect-error Unsupported members of tag unions are not supported.
tracer.init({ tags: tagUnion })

v5Span.setTag('object', tagObject)
v5Span.setTag('error', errorShapedTag)
v5Span.setTag('error', errorOrBoolean)
v5Span.setTag('error.message', 'boom')
v5Span.setTag(errorMetaKey, 'boom')
v5Span.setTag('service.name', 'service')
v5Span.setTag('span.type', 'type')
v5Span.setTag('resource.name', 'resource')
v5Span.setTag('span.kind', 'server')
v5Span.setTag('manual.keep', true)
v5Span.setTag('manual.drop', false)
v5Span.setTag('analytics.event', true)
v5Span.setTag('sampling.priority', 1)
v5Span.setTag('http.status_code', 200)
v5Span.setTag('http.status_code', '200')
v5Span.setTag(stringTagKey, 'value')
v5Span.setTag(dynamicTagKey, 42)
v5Span.addTags({
  'analytics.event': false,
  'http.status_code': 200,
  'manual.keep': true,
  'sampling.priority': 1,
  'service.name': 'service',
})
v5Span.addTags({ error: new Error('boom') })
v5Span.addTags({ error: errorOrBoolean })
v5Span.addTags(errorMetaTags)
v5Span.addTags(tags)
v5Span.addTags({})
v5Span.addTags(emptyTags)
tracerV5.startSpan('test', { tags })
tracerV5.trace('test', { tags }, () => {})
tracerV5.wrap('test', { tags }, () => {})
tracerV5.wrap('test', () => ({ tags }), () => {})
tracerV5.init({ customOption: true, tags })
tracerV5.init({ tags: {} })
tracerV5.init({ tags: emptyTags })

const v5SpanOptions: tracerV5.SpanOptions = { tags: { error: new Error('boom') } }
const opaqueV5SpanOptions: tracerV5.SpanOptions = { tags: unknownTags }
const v5TracerOptionsWithError: tracerV5.TracerOptions = { tags: { error: new Error('boom') } }
const v5TracerOptionsWithNamedTags: tracerV5.TracerOptions = { tags }
const mutableV5SpanOptions: tracerV5.SpanOptions = {}
const mutableV5TracerOptions: tracerV5.TracerOptions = {}
mutableV5SpanOptions.tags = {}
mutableV5TracerOptions.tags = {}
mutableV5SpanOptions.tags['custom.tag'] = 'value'
mutableV5TracerOptions.tags['custom.tag'] = 'value'
tracerV5.startSpan('test', v5SpanOptions)
tracerV5.init(v5TracerOptionsWithError)
tracerV5.init(v5TracerOptionsWithNamedTags)
void v5SpanOptions
void opaqueV5SpanOptions
void v5TracerOptionsWithError
void v5TracerOptionsWithNamedTags
void mutableV5SpanOptions
void mutableV5TracerOptions

tracerV5.trace<void>('test', { tags: { 'service.name': 42 } }, () => {})
tracerV5.wrap<() => void>('test', { tags: { 'service.name': 42 } }, () => {})

// @ts-expect-error Nested object tag values are not supported.
v5Span.setTag('nested', { child: { value: 'value' } })
// @ts-expect-error Values typed only as object may contain unsupported nested values.
v5Span.setTag('object', opaqueObject)
// @ts-expect-error Unknown values must be narrowed before they are used as tags.
v5Span.setTag('unknown', unknownTag)
// @ts-expect-error Error-shaped values are only supported by the error tag.
v5Span.setTag('payload', errorShapedTag)
// @ts-expect-error Error values are only supported by the error tag.
v5Span.setTag('exception', new Error('boom'))
// @ts-expect-error Strings on the error tag do not set error.message.
v5Span.setTag('error', 'boom')
// @ts-expect-error Unrelated objects are not error values.
v5Span.setTag('error', tagObject)
// @ts-expect-error Error metadata tags only support strings.
v5Span.setTag('error.message', new Error('boom'))
// @ts-expect-error Error metadata tags do not support null values.
v5Span.setTag('error.message', null)
// @ts-expect-error Error metadata tags do not support undefined values.
v5Span.setTag('error.type', undefined)
// @ts-expect-error The error tag does not support null values.
v5Span.setTag('error', null)
// @ts-expect-error Nested object tag values are not supported.
v5Span.addTags({ nested: { child: { value: 'value' } } })
// @ts-expect-error Nested object properties typed only as undefined are not supported.
v5Span.setTag('object', { missing: undefined })
// @ts-expect-error Symbol properties on object tag values are not supported.
v5Span.setTag('object', { [symbolTag]: 'value' })
// @ts-expect-error Arrays are not tag maps.
v5Span.addTags(['value'])
// @ts-expect-error Functions are not tag maps.
v5Span.addTags(() => {})
// @ts-expect-error Unsupported members of tag unions are not supported.
v5Span.addTags(tagUnion)
// @ts-expect-error Opaque tag maps must be narrowed before direct validation.
v5Span.addTags(unknownTags)
// @ts-expect-error Symbol tag names are not supported.
v5Span.addTags({ [symbolTag]: 'value' })
// @ts-expect-error service.name only supports strings.
v5Span.addTags({ 'service.name': 42 })
// @ts-expect-error Values for finite key unions must be valid for every key.
v5Span.setTag(mixedStringTagKey, 42)
// @ts-expect-error Value unions must not contain unsupported members.
v5Span.setTag('custom', mixedTagValue)
// @ts-expect-error span.type only supports strings.
v5Span.setTag('span.type', true)
// @ts-expect-error resource.name only supports strings.
v5Span.setTag('resource.name', tagObject)
// @ts-expect-error span.kind only supports strings.
v5Span.setTag('span.kind', true)
// @ts-expect-error Manual sampling tags only support booleans.
v5Span.setTag('manual.keep', 1)
// @ts-expect-error Analytics events only support booleans.
v5Span.setTag('analytics.event', 'true')
// @ts-expect-error Sampling priority only supports numbers.
v5Span.setTag('sampling.priority', '1')
// @ts-expect-error HTTP status codes only support strings and numbers.
v5Span.setTag('http.status_code', true)
// @ts-expect-error Reserved tag values are validated when adding multiple tags.
v5Span.addTags({ 'manual.keep': 1 })
// @ts-expect-error Nested object tag values are not supported.
tracerV5.startSpan('test', { tags: { nested: { child: { value: 'value' } } } })
// @ts-expect-error Reserved tag values are validated in span options.
tracerV5.startSpan('test', { tags: { 'service.name': 42 } })
// @ts-expect-error Nested object tag values are not supported.
tracerV5.trace('test', { tags: { nested: { child: { value: 'value' } } } }, () => {})
// @ts-expect-error Nested object tag values are not supported.
tracerV5.wrap('test', { tags: { nested: { child: { value: 'value' } } } }, () => {})
// @ts-expect-error Nested object tag values are not supported.
tracerV5.wrap('test', () => ({ tags: { nested: { child: { value: 'value' } } } }), () => {})
// @ts-expect-error Nested object tag values are not supported.
tracerV5.init({ tags: { nested: { child: { value: 'value' } } } })
// @ts-expect-error Arrays are not tag maps.
tracerV5.init({ tags: ['value'] })
// @ts-expect-error Unsupported members of tag unions are not supported.
tracerV5.init({ tags: tagUnion })
