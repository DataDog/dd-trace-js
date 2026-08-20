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
}

interface EmptyTags {}

interface ErrorMetaTags {
  'error.type': Error
  'error.message': Error
  'error.stack': Error
}

type TagUnion = { supported: string } | { unsupported: { nested: { value: string } } }

declare const span: Span
declare const errorKey: 'error' | 'error.details'
declare const errorMetaKey: 'error.type' | 'error.message' | 'error.stack'
declare const mixedErrorMetaKey: 'error.message' | 'error.details'
declare const errorOrBoolean: Error | boolean
declare const errorMetaTags: ErrorMetaTags
declare const emptyTags: EmptyTags
declare const opaqueObject: object
declare const tagObject: TagObject
declare const tags: Tags
declare const tagUnion: TagUnion
declare const v5Span: ReturnType<typeof tracerV5.startSpan>

span.setTag('string', 'value')
span.setTag('number', 1)
span.setTag('boolean', true)
span.setTag('error', new Error('boom'))
span.setTag('buffer', Buffer.from('value'))
span.setTag('url', new URL('https://example.com'))
span.setTag('object', tagObject)
span.setTag('error', errorOrBoolean)
span.setTag('error.message', new Error('boom'))
span.setTag(errorMetaKey, new Error('boom'))
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
const defaultSpanOptions: SpanOptions = { tags: { error: new Error('boom') } }
const tracerOptions: TracerOptions = { customOption: true, tags: { string: 'value' } }
const tracerOptionsWithError: TracerOptions = { tags: { error: new Error('boom') } }
const tracerOptionsWithNamedTags: TracerOptions = { tags }
tracer.startSpan('test', spanOptions)
tracer.startSpan('test', defaultSpanOptions)
tracer.init(tracerOptions)
tracer.init(tracerOptionsWithError)
tracer.init(tracerOptionsWithNamedTags)
void spanOptions
void defaultSpanOptions
void tracerOptions
void tracerOptionsWithError
void tracerOptionsWithNamedTags

// @ts-expect-error Nested object tag values are not supported.
span.setTag('nested', { child: { value: 'value' } })
// @ts-expect-error Array tag values are not supported.
span.setTag('array', ['value'])
// @ts-expect-error Function tag values are not supported.
span.setTag('function', () => {})
// @ts-expect-error Date tag values are not supported.
span.setTag('date', new Date())
// @ts-expect-error Values typed only as object may contain unsupported nested values.
span.setTag('object', opaqueObject)
// @ts-expect-error Error objects are not supported by ordinary tags.
span.setTag('error.details', new Error('boom'))
// @ts-expect-error Error objects require a key known to support them.
span.setTag(errorKey, new Error('boom'))
// @ts-expect-error Error objects are not supported by ordinary tags.
span.addTags({ 'error.details': new Error('boom') })
// @ts-expect-error Error metadata tags do not support null values.
span.setTag('error.message', null)
// @ts-expect-error Error metadata tags do not support undefined values.
span.setTag('error.type', undefined)
// @ts-expect-error Error objects require a key known to support them.
span.setTag(mixedErrorMetaKey, new Error('boom'))
// @ts-expect-error Null tag values are not supported.
span.setTag('null', null)
// @ts-expect-error Undefined tag values are not supported.
span.setTag('undefined', undefined)
// @ts-expect-error Nested object tag values are not supported.
span.addTags({ nested: { child: { value: 'value' } } })
// @ts-expect-error Arrays are not tag maps.
span.addTags(['value'])
// @ts-expect-error Functions are not tag maps.
span.addTags(() => {})
// @ts-expect-error Unsupported members of tag unions are not supported.
span.addTags(tagUnion)
// @ts-expect-error Nested object tag values are not supported.
tracer.startSpan('test', { tags: { nested: { child: { value: 'value' } } } })
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
v5Span.setTag('error', errorOrBoolean)
v5Span.setTag('error.message', new Error('boom'))
v5Span.setTag(errorMetaKey, new Error('boom'))
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
const v5TracerOptionsWithError: tracerV5.TracerOptions = { tags: { error: new Error('boom') } }
const v5TracerOptionsWithNamedTags: tracerV5.TracerOptions = { tags }
tracerV5.startSpan('test', v5SpanOptions)
tracerV5.init(v5TracerOptionsWithError)
tracerV5.init(v5TracerOptionsWithNamedTags)
void v5SpanOptions
void v5TracerOptionsWithError
void v5TracerOptionsWithNamedTags

// @ts-expect-error Nested object tag values are not supported.
v5Span.setTag('nested', { child: { value: 'value' } })
// @ts-expect-error Values typed only as object may contain unsupported nested values.
v5Span.setTag('object', opaqueObject)
// @ts-expect-error Error objects are not supported by ordinary tags.
v5Span.setTag('error.details', new Error('boom'))
// @ts-expect-error Error objects require a key known to support them.
v5Span.setTag(errorKey, new Error('boom'))
// @ts-expect-error Error objects are not supported by ordinary tags.
v5Span.addTags({ 'error.details': new Error('boom') })
// @ts-expect-error Error metadata tags do not support null values.
v5Span.setTag('error.message', null)
// @ts-expect-error Error metadata tags do not support undefined values.
v5Span.setTag('error.type', undefined)
// @ts-expect-error Error objects require a key known to support them.
v5Span.setTag(mixedErrorMetaKey, new Error('boom'))
// @ts-expect-error Nested object tag values are not supported.
v5Span.addTags({ nested: { child: { value: 'value' } } })
// @ts-expect-error Arrays are not tag maps.
v5Span.addTags(['value'])
// @ts-expect-error Functions are not tag maps.
v5Span.addTags(() => {})
// @ts-expect-error Unsupported members of tag unions are not supported.
v5Span.addTags(tagUnion)
// @ts-expect-error Nested object tag values are not supported.
tracerV5.startSpan('test', { tags: { nested: { child: { value: 'value' } } } })
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
