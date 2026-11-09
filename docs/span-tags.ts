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
declare const mixedTagValue: string | { child: { value: string } }
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
span.setTag('function', () => {})
span.setTag('date', new Date())
span.setTag('map', new Map())
span.setTag('set', new Set())
span.setTag('regexp', /value/)
span.setTag('promise', Promise.resolve())
span.setTag('typed-array', new Uint8Array())
// @ts-expect-error BigInt tag values are not supported.
span.setTag('bigint', bigintTag)
// @ts-expect-error Symbol tag values are not supported.
span.setTag('symbol', symbolTag)
span.setTag('object', opaqueObject)
span.setTag('unknown', unknownTag)
span.setTag('payload', errorShapedTag)
span.setTag('exception', new Error('boom'))
span.setTag('error', 'boom')
span.setTag('error', tagObject)
// @ts-expect-error Whole errors belong in the error tag or need explicit conversion to text.
span.setTag('error.message', new Error('boom'))
span.setTag('error.message', null)
span.setTag('error.type', undefined)
span.setTag('error', null)
span.setTag('null', null)
span.setTag('undefined', undefined)
// @ts-expect-error Nested object tag values are not supported.
span.addTags({ nested: { child: { value: 'value' } } })
span.setTag('object', { missing: undefined })
span.setTag('object', { [symbolTag]: 'value' })
// @ts-expect-error Arrays are not tag maps.
span.addTags(['value'])
// @ts-expect-error Functions are not tag maps.
span.addTags(() => {})
// @ts-expect-error Unsupported members of tag unions are not supported.
span.addTags(tagUnion)
span.addTags(unknownTags)
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
span.setTag('span.kind', true)
span.setTag('manual.keep', 1)
span.setTag('analytics.event', 'true')
span.setTag('sampling.priority', '1')
span.setTag('http.status_code', true)
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
// @ts-expect-error Arrays are not initialization tag maps.
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
v5Span.setTag('object', opaqueObject)
v5Span.setTag('unknown', unknownTag)
v5Span.setTag('payload', errorShapedTag)
v5Span.setTag('exception', new Error('boom'))
v5Span.setTag('error', 'boom')
v5Span.setTag('error', tagObject)
// @ts-expect-error Whole errors belong in the error tag or need explicit conversion to text.
v5Span.setTag('error.message', new Error('boom'))
v5Span.setTag('error.message', null)
v5Span.setTag('error.type', undefined)
v5Span.setTag('error', null)
// @ts-expect-error Nested object tag values are not supported.
v5Span.addTags({ nested: { child: { value: 'value' } } })
v5Span.setTag('object', { missing: undefined })
v5Span.setTag('object', { [symbolTag]: 'value' })
v5Span.addTags(['value'])
// @ts-expect-error Functions are not tag maps.
v5Span.addTags(() => {})
// @ts-expect-error Unsupported members of tag unions are not supported.
v5Span.addTags(tagUnion)
v5Span.addTags(unknownTags)
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
v5Span.setTag('span.kind', true)
v5Span.setTag('manual.keep', 1)
v5Span.setTag('analytics.event', 'true')
v5Span.setTag('sampling.priority', '1')
v5Span.setTag('http.status_code', true)
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
// @ts-expect-error Arrays are not initialization tag maps.
tracerV5.init({ tags: ['value'] })
// @ts-expect-error Unsupported members of tag unions are not supported.
tracerV5.init({ tags: tagUnion })

class FlatPayload {
  id = '123'
  describe () { return this.id }
}

declare const brandedPayload: { id: string, [symbolTag]: true }
declare const brandedTags: { region: string, [symbolTag]: true }
declare const optionalScalar: string | undefined
declare const coercibleError: { message: number, name: boolean, stack: null }
declare const scalarOrMethod: { value: string | (() => string), optionalMethod?: () => string }

// These calls must compile through each public declaration surface.
for (const target of [span, v5Span]) {
  target.setTag('custom', new FlatPayload())
  target.setTag('custom', brandedPayload)
  target.setTag('custom', scalarOrMethod)
  target.setTag('custom', { value: 'present', missing: undefined })
  target.setTag('custom', optionalScalar)
  target.setTag('service.name', undefined)
  target.setTag('service.name', null)
  target.setTag('custom', null)
  target.setTag('custom', Object.assign(() => {}, { value: 1 }))
  target.setTag('custom', new Int16Array([1, 2]))
  target.setTag('custom', new Float32Array([1, 2]))
  target.setTag('error', coercibleError)
  target.setTag('error.type', undefined)
  target.setTag('error.stack', 'stack')
  target.setTag('manual.drop', null)
  target.setTag('analytics.event', undefined)
  target.setTag('sampling.priority', true)
  target.setTag('_dd.measured', { enabled: { value: true } })
  target.setTag('_dd.hostname', ['host'])
  target.addTags(brandedTags)
  target.setTag('custom', unknownTag)
  // @ts-expect-error Dynamic names use ordinary tag-value rules until narrowed to a special name.
  target.setTag(dynamicTagKey, ['coercible', 'metadata'])
  // @ts-expect-error A dynamic name does not establish support for nested tag values.
  target.setTag(dynamicTagKey, { value: { child: 'coercible metadata' } })
  target.addTags(unknownTags)
  target.addTags({ 'http.status_code': true, 'error.message': 500, 'analytics.event': 0.5 })
  // @ts-expect-error BigInt elements are not exported as tag values.
  target.setTag('custom', new BigInt64Array())
  // @ts-expect-error Numeric arrays expand only at the top level of a tag value.
  target.setTag('custom', { bytes: new Uint8Array() })
  // @ts-expect-error Additional properties on numeric typed arrays still cannot contain nested data.
  target.setTag('custom', Object.assign(new Uint8Array(), { data: { value: 1 } }))
  // @ts-expect-error Math.trunc cannot coerce a bigint sampling priority.
  target.setTag('sampling.priority', bigintTag)
  // @ts-expect-error Math.trunc cannot coerce a symbol sampling priority.
  target.addTags({ 'sampling.priority': symbolTag })
}

function forwardString<Value extends string> (value: Value) {
  span.setTag('custom', value)
  v5Span.setTag('custom', value)
}

function forwardKey<Key extends string> (key: Key) {
  span.setTag(key, 'value')
  v5Span.setTag(key, 'value')
}

function forwardTags<Tags extends Record<string, string | null | undefined>> (value: Tags) {
  span.addTags(value)
  v5Span.addTags(value)
}

void forwardString
void forwardKey
void forwardTags

function forwardOptions<Tags extends Record<string, string | null | undefined>> (tags: Tags) {
  tracer.startSpan('test', { tags })
  tracer.init({ tags })
  tracer.trace('test', { tags }, () => {})
  tracer.wrap('test', { tags }, () => {})
  tracer.wrap('test', () => ({ tags }), () => {})
  tracerV5.startSpan('test', { tags })
  tracerV5.init({ tags })
  tracerV5.trace('test', { tags }, () => {})
  tracerV5.wrap('test', { tags }, () => {})
  tracerV5.wrap('test', () => ({ tags }), () => {})
}

void forwardOptions

