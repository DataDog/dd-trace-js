type SpanTagScalar = string | number | boolean | Buffer | URL | null | undefined
type SpanTagLeaf = SpanTagScalar | ((...args: never[]) => unknown)
type SpanTagText = string | null | undefined
type SpanTagTextValue = SpanTagScalar | bigint | symbol
type SpanTagNumberPrimitive = string | number | boolean | null | undefined
type SpecialSpanTagValues = {
  '_dd.hostname': unknown
  '_dd.measured': unknown
  'analytics.event': unknown
  error: unknown
  'error.message': SpanTagTextValue
  'error.stack': SpanTagTextValue
  'error.type': SpanTagTextValue
  'http.status_code': SpanTagTextValue
  'manual.drop': unknown
  'manual.keep': unknown
  'resource.name': SpanTagText
  'sampling.priority': SpanTagNumberPrimitive
  'service.name': SpanTagText
  'span.type': SpanTagText
}

export type SpecialSpanTags = {
  [Key in keyof SpecialSpanTagValues]?: SpecialSpanTagValues[Key]
}
export type LegacySpanTagsContext = SpecialSpanTags | string | readonly LegacySpanTagsContext[]

// TypeScript does not encode property ownership or enumerability. Class methods and symbol brands do not add tag data.
type ValidatedSpanTagObject<Value extends object> = {
  [Key in SpanTagMapKeys<Value>]?: Key extends symbol ? SpanTagMapValue<Value, Key> :
    unknown extends SpanTagMapValue<Value, Key> ? SpanTagMapValue<Value, Key> : SpanTagLeaf
}
type SpanTagObjectMembers<Value> =
  Value extends SpanTagScalar | readonly unknown[] ? never :
  Value extends ArrayBufferView & ArrayLike<number> ? Omit<Value, 'buffer'> :
  Value extends object ? Value : never
type ValidatedSpanTagValue<Value, AllValue = Value> =
  unknown extends Value ? Value :
  [Extract<AllValue, readonly unknown[] | bigint | symbol | (Number & object)>] extends [never] ?
  Value extends SpanTagScalar ? Value :
  Value extends object ? ValidatedSpanTagObject<SpanTagObjectMembers<AllValue>> :
  never : never
type SpanTagValueForSingleKey<Key, Value> =
  Key extends keyof SpecialSpanTagValues ? SpecialSpanTagValues[Key] : ValidatedSpanTagValue<Value>

export type SpanTagValueForKey<Key, Value> =
  | ((
    Key extends unknown ? (value: SpanTagValueForSingleKey<Key, Value>) => void : never
  ) extends (value: infer Input) => void ? Input : never)
  | SpanTagInputForKey<Key>

export type SpanTagNumericKey<Key extends string> = Exclude<Key, {
  [Name in keyof SpecialSpanTagValues]: number extends SpecialSpanTagValues[Name] ? never : Name
}[keyof SpecialSpanTagValues]>

export type SpanTagInputForKey<Key> = SpanTagText | KeyedSpanTagInput<Key>
type KeyedSpanTagInput<Key> = (
  Key extends keyof SpecialSpanTagValues
    ? (value: SpecialSpanTagValues[Key]) => void
    : (value: SpanTagScalar | Record<string, SpanTagLeaf>) => void
) extends (value: infer Input) => void ? Input : never

type SpanTagScalarMap = Record<string, SpanTagScalar> & SpecialSpanTags
type SpanTagScalarCollection = string | SpanTagScalarMap | readonly SpanTagScalarCollection[]
type SpanTagMapKeys<Tags> = Tags extends unknown ? keyof Tags : never
type SpanTagMapValue<Tags, Key> = Tags extends unknown ? Key extends keyof Tags ? Tags[Key] : never : never
type SpanTagMapMembers<Tags> =
  Tags extends readonly unknown[] ? never : Tags extends object ? Pick<Tags, keyof Tags> : never
type ValidatedSpanTagMap<Tags extends object, ServiceAlias extends boolean = false> = SpanTagScalarMap | Tags & (
  [Extract<Tags, readonly unknown[] | Function>] extends [never] ? {
    [Key in SpanTagMapKeys<Tags>]?: Key extends symbol ? SpanTagMapValue<Tags, Key> :
      SpanTagValueForKey<ServiceAlias extends true ? Key extends 'service' ? 'error.message' : Key : Key,
        SpanTagMapValue<Tags, Key>>
  } : never)

export type ValidatedSpanTags<Tags extends object> = ValidatedSpanTagMap<Tags>

export type ValidatedSpanOptionsTags<Tags extends object> = ValidatedSpanTagMap<Tags, true>

export type ValidatedLegacySpanOptionsTags<Tags, AllTags = Tags> = SpanTagScalarCollection | (
  [Extract<Tags, Function>] extends [never] ?
  unknown extends Tags ? Tags :
  Tags extends string | readonly unknown[] ? ValidatedLegacySpanTags<Tags> :
  Tags extends object ? ValidatedSpanOptionsTags<SpanTagMapMembers<AllTags>> : never : never)

type ValidatedTagCollection<Tags, AllTags = Tags> =
  unknown extends Tags ? Tags :
  Tags extends string ? Tags :
  Tags extends readonly unknown[] ? { [Index in keyof Tags]: ValidatedTagCollection<Tags[Index]> } :
  Tags extends object ? ValidatedSpanTagMap<SpanTagMapMembers<AllTags>> : never

export type ValidatedLegacySpanTags<Tags> = SpanTagScalarCollection | (
  [Extract<Tags, Function>] extends [never] ? ValidatedTagCollection<Tags> : never)

export type SpanOptionsTags<Options> = Options extends { tags?: infer Tags } ? Tags : object

// Prevent validation from narrowing inference without requiring TypeScript's NoInfer intrinsic.
export type NoInferSpanTags<Tags> = [Tags][Tags extends unknown ? 0 : never]
