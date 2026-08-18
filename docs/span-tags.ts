import tracer, { Span, SpanOptions, SpanTags, TracerOptions } from '..'
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

type TagUnion = { supported: string } | { unsupported: { nested: { value: string } } }

declare const span: Span
declare const errorKey: 'error' | 'error.details'
declare const errorOrBoolean: Error | boolean
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
span.addTags({ error: new Error('boom') })
span.addTags({ error: errorOrBoolean })
span.addTags(tags)
tracer.startSpan('test', { tags })
tracer.trace('test', { tags }, () => {})
tracer.wrap('test', { tags }, () => {})
tracer.wrap('test', () => ({ tags }), () => {})
tracer.init({ tags })

const spanTags: SpanTags<Tags> = tags
const spanOptions: SpanOptions<Tags> = { tags }
const defaultSpanTags: SpanTags = { error: new Error('boom') }
const defaultSpanOptions: SpanOptions = { tags: { error: new Error('boom') } }
const tracerOptions: TracerOptions = { customOption: true, tags: { string: 'value' } }
const tracerOptionsWithError: TracerOptions = { tags: { error: new Error('boom') } }
const tracerOptionsWithNamedTags: TracerOptions = { tags }
void spanTags
void spanOptions
void defaultSpanTags
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
// @ts-expect-error Error objects are only supported by the error tag.
span.setTag('error.details', new Error('boom'))
// @ts-expect-error Error objects require a key known to be exactly error.
span.setTag(errorKey, new Error('boom'))
// @ts-expect-error Error objects are only supported by the error tag.
span.addTags({ 'error.details': new Error('boom') })
// @ts-expect-error Null tag values are not supported.
span.setTag('null', null)
// @ts-expect-error Undefined tag values are not supported.
span.setTag('undefined', undefined)
// @ts-expect-error Nested object tag values are not supported.
span.addTags({ nested: { child: { value: 'value' } } })
// @ts-expect-error Unsupported members of tag unions are not supported.
const unsupportedTagUnion: SpanTags<TagUnion> = tagUnion
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

v5Span.setTag('object', tagObject)
v5Span.setTag('error', errorOrBoolean)
v5Span.addTags({ error: new Error('boom') })
v5Span.addTags({ error: errorOrBoolean })
v5Span.addTags(tags)
tracerV5.startSpan('test', { tags })
tracerV5.trace('test', { tags }, () => {})
tracerV5.wrap('test', { tags }, () => {})
tracerV5.wrap('test', () => ({ tags }), () => {})
tracerV5.init({ customOption: true, tags })

const v5SpanTags: tracerV5.SpanTags = { error: new Error('boom') }
const v5SpanOptions: tracerV5.SpanOptions = { tags: { error: new Error('boom') } }
const v5TracerOptionsWithError: tracerV5.TracerOptions = { tags: { error: new Error('boom') } }
const v5TracerOptionsWithNamedTags: tracerV5.TracerOptions = { tags }
void v5SpanTags
void v5SpanOptions
void v5TracerOptionsWithError
void v5TracerOptionsWithNamedTags

// @ts-expect-error Nested object tag values are not supported.
v5Span.setTag('nested', { child: { value: 'value' } })
// @ts-expect-error Values typed only as object may contain unsupported nested values.
v5Span.setTag('object', opaqueObject)
// @ts-expect-error Error objects are only supported by the error tag.
v5Span.setTag('error.details', new Error('boom'))
// @ts-expect-error Error objects require a key known to be exactly error.
v5Span.setTag(errorKey, new Error('boom'))
// @ts-expect-error Error objects are only supported by the error tag.
v5Span.addTags({ 'error.details': new Error('boom') })
// @ts-expect-error Nested object tag values are not supported.
v5Span.addTags({ nested: { child: { value: 'value' } } })
// @ts-expect-error Unsupported members of tag unions are not supported.
const unsupportedV5TagUnion: tracerV5.SpanTags<TagUnion> = tagUnion
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