v5Span.addTags('first:one')
v5Span.addTags(['first:one', { second: 2 }, ['third:three']])
tracerV5.startSpan('legacy', { tags: ['first:one', { second: 2 }] })
tracerV5.trace('legacy', { tags: 'first:one' }, () => {})
tracerV5.wrap('legacy', { tags: ['first:one'] }, () => {})
tracerV5.wrap('legacy', () => ({ tags: ['first:one'] }), () => {})

const legacySpanOptions: tracerV5.SpanOptions = { tags: 'first:one' }
tracerV5.startSpan('legacy', legacySpanOptions)
tracerV5.trace<void>('legacy', { tags: 'first:one' }, () => {})
tracerV5.wrap<() => void>('legacy', { tags: 'first:one' }, () => {})
// @ts-expect-error A legacy collection still validates the values inside its tag maps.
v5Span.addTags(['first:one', { nested: { child: { value: 'dropped' } } }])
// @ts-expect-error Arrays are not initialization tag maps.
tracer.init({ tags: [['first:one']] })
// @ts-expect-error Arrays are not initialization tag maps.
tracerV5.init({ tags: [['first:one']] })
// @ts-expect-error v6 does not parse tag strings on spans.
span.addTags('first:one')
// @ts-expect-error v6 does not parse tag strings in per-span options.
tracer.startSpan('legacy', { tags: 'first:one' })

function forwardLegacyTags<Tags extends string> (tags: Tags) {
  v5Span.addTags(tags)
  tracerV5.startSpan('legacy', { tags })
  tracerV5.trace('legacy', { tags }, () => {})
  tracerV5.wrap('legacy', () => ({ tags }), () => {})
}

void forwardLegacyTags

function forwardLegacyTagMaps<Tags extends readonly Record<string, string>[]> (tags: Tags) {
  v5Span.addTags(tags)
  tracerV5.startSpan('legacy', { tags })
  tracerV5.trace('legacy', { tags }, () => {})
  tracerV5.wrap('legacy', { tags }, () => {})
  tracerV5.wrap('legacy', () => ({ tags }), () => {})
}

type LegacyTextTags = string | Record<string, string | null | undefined>

function forwardLegacyTextTags<Tags extends readonly (LegacyTextTags | readonly LegacyTextTags[])[]> (tags: Tags) {
  v5Span.addTags(tags)
  tracerV5.startSpan('legacy', { tags })
  tracerV5.trace('legacy', { tags }, () => {})
  tracerV5.wrap('legacy', { tags }, () => {})
  tracerV5.wrap('legacy', () => ({ tags }), () => {})
}

void forwardLegacyTagMaps
void forwardLegacyTextTags

interface GenericPayload<Value extends string> {
  value: Value
}

function forwardFlatPayload<Value extends string> (value: Value, payload: GenericPayload<Value>) {
  for (const target of [span, v5Span]) {
    target.setTag('object', { value })
    target.setTag('object', payload)
    target.addTags({ object: { value } })
    target.addTags({ object: payload })
  }
  tracer.startSpan('test', { tags: { object: { value } } })
  tracer.startSpan('test', { tags: { object: payload } })
  tracer.init({ tags: { object: { value } } })
  tracer.init({ tags: { object: payload } })
  tracer.trace('test', { tags: { object: { value } } }, () => {})
  tracer.trace('test', { tags: { object: payload } }, () => {})
  tracer.wrap('test', { tags: { object: { value } } }, () => {})
  tracer.wrap('test', () => ({ tags: { object: payload } }), () => {})
  tracerV5.startSpan('test', { tags: { object: { value } } })
  tracerV5.startSpan('test', { tags: { object: payload } })
  tracerV5.init({ tags: { object: { value } } })
  tracerV5.init({ tags: { object: payload } })
  tracerV5.trace('test', { tags: { object: { value } } }, () => {})
  tracerV5.trace('test', { tags: { object: payload } }, () => {})
  tracerV5.wrap('test', { tags: { object: { value } } }, () => {})
  tracerV5.wrap('test', () => ({ tags: { object: payload } }), () => {})
}

function forwardNumber<Value extends number> (value: Value) {
  span.addTags({ custom: value })
  v5Span.addTags({ custom: value })
  tracer.startSpan('test', { tags: { custom: value } })
  tracer.init({ tags: { custom: value } })
  tracer.trace('test', { tags: { custom: value } }, () => {})
  tracer.wrap('test', { tags: { custom: value } }, () => {})
  tracer.wrap('test', () => ({ tags: { custom: value } }), () => {})
  tracerV5.startSpan('test', { tags: { custom: value } })
  tracerV5.init({ tags: { custom: value } })
  tracerV5.trace('test', { tags: { custom: value } }, () => {})
  tracerV5.wrap('test', { tags: { custom: value } }, () => {})
  tracerV5.wrap('test', () => ({ tags: { custom: value } }), () => {})
}

void forwardFlatPayload
void forwardNumber

function forwardMetricKey<Key extends 'custom'> (key: Key) {
  span.setTag(key, 42)
  v5Span.setTag(key, 42)
  const concreteKey: 'custom' = key
  span.setTag(concreteKey, 42)
  v5Span.setTag(concreteKey, 42)
}

void forwardMetricKey

declare const boxedSymbol: Symbol

for (const target of [span, v5Span]) {
  // @ts-expect-error Text metadata does not support Date conversion.
  target.setTag('error.message', new Date())
  // @ts-expect-error Whole errors belong in the error tag.
  target.setTag('error.message', new Error('failed'))
  // @ts-expect-error Text metadata does not support regular-expression conversion.
  target.setTag('error.message', /failed/)
  target.setTag('error.message', Buffer.from('failed'))
  target.setTag('error.message', new URL('https://example.com'))
  target.setTag('error.message', bigintTag)
  target.setTag('error.message', Symbol('failed'))
  // @ts-expect-error Text metadata does not support array conversion.
  target.setTag('error.message', ['frame', 42])
  // @ts-expect-error A conversion method does not make an object supported text metadata.
  target.setTag('error.message', { toString: () => 'failed', nested: { value: 1 } })
  // @ts-expect-error Primitive conversion hooks do not make an object supported text metadata.
  target.setTag('error.stack', { [Symbol.toPrimitive]: () => 'frame' })
  // @ts-expect-error Function conversion is outside the text metadata contract.
  target.setTag('error.message', (): string => 'failed')
  // @ts-expect-error HTTP status text does not support object conversion.
  target.setTag('http.status_code', { toString: () => '200' })
  target.setTag('manual.keep', { nested: { value: true } })
  target.setTag('error', { message: 'failed', details: { child: { value: 1 } } })
  target.setTag('error', { message: false, name: { ignored: true } })
  // @ts-expect-error Plain objects stringify to an unhelpful placeholder in text tags.
  target.setTag('error.message', { code: 'failed' })
  // @ts-expect-error An Error-shaped object does not establish a custom string conversion.
  target.setTag('error.message', errorShapedTag)
  // @ts-expect-error Plain objects are not meaningful HTTP status text.
  target.setTag('http.status_code', { status: 200 })
  // @ts-expect-error Text metadata does not support valueOf conversion.
  target.setTag('error.message', { valueOf: () => 42 })
  // @ts-expect-error Boxed primitives are outside the text metadata contract.
  target.setTag('error.message', boxedSymbol)
  target.setTag('error', { message: { code: 'failed' } })
  // @ts-expect-error Map-based tag APIs validate text metadata too.
  target.addTags({ 'error.message': { code: 'failed' } })
}

// @ts-expect-error Span options validate text coercions too.
tracer.startSpan('test', { tags: { 'error.message': { code: 'failed' } } })
// @ts-expect-error Span options validate text coercions too.
tracerV5.startSpan('test', { tags: { 'error.message': { code: 'failed' } } })

function forwardStringConversion<Value extends string> (value: Value) {
  span.setTag('error.message', value)
  v5Span.setTag('error.message', value)
  span.setTag('error.stack', String({ toString: () => value }))
  v5Span.setTag('error.stack', String({ toString: () => value }))
}

void forwardStringConversion

function forwardError<Value extends Error> (value: Value) {
  span.setTag('error', value)
  v5Span.setTag('error', value)
  span.addTags({ error: value })
  v5Span.addTags({ error: value })
  tracer.startSpan('test', { tags: { error: value } })
  tracerV5.startSpan('test', { tags: { error: value } })
  tracer.trace('test', { tags: { error: value } }, () => {})
  tracerV5.trace('test', { tags: { error: value } }, () => {})
  tracer.wrap('test', { tags: { error: value } }, () => {})
  tracerV5.wrap('test', { tags: { error: value } }, () => {})
  tracer.init({ tags: { error: value } })
  tracerV5.init({ tags: { error: value } })
}

void forwardError

// @ts-expect-error The service alias does not support conversion objects.
tracer.startSpan('test', { tags: { service: { toString: () => 'custom-service' } } })
// @ts-expect-error The legacy service alias does not support conversion objects.
tracerV5.startSpan('test', { tags: { service: { toString: () => 'custom-service' } } })
// @ts-expect-error The startSpan service alias converts its whole value to text.
tracer.startSpan('test', { tags: { service: { name: 'custom-service' } } })
// @ts-expect-error The startSpan service alias converts its whole value to text.
tracerV5.startSpan('test', { tags: { service: { name: 'custom-service' } } })

// Ordinary service tags retain their flat-object semantics outside span options.
span.addTags({ service: { name: 'custom-service' } })
v5Span.addTags({ service: { name: 'custom-service' } })
tracerV5.startSpan('test', { tags: [{ service: { name: 'ordinary-tag' } }] })

declare const textConverter: { toString: () => string }
declare const flagObject: { enabled: boolean }
declare const textOrConverter: string | typeof textConverter
declare const flagOrObject: boolean | typeof flagObject
declare const primitiveConverter: { [Symbol.toPrimitive]: () => string }
declare const mixedFlagKey: 'manual.keep' | 'custom'
declare const mixedSemanticKey: 'error.message' | 'manual.keep'

for (const target of [span, v5Span]) {
  target.setTag('error.message', String(textConverter))
  target.setTag('error', 0)
  target.setTag('error', 1)
  target.addTags({ error: 0 })
  target.addTags({ error: 1 })
  target.addTags({ '_dd.measured': 0, '_dd.hostname': 1 })
  target.setTag('error', 2)
  target.setTag('error', -1)
  target.setTag('error', flagObject)
  target.addTags({ error: 2 })
  target.setTag('manual.keep', true)
  target.setTag('manual.drop', false)
  target.setTag('analytics.event', false)
  target.setTag('_dd.measured', 0)
  target.setTag('_dd.measured', 1)
  target.setTag('_dd.hostname', 0)
  target.setTag('_dd.hostname', 1)
  target.setTag('http.status_code', 200)
  target.setTag('error', { message: '', code: 500, cause: { nested: true } })
  target.setTag(mixedFlagKey, false)
  target.setTag(mixedSemanticKey, undefined)
  target.setTag('_dd.measured', 2)
  target.setTag('_dd.hostname', 0.5)
  target.setTag('analytics.event', 0.5)
  target.setTag(mixedFlagKey, 'true')
  target.setTag(mixedSemanticKey, 'true')
  target.setTag(mixedSemanticKey, true)
  // @ts-expect-error Unknown text metadata needs explicit conversion or the whole-error entry point.
  target.setTag('error.message', unknownTag)
  target.setTag('error.message', String(unknownTag))
  target.setTag('manual.keep', unknownTag)
  target.setTag('error', { message: '', code: textConverter })
  target.setTag('error', Object.assign(new Error(''), { code: flagObject }))
  target.setTag('http.status_code', bigintTag)
  // @ts-expect-error Text metadata does not accept conversion objects.
  target.setTag('error.message', textConverter)
  // @ts-expect-error Text metadata does not accept primitive conversion hooks.
  target.setTag('error.stack', primitiveConverter)
  // @ts-expect-error Text metadata does not accept Date conversion.
  target.setTag('error.type', new Date())
  target.setTag('manual.keep', flagObject)
  // @ts-expect-error A primitive union member must not hide an unsupported conversion object.
  target.setTag('error.message', textOrConverter)
  target.setTag('manual.drop', flagOrObject)
  target.setTag('manual.keep', 'true')
  // @ts-expect-error Tag maps do not accept conversion objects for text metadata.
  target.addTags({ 'error.message': textConverter })
  target.addTags({ 'manual.keep': flagObject })
  target.addTags({ 'manual.keep': 'true' })
}

// @ts-expect-error Initialization does not accept conversion objects for text metadata.
tracer.init({ tags: { 'error.message': textConverter } })
// @ts-expect-error Legacy initialization does not accept conversion objects for text metadata.
tracerV5.init({ tags: { 'error.message': textConverter } })
tracer.init({ tags: { 'manual.keep': flagObject } })
tracerV5.init({ tags: { 'manual.keep': flagObject } })
// @ts-expect-error Span options do not accept conversion objects for text metadata.
tracer.startSpan('test', { tags: { 'error.message': textConverter } })
// @ts-expect-error Legacy span options do not accept conversion objects for text metadata.
tracerV5.startSpan('test', { tags: { 'error.message': textConverter } })
tracer.startSpan('test', { tags: { 'manual.keep': flagObject } })
tracerV5.startSpan('test', { tags: { 'manual.keep': flagObject } })
// @ts-expect-error Trace options do not accept conversion objects for text metadata.
tracer.trace('test', { tags: { 'error.message': textConverter } }, () => {})
// @ts-expect-error Legacy trace options do not accept conversion objects for text metadata.
tracerV5.trace('test', { tags: { 'error.message': textConverter } }, () => {})
tracer.trace('test', { tags: { 'manual.keep': flagObject } }, () => {})
tracerV5.trace('test', { tags: { 'manual.keep': flagObject } }, () => {})
// @ts-expect-error Direct wrap options do not accept conversion objects for text metadata.
tracer.wrap('test', { tags: { 'error.message': textConverter } }, () => {})
// @ts-expect-error Legacy direct wrap options do not accept conversion objects for text metadata.
tracerV5.wrap('test', { tags: { 'error.message': textConverter } }, () => {})
tracer.wrap('test', { tags: { 'manual.keep': flagObject } }, () => {})
tracerV5.wrap('test', { tags: { 'manual.keep': flagObject } }, () => {})
// @ts-expect-error Callback options do not accept conversion objects for text metadata.
tracer.wrap('test', () => ({ tags: { 'error.message': textConverter } }), () => {})
// @ts-expect-error Legacy callback options do not accept conversion objects for text metadata.
tracerV5.wrap('test', () => ({ tags: { 'error.message': textConverter } }), () => {})
tracer.wrap('test', () => ({ tags: { 'manual.keep': flagObject } }), () => {})
tracerV5.wrap('test', () => ({ tags: { 'manual.keep': flagObject } }), () => {})
// @ts-expect-error Legacy outer collections do not enable conversion of text metadata values.
v5Span.addTags([{ 'error.message': textConverter }])
tracerV5.startSpan('test', { tags: [{ 'manual.keep': flagObject }] })

tracer.init({ tags: { 'manual.keep': 'true' } })
tracerV5.init({ tags: { 'manual.keep': 'true' } })
tracer.startSpan('test', { tags: { 'manual.keep': 'true' } })
tracerV5.startSpan('test', { tags: { 'manual.keep': 'true' } })
tracer.trace('test', { tags: { 'manual.keep': 'true' } }, () => {})
tracerV5.trace('test', { tags: { 'manual.keep': 'true' } }, () => {})
tracer.wrap('test', { tags: { 'manual.keep': 'true' } }, () => {})
tracerV5.wrap('test', { tags: { 'manual.keep': 'true' } }, () => {})
tracer.wrap('test', () => ({ tags: { 'manual.keep': 'true' } }), () => {})
tracerV5.wrap('test', () => ({ tags: { 'manual.keep': 'true' } }), () => {})

tracer.init({ tags: { error: 0 } })
tracerV5.init({ tags: { error: 0 } })
tracer.startSpan('test', { tags: { error: 1 } })
tracerV5.startSpan('test', { tags: { error: 1 } })
tracer.trace('test', { tags: { error: 0 } }, () => {})
tracerV5.trace('test', { tags: { error: 0 } }, () => {})
tracer.wrap('test', { tags: { error: 1 } }, () => {})
tracerV5.wrap('test', { tags: { error: 1 } }, () => {})
tracer.wrap('test', () => ({ tags: { error: 0 } }), () => {})
tracerV5.wrap('test', () => ({ tags: { error: 0 } }), () => {})
tracer.wrap('test', () => ({ tags: { '_dd.measured': 0, '_dd.hostname': 1 } }), () => {})
tracerV5.wrap('test', () => ({ tags: { '_dd.measured': 0, '_dd.hostname': 1 } }), () => {})
tracerV5.wrap('test', () => ({ tags: 'custom:value' }), () => {})
tracerV5.wrap('test', () => ({ tags: [{ custom: 'value' }] }), () => {})
tracerV5.wrap('test', () => ({ tags: [{ error: 0 }] }), () => {})
tracerV5.wrap('test', () => ({ tags: [[{ '_dd.measured': 1 }], { error: 1 }] }), () => {})
declare const legacyUnknownTags: unknown
declare const legacyUnknownCollection: readonly unknown[]
tracerV5.wrap('test', () => ({ tags: legacyUnknownTags }), () => {})
tracerV5.wrap('test', () => ({ tags: legacyUnknownCollection }), () => {})
tracerV5.wrap('test', () => ({ tags: [[{ error: 2 }]] }), () => {})
tracerV5.wrap('test', () => ({ tags: [{ 'manual.keep': flagObject }] }), () => {})
// @ts-expect-error Legacy callback collections retain the ordinary tag depth limit.
tracerV5.wrap('test', () => ({ tags: [{ custom: { nested: { value: true } } }] }), () => {})
tracer.wrap('test', () => ({ tags: { error: flagObject } }), () => {})
tracerV5.wrap('test', () => ({ tags: { error: flagObject } }), () => {})

function forwardErrorFlag<Flag extends 0 | 1> (flag: Flag) {
  span.setTag('error', flag)
  v5Span.setTag('error', flag)
  span.addTags({ error: flag })
  v5Span.addTags({ error: flag })
  tracer.init({ tags: { error: flag } })
  tracerV5.init({ tags: { error: flag } })
  tracer.startSpan('test', { tags: { error: flag } })
  tracerV5.startSpan('test', { tags: { error: flag } })
  tracer.trace('test', { tags: { error: flag } }, () => {})
  tracerV5.trace('test', { tags: { error: flag } }, () => {})
  tracer.wrap('test', { tags: { error: flag } }, () => {})
  tracerV5.wrap('test', { tags: { error: flag } }, () => {})
  tracer.wrap('test', () => ({ tags: { error: flag } }), () => {})
  tracerV5.wrap('test', () => ({ tags: { error: flag } }), () => {})
}

void forwardErrorFlag

declare const numericPriority: string
declare const primitiveErrorValue: string | number | boolean | bigint | symbol | null | undefined

for (const target of [span, v5Span]) {
  target.setTag('error', 'request failed')
  target.setTag('error', primitiveErrorValue)
  target.setTag('error.message', primitiveErrorValue)
  target.setTag('error.type', 42)
  target.setTag('error.stack', false)
  target.setTag('error', { message: 42, name: false, stack: 1n })
  target.setTag('manual.keep', 0)
  target.setTag('manual.drop', 1)
  target.setTag('analytics.event', 0)
  target.setTag('analytics.event', 1)
  target.setTag('sampling.priority', numericPriority)
  target.setTag('sampling.priority', true)
  target.setTag('http.status_code', 200n)
  target.addTags({ error: 'request failed', 'manual.keep': 0, 'sampling.priority': numericPriority })
}

tracer.init({ tags: { error: 'request failed', 'manual.keep': 1, 'sampling.priority': numericPriority } })
tracerV5.init({ tags: { error: 'request failed', 'manual.keep': 1, 'sampling.priority': numericPriority } })
tracer.startSpan('test', { tags: { error: 'request failed', 'manual.drop': 0, 'sampling.priority': numericPriority } })
tracerV5.startSpan('test', { tags: { error: 'request failed', 'manual.drop': 0, 'sampling.priority': numericPriority } })
tracer.trace('test', { tags: { error: 'request failed', 'manual.keep': 1 } }, () => {})
tracerV5.trace('test', { tags: { error: 'request failed', 'manual.keep': 1 } }, () => {})
tracer.wrap('test', { tags: { error: 'request failed', 'manual.drop': 0 } }, () => {})
tracerV5.wrap('test', { tags: { error: 'request failed', 'manual.drop': 0 } }, () => {})
tracer.wrap('test', () => ({ tags: { error: 'request failed', 'manual.keep': 1 } }), () => {})
tracerV5.wrap('test', () => ({ tags: [[{ error: 'request failed', 'manual.keep': 1 }]] }), () => {})

function forwardPrimitiveError<Value extends typeof primitiveErrorValue> (value: Value) {
  span.setTag('error', value)
  v5Span.setTag('error', value)
  span.setTag('error.message', value)
  v5Span.setTag('error.message', value)
  span.addTags({ error: value, 'error.message': value })
  v5Span.addTags({ error: value, 'error.message': value })
  tracer.startSpan('test', { tags: { error: value } })
  tracerV5.startSpan('test', { tags: { error: value } })
  tracer.wrap('test', () => ({ tags: { error: value } }), () => {})
  tracerV5.wrap('test', () => ({ tags: [{ error: value }] }), () => {})
}

void forwardPrimitiveError

function forwardCaughtError<Value> (error: Value) {
  span.setTag('error', error)
  v5Span.setTag('error', error)
  span.addTags({ error })
  v5Span.addTags({ error })
  tracer.init({ tags: { error } })
  tracerV5.init({ tags: { error } })
  tracer.startSpan('test', { tags: { error } })
  tracerV5.startSpan('test', { tags: { error } })
  tracer.trace('test', { tags: { error } }, () => {})
  tracerV5.trace('test', { tags: { error } }, () => {})
  tracer.wrap('test', { tags: { error } }, () => {})
  tracerV5.wrap('test', { tags: { error } }, () => {})
  tracer.wrap('test', () => ({ tags: { error } }), () => {})
  tracerV5.wrap('test', () => ({ tags: [{ error }] }), () => {})
}

try {
  throw { details: { reason: 'request failed' } }
} catch (error) {
  forwardCaughtError(error)
  span.setTag('error', error)
  v5Span.setTag('error', error)
}

for (const target of [span, v5Span]) {
  target.setTag('error', unknownTag)
  target.setTag('error', () => 'request failed')
  target.setTag('error', [{ details: { reason: 'request failed' } }])
  target.addTags({ error: unknownTag, 'error.message': 'request failed' })
  target.addTags({ error: unknownTag, 'manual.keep': flagObject })
  // @ts-expect-error An arbitrary error must not allow ignored nested ordinary tag data.
  target.addTags({ error: unknownTag, custom: { child: { value: 'ignored' } } })
}

declare const errorOrManualKey: 'error' | 'manual.keep'
span.setTag(errorOrManualKey, 1)
v5Span.setTag(errorOrManualKey, false)
span.setTag(errorOrManualKey, unknownTag)
v5Span.setTag(errorOrManualKey, flagObject)

declare const errorOrServiceKey: 'error' | 'service.name'
// @ts-expect-error A key that could select a service name still requires text.
span.setTag(errorOrServiceKey, unknownTag)
// @ts-expect-error Arbitrary errors must not bypass a possible service-name field.
v5Span.setTag(errorOrServiceKey, flagObject)

for (const target of [span, v5Span]) {
  // @ts-expect-error Sampling priority does not support array coercion.
  target.setTag('sampling.priority', [2])
  // @ts-expect-error Sampling priority does not support string conversion objects.
  target.setTag('sampling.priority', { toString: () => '2' })
  // @ts-expect-error Sampling priority does not support primitive conversion hooks.
  target.setTag('sampling.priority', { [Symbol.toPrimitive]: () => 2 })
  target.setTag('span.kind', { component: 'custom' })
  // @ts-expect-error Tag maps preserve the sampling-priority array exclusion.
  target.addTags({ 'sampling.priority': [2], 'manual.keep': flagObject })
  // @ts-expect-error An arbitrary error must not bypass a string-only field.
  target.addTags({ error: unknownTag, 'service.name': 42 })
  // @ts-expect-error Boxed numbers are outside the supported numeric input contract.
  target.setTag('sampling.priority', new Number(2))
  // @ts-expect-error valueOf-based numeric coercion is not supported.
  target.setTag('sampling.priority', { valueOf: () => 2 })
  // @ts-expect-error Date objects are outside the sampling-priority input contract.
  target.setTag('sampling.priority', new Date(2))
  // @ts-expect-error Explicit scalar handling in ordinary tags does not enable numeric Buffer conversion.
  target.addTags({ 'sampling.priority': Buffer.from('2') })
  // @ts-expect-error Explicit scalar handling in ordinary tags does not enable numeric URL conversion.
  target.addTags({ 'sampling.priority': new URL('https://example.com') })
  // @ts-expect-error Boxed numbers are also excluded from text conversion.
  target.setTag('error.message', new Number(2))
}

function rejectPriorityConversion (value: { toString: () => string }) {
  // @ts-expect-error Conversion objects do not represent a supported sampling priority.
  span.setTag('sampling.priority', value)
  // @ts-expect-error Both declaration surfaces reject conversion objects.
  v5Span.setTag('sampling.priority', value)
  // @ts-expect-error Map validation preserves the priority input boundary.
  span.addTags({ 'sampling.priority': value })
  // @ts-expect-error Legacy map validation preserves the priority input boundary.
  v5Span.addTags({ 'sampling.priority': value })
  // @ts-expect-error Initialization preserves the priority input boundary.
  tracer.init({ tags: { 'sampling.priority': value } })
  // @ts-expect-error Legacy initialization preserves the priority input boundary.
  tracerV5.init({ tags: { 'sampling.priority': value } })
  // @ts-expect-error Span options preserve the priority input boundary.
  tracer.startSpan('test', { tags: { 'sampling.priority': value } })
  // @ts-expect-error Legacy span options preserve the priority input boundary.
  tracerV5.startSpan('test', { tags: { 'sampling.priority': value } })
  // @ts-expect-error Trace options preserve the priority input boundary.
  tracer.trace('test', { tags: { 'sampling.priority': value } }, () => {})
  // @ts-expect-error Legacy trace options preserve the priority input boundary.
  tracerV5.trace('test', { tags: { 'sampling.priority': value } }, () => {})
  // @ts-expect-error Direct wrap options preserve the priority input boundary.
  tracer.wrap('test', { tags: { 'sampling.priority': value } }, () => {})
  // @ts-expect-error Legacy direct wrap options preserve the priority input boundary.
  tracerV5.wrap('test', { tags: { 'sampling.priority': value } }, () => {})
  // @ts-expect-error Callback options preserve the priority input boundary.
  tracer.wrap('test', () => ({ tags: { 'sampling.priority': value } }), () => {})
  // @ts-expect-error Legacy callback collections preserve the priority input boundary.
  tracerV5.wrap('test', () => ({ tags: [{ 'sampling.priority': value }] }), () => {})
}

void rejectPriorityConversion

// @ts-expect-error Initialization must not bypass the boxed-number restriction.
tracer.init({ tags: { 'sampling.priority': new Number(2) } })
// @ts-expect-error Legacy initialization must not bypass the valueOf restriction.
tracerV5.init({ tags: { 'sampling.priority': { valueOf: () => 2 } } })
// @ts-expect-error Span options preserve the boxed-number restriction.
tracer.startSpan('test', { tags: { 'sampling.priority': new Number(2) } })
// @ts-expect-error Trace options preserve the valueOf restriction.
tracerV5.trace('test', { tags: { 'sampling.priority': { valueOf: () => 2 } } }, () => {})
// @ts-expect-error Callback options preserve the boxed-number restriction.
tracer.wrap('test', () => ({ tags: { 'sampling.priority': new Number(2) } }), () => {})
// @ts-expect-error Legacy callback collections preserve the valueOf restriction.
tracerV5.wrap('test', () => ({ tags: [{ 'sampling.priority': { valueOf: () => 2 } }] }), () => {})

// @ts-expect-error Trace service aliases do not support conversion objects.
tracer.trace('test', { tags: { service: { toString: () => 'custom-service' } } }, () => {})
// @ts-expect-error Legacy trace service aliases do not support conversion objects.
tracerV5.trace('test', { tags: { service: { toString: () => 'custom-service' } } }, () => {})
// @ts-expect-error Callback service aliases do not support conversion objects.
tracer.wrap('test', () => ({ tags: { service: { toString: () => 'custom-service' } } }), () => {})
// @ts-expect-error Legacy callback service aliases do not support conversion objects.
tracerV5.wrap('test', () => ({ tags: { service: { toString: () => 'custom-service' } } }), () => {})

declare const priorityOrConversion: number | { [Symbol.toPrimitive]: () => number }

for (const target of [span, v5Span]) {
  // @ts-expect-error A primitive union member must not hide an unsupported conversion object.
  target.setTag('sampling.priority', priorityOrConversion)
}

declare const priorityTuple: readonly [2]
declare const priorityArrayUnion: number | readonly number[]

for (const target of [span, v5Span]) {
  // @ts-expect-error Empty arrays are outside the sampling-priority input contract.
  target.setTag('sampling.priority', [])
  // @ts-expect-error Multiple array elements do not represent a sampling priority.
  target.setTag('sampling.priority', [1, 2])
  // @ts-expect-error Readonly tuples are also arrays.
  target.setTag('sampling.priority', priorityTuple)
  // @ts-expect-error A union must not admit an array priority.
  target.setTag('sampling.priority', priorityArrayUnion)
  // @ts-expect-error An explicit stringifier does not make an array a supported priority.
  target.setTag('sampling.priority', Object.assign([2], { toString: () => '2' }))
  // @ts-expect-error An explicit primitive hook does not make an array a supported priority.
  target.setTag('sampling.priority', Object.assign([2], { [Symbol.toPrimitive]: () => 2 }))
  // @ts-expect-error A neighboring supported scalar must not hide an array priority.
  target.addTags({ 'error.message': 'failed', 'sampling.priority': priorityTuple })
}

// @ts-expect-error Initialization validates array priorities.
tracer.init({ tags: { 'sampling.priority': [2] } })
// @ts-expect-error Legacy initialization validates readonly array priorities.
tracerV5.init({ tags: { 'sampling.priority': priorityTuple } })
// @ts-expect-error Span options validate array priorities.
tracer.startSpan('test', { tags: { 'sampling.priority': [2] } })
// @ts-expect-error Legacy outer tag collections must not bypass the value exclusion.
tracerV5.startSpan('test', { tags: [[{ 'sampling.priority': [2] }]] })
// @ts-expect-error Trace options validate array priorities.
tracer.trace('test', { tags: { 'sampling.priority': [2] } }, () => {})
// @ts-expect-error Legacy trace options validate array priorities.
tracerV5.trace('test', { tags: { 'sampling.priority': priorityTuple } }, () => {})
// @ts-expect-error Direct wrap options validate array priorities.
tracer.wrap('test', { tags: { 'sampling.priority': [2] } }, () => {})
// @ts-expect-error Legacy direct wrap options validate array priorities.
tracerV5.wrap('test', { tags: { 'sampling.priority': priorityTuple } }, () => {})
// @ts-expect-error Callback wrap options validate array priorities.
tracer.wrap('test', () => ({ tags: { 'sampling.priority': [2] } }), () => {})
// @ts-expect-error Legacy callback collections validate array priorities.
tracerV5.wrap('test', () => ({ tags: [{ 'sampling.priority': priorityTuple }] }), () => {})

declare const unionOptions: { tags?: { region: string } } | { tags?: { count: number } }
declare const unionTags: { region: string } | { count: number }
declare const invalidUnionTags: { region: string } | {
  region: string
  payload: { child: { value: string } }
}
declare const invalidUnionOptions: { tags: { region: string } } | { tags: typeof invalidUnionTags }

span.addTags(unionTags)
v5Span.addTags(unionTags)
tracer.startSpan('union', unionOptions)
tracerV5.startSpan('union', unionOptions)
tracer.init(unionOptions)
tracerV5.init(unionOptions)
tracer.trace('union', unionOptions, () => {})
tracerV5.trace('union', unionOptions, () => {})
tracer.wrap('union', unionOptions, () => {})
tracerV5.wrap('union', unionOptions, () => {})
tracer.wrap('union', () => unionOptions, () => {})
tracerV5.wrap('union', () => unionOptions, () => {})

// @ts-expect-error A supported union member must not hide ignored nested data in another member.
span.addTags(invalidUnionTags)
// @ts-expect-error Legacy maps validate every union member too.
v5Span.addTags(invalidUnionTags)
// @ts-expect-error Optional tag maps must not hide an unsupported member.
tracer.startSpan('union', invalidUnionOptions)
// @ts-expect-error Legacy options must not hide an unsupported member.
tracerV5.startSpan('union', invalidUnionOptions)
// @ts-expect-error Initialization validates every tag-map union member.
tracer.init(invalidUnionOptions)
// @ts-expect-error Legacy initialization validates every tag-map union member.
tracerV5.init(invalidUnionOptions)
// @ts-expect-error Trace options validate every tag-map union member.
tracer.trace('union', invalidUnionOptions, () => {})
// @ts-expect-error Legacy trace options validate every tag-map union member.
tracerV5.trace('union', invalidUnionOptions, () => {})
// @ts-expect-error Direct wrap options validate every tag-map union member.
tracer.wrap('union', invalidUnionOptions, () => {})
// @ts-expect-error Legacy direct wrap options validate every tag-map union member.
tracerV5.wrap('union', invalidUnionOptions, () => {})
// @ts-expect-error Dynamic wrap options validate every tag-map union member.
tracer.wrap('union', () => invalidUnionOptions, () => {})
// @ts-expect-error Legacy dynamic wrap options validate every tag-map union member.
tracerV5.wrap('union', () => invalidUnionOptions, () => {})

const tracedCount: number = tracer.trace('test', unionOptions, () => 42)
const v5TracedCount: number = tracerV5.trace('test', unionOptions, () => 42)
const wrappedLength: (name: string) => number = tracer.wrap('test', unionOptions, (name: string) => name.length)
const v5WrappedLength: (name: string) => number = tracerV5.wrap('test', unionOptions, (name: string) => name.length)

void tracedCount
void v5TracedCount
void wrappedLength
void v5WrappedLength

const explicitTraceCount = tracer.trace<number>('test', { tags: { region: 'eu' } }, () => 42)
const explicitWrappedLength = tracer.wrap<(name: string) => number>(
  'test', { tags: { region: 'eu' } }, (name: string) => name.length
)
const annotatedV5Options = (): tracerV5.SpanOptions => ({ tags: { region: 'eu' } })
tracerV5.wrap('test', annotatedV5Options, () => {})
tracerV5.startSpan('legacy', { tags: legacyUnknownTags })
tracerV5.trace('legacy', { tags: legacyUnknownTags }, () => {})

void explicitTraceCount
void explicitWrappedLength

declare const legacyFunctionTags: () => { region: string }
declare const legacyCallableTags: (() => void) & { region: string }
declare const legacyCallableUnion: { region: string } | typeof legacyFunctionTags
declare const invalidLegacyCallableTags: (() => void) & { payload: { child: { value: string } } }
declare const rootFunctionTags: Function
declare class RootTagConstructor { static region: string }

for (const target of [span, v5Span]) {
  // @ts-expect-error Class constructors are also root functions, regardless of static properties.
  target.addTags(RootTagConstructor)
  // @ts-expect-error A broad function annotation does not make a function a tag map.
  target.addTags(rootFunctionTags)
}

// @ts-expect-error Legacy span options ignore a class constructor as a root collection.
tracerV5.startSpan('legacy', { tags: RootTagConstructor })
// @ts-expect-error Broadly annotated root functions are ignored as well.
tracerV5.startSpan('legacy', { tags: rootFunctionTags })

// @ts-expect-error A function is not a legacy tag collection.
v5Span.addTags(legacyFunctionTags)
// @ts-expect-error Span options ignore function-valued collections.
tracerV5.startSpan('legacy', { tags: legacyFunctionTags })
// @ts-expect-error A root callable's properties are ignored too.
tracerV5.startSpan('legacy', { tags: legacyCallableTags })
// @ts-expect-error A valid map must not hide an ignored function in another union member.
tracerV5.startSpan('legacy', { tags: legacyCallableUnion })
// @ts-expect-error Trace options ignore function-valued collections.
tracerV5.trace('legacy', { tags: legacyFunctionTags }, () => {})
// @ts-expect-error Direct wrap options ignore function-valued collections.
tracerV5.wrap('legacy', { tags: legacyFunctionTags }, () => {})
// @ts-expect-error A dynamic options producer must return actual tag data.
tracerV5.wrap('legacy', () => ({ tags: legacyFunctionTags }), () => {})

v5Span.addTags([legacyCallableTags])
tracerV5.startSpan('legacy', { tags: [[legacyCallableTags]] })
tracerV5.trace('legacy', { tags: [legacyCallableTags] }, () => {})
tracerV5.wrap('legacy', { tags: [legacyCallableTags] }, () => {})
tracerV5.wrap('legacy', () => ({ tags: [legacyCallableTags] }), () => {})

// @ts-expect-error Callable collection entries must not hide ignored nested data.
v5Span.addTags([invalidLegacyCallableTags])
// @ts-expect-error Nested option collections validate callable data properties.
tracerV5.startSpan('legacy', { tags: [[invalidLegacyCallableTags]] })
// @ts-expect-error Trace collections validate callable data properties.
tracerV5.trace('legacy', { tags: [invalidLegacyCallableTags] }, () => {})
// @ts-expect-error Direct wrap collections validate callable data properties.
tracerV5.wrap('legacy', { tags: [invalidLegacyCallableTags] }, () => {})
// @ts-expect-error Dynamic wrap collections validate callable data properties.
tracerV5.wrap('legacy', () => ({ tags: [invalidLegacyCallableTags] }), () => {})

function forwardMetricMaps<Key extends 'cpu' | 'memory'> (tags: Record<Key, number>) {
  span.addTags(tags)
  v5Span.addTags(tags)
  tracer.init({ tags })
  tracerV5.init({ tags })
  tracer.startSpan('metrics', { tags })
  tracerV5.startSpan('metrics', { tags })
  tracer.trace('metrics', { tags }, () => 1)
  tracerV5.trace('metrics', { tags }, () => 1)
  tracer.wrap('metrics', { tags }, () => 1)
  tracerV5.wrap('metrics', { tags }, () => 1)
  tracer.wrap('metrics', () => ({ tags }), () => 1)
  tracerV5.wrap('metrics', () => ({ tags }), () => 1)
}

function forwardPrefixedMetrics<Key extends `metrics.${string}`> (tags: Record<Key, number>) {
  span.addTags(tags)
  v5Span.addTags(tags)
  tracer.init({ tags })
  tracerV5.init({ tags })
  tracer.startSpan('metrics', { tags })
  tracerV5.startSpan('metrics', { tags })
  tracer.trace('metrics', { tags }, () => 1)
  tracerV5.trace('metrics', { tags }, () => 1)
  tracer.wrap('metrics', { tags }, () => 1)
  tracerV5.wrap('metrics', { tags }, () => 1)
  tracer.wrap('metrics', () => ({ tags }), () => 1)
  tracerV5.wrap('metrics', () => ({ tags }), () => 1)
}

function forwardScalarMaps<Tags extends Record<string, string | number | boolean | Buffer | URL | null | undefined>> (
  tags: Tags
) {
  span.addTags(tags)
  v5Span.addTags(tags)
  tracer.init({ tags })
  tracerV5.init({ tags })
  tracer.startSpan('scalars', { tags })
  tracerV5.startSpan('scalars', { tags })
  tracer.trace('scalars', { tags }, () => 1)
  tracerV5.trace('scalars', { tags }, () => 1)
  tracer.wrap('scalars', { tags }, () => 1)
  tracerV5.wrap('scalars', { tags }, () => 1)
  tracer.wrap('scalars', () => ({ tags }), () => 1)
  tracerV5.wrap('scalars', () => ({ tags }), () => 1)
}

void forwardMetricMaps
void forwardPrefixedMetrics
void forwardScalarMaps

function forwardOptionalTagOptions<Options extends { tags?: Record<string, string> }> (options: Options) {
  tracer.startSpan('optional', options)
  tracerV5.startSpan('optional', options)
  tracer.init(options)
  tracerV5.init(options)
  tracer.trace('optional', options, () => 42)
  tracerV5.trace('optional', options, () => 42)
  tracer.wrap('optional', () => options, () => 42)
  tracerV5.wrap('optional', () => options, () => 42)
}

void forwardOptionalTagOptions

tracer.init({ tags: { service: 'custom-service', custom: { id: '42' } } })
tracerV5.init({ tags: { service: 'custom-service', custom: { id: '42' } } })
// @ts-expect-error Initialization uses the service tag as a service name without converting an object.
tracer.init({ tags: { service: { name: 'custom-service' } } })
// @ts-expect-error Legacy initialization also uses the unconverted service alias.
tracerV5.init({ tags: { service: { name: 'custom-service' } } })
// @ts-expect-error Initialization does not support custom string conversion for the service alias.
tracer.init({ tags: { service: { toString: () => 'custom-service' } } })
// @ts-expect-error Legacy initialization does not support custom string conversion for the service alias.
tracerV5.init({ tags: { service: { toString: () => 'custom-service' } } })
// @ts-expect-error A numeric service alias cannot be used as a service name.
tracer.init({ tags: { service: 42 } })
// @ts-expect-error A numeric legacy service alias cannot be used as a service name.
tracerV5.init({ tags: { service: 42 } })

declare const processUnion: { priority: string } | { priority: string, payload: { businessKey: string } }
declare const flatUnion: { priority: string } | { priority: string, code: number }
declare const scalarOrFlat: string | number | boolean | Buffer | URL | { priority: string }
declare const numericArrays: Uint8Array | Float32Array
declare const nestedNumericArray: Uint8Array | (Uint8Array & { payload: { businessKey: string } })
declare const arrayOrLength: { length: number } | readonly number[]
declare const bigintOrMethod: bigint | { toString: () => string, count: number }
declare const boxedNumberOrFlat: Number | { id: string }

for (const target of [span, v5Span]) {
  target.setTag('custom', { id: '42', toString () { return 'ignored' } })
  target.setTag('custom', Object.assign(() => 'ignored', { id: '42' }))
  // @ts-expect-error Boxed numbers are outside the supported tag value contract.
  target.setTag('custom', new Number(2))
  // @ts-expect-error Tag maps do not add support for boxed numbers.
  target.addTags({ custom: new Number(2) })
  // @ts-expect-error A useful flat union member must not hide a boxed number.
  target.setTag('custom', boxedNumberOrFlat)
}

// @ts-expect-error Initialization does not support boxed numbers as ordinary tag values.
tracer.init({ tags: { custom: new Number(2) } })
// @ts-expect-error Legacy initialization does not support boxed numbers as ordinary tag values.
tracerV5.init({ tags: { custom: new Number(2) } })
// @ts-expect-error Per-span options do not support boxed numbers as ordinary tag values.
tracer.startSpan('boxed', { tags: { custom: new Number(2) } })
// @ts-expect-error Legacy per-span options do not support boxed numbers as ordinary tag values.
tracerV5.startSpan('boxed', { tags: { custom: new Number(2) } })
// @ts-expect-error Trace options do not support boxed numbers as ordinary tag values.
tracer.trace('boxed', { tags: { custom: new Number(2) } }, () => 1)
// @ts-expect-error Legacy trace options do not support boxed numbers as ordinary tag values.
tracerV5.trace('boxed', { tags: { custom: new Number(2) } }, () => 1)
// @ts-expect-error Direct wrap options do not support boxed numbers as ordinary tag values.
tracer.wrap('boxed', { tags: { custom: new Number(2) } }, () => 1)
// @ts-expect-error Legacy direct wrap options do not support boxed numbers as ordinary tag values.
tracerV5.wrap('boxed', { tags: { custom: new Number(2) } }, () => 1)
// @ts-expect-error Callback options do not support boxed numbers as ordinary tag values.
tracer.wrap('boxed', () => ({ tags: { custom: new Number(2) } }), () => 1)
// @ts-expect-error Legacy callback collections do not support boxed numbers as ordinary tag values.
tracerV5.wrap('boxed', () => ({ tags: [{ custom: new Number(2) }] }), () => 1)

for (const target of [span, v5Span]) {
  target.setTag('process', flatUnion)
  target.setTag('process', scalarOrFlat)
  target.setTag('process', numericArrays)
  // @ts-expect-error Every known object-value union member must obey the depth boundary.
  target.setTag('process', processUnion)
  // @ts-expect-error Tag maps validate every known object-value union member.
  target.addTags({ process: processUnion })
  // @ts-expect-error Numeric typed-array unions still validate additional known properties.
  target.setTag('process', nestedNumericArray)
  // @ts-expect-error A flat object branch must not hide an ignored array member.
  target.setTag('process', arrayOrLength)
  // @ts-expect-error A flat object branch must not hide an ignored bigint member.
  target.setTag('process', bigintOrMethod)
}

// @ts-expect-error Initialization validates every known object-value union member.
tracer.init({ tags: { process: processUnion } })
// @ts-expect-error Legacy initialization validates every known object-value union member.
tracerV5.init({ tags: { process: processUnion } })
// @ts-expect-error Per-span options validate every known object-value union member.
tracer.startSpan('union', { tags: { process: processUnion } })
// @ts-expect-error Legacy per-span options validate every known object-value union member.
tracerV5.startSpan('union', { tags: { process: processUnion } })
// @ts-expect-error Trace options validate every known object-value union member.
tracer.trace('union', { tags: { process: processUnion } }, () => 1)
// @ts-expect-error Legacy trace options validate every known object-value union member.
tracerV5.trace('union', { tags: { process: processUnion } }, () => 1)
// @ts-expect-error Direct wrap options validate every known object-value union member.
tracer.wrap('union', { tags: { process: processUnion } }, () => 1)
// @ts-expect-error Legacy direct wrap options validate every known object-value union member.
tracerV5.wrap('union', { tags: { process: processUnion } }, () => 1)
// @ts-expect-error Callback options validate every known object-value union member.
tracer.wrap('union', () => ({ tags: { process: processUnion } }), () => 1)
// @ts-expect-error Legacy callback collections validate every known object-value union member.
tracerV5.wrap('union', () => ({ tags: [{ process: processUnion }] }), () => 1)

for (const target of [span, v5Span]) {
  // @ts-expect-error A scalar map must still respect reserved string-only fields.
  target.addTags({ 'resource.name': 1 })
  // @ts-expect-error A scalar map must still respect reserved string-only fields.
  target.addTags({ 'span.type': true })
  // @ts-expect-error The scalar map fallback must not permit Buffer priorities.
  target.addTags({ cpu: 1, 'sampling.priority': Buffer.from('2') })
  // @ts-expect-error The scalar map fallback must not permit URL priorities.
  target.addTags({ cpu: 1, 'sampling.priority': new URL('https://example.com') })
}

// @ts-expect-error Initialization scalar maps must preserve the priority primitive boundary.
tracer.init({ tags: { 'sampling.priority': Buffer.from('2') } })
// @ts-expect-error Legacy initialization scalar maps preserve the priority primitive boundary.
tracerV5.init({ tags: { 'sampling.priority': Buffer.from('2') } })
// @ts-expect-error Span-option scalar maps preserve the priority primitive boundary.
tracer.startSpan('test', { tags: { 'sampling.priority': Buffer.from('2') } })
// @ts-expect-error Legacy span-option scalar maps preserve the priority primitive boundary.
tracerV5.startSpan('test', { tags: { 'sampling.priority': Buffer.from('2') } })
// @ts-expect-error Trace scalar maps preserve the priority primitive boundary.
tracer.trace('test', { tags: { 'sampling.priority': Buffer.from('2') } }, () => {})
// @ts-expect-error Legacy trace scalar maps preserve the priority primitive boundary.
tracerV5.trace('test', { tags: { 'sampling.priority': Buffer.from('2') } }, () => {})
// @ts-expect-error Direct wrap scalar maps preserve the priority primitive boundary.
tracer.wrap('test', { tags: { 'sampling.priority': Buffer.from('2') } }, () => {})
// @ts-expect-error Legacy direct wrap scalar maps preserve the priority primitive boundary.
tracerV5.wrap('test', { tags: { 'sampling.priority': Buffer.from('2') } }, () => {})
// @ts-expect-error Callback scalar maps preserve the priority primitive boundary.
tracer.wrap('test', () => ({ tags: { 'sampling.priority': Buffer.from('2') } }), () => {})
// @ts-expect-error Legacy callback scalar maps preserve the priority primitive boundary.
tracerV5.wrap('test', () => ({ tags: [{ 'sampling.priority': Buffer.from('2') }] }), () => {})
