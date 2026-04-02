import type { GeneratedConfig } from './generated-config-types'

type PayloadTaggingRules = ReturnType<typeof import('../payload-tagging/config').appendRules> | []

export interface ConfigProperties extends GeneratedConfig {
  cloudPayloadTagging: GeneratedConfig['cloudPayloadTagging'] & {
    requestsEnabled: boolean
    responsesEnabled: boolean
    rules: PayloadTaggingRules
  }
  commitSHA: string | undefined
  debug: boolean
  gcpPubSubPushSubscriptionEnabled: boolean
  instrumentationSource: 'manual' | 'ssi'
  isAzureFunction: boolean
  isCiVisibility: boolean
  isGCPFunction: boolean
  isServiceNameInferred: boolean
  isServiceUserProvided: boolean
  logger: import('../../../../index').TracerOptions['logger'] | undefined
  lookup: NonNullable<import('../../../../index').TracerOptions['lookup']>
  readonly parsedDdTags: Record<string, string>
  plugins: boolean
  repositoryUrl: string | undefined
  rules: import('../../../../index').SamplingRule[]
  sampler: {
    rateLimit: number
    rules: import('../../../../index').SamplingRule[]
    sampleRate: number | undefined
    spanSamplingRules: import('../../../../index').SpanSamplingRule[] | undefined
  }
  stableConfig: {
    fleetEntries: Record<string, string>
    localEntries: Record<string, string>
    warnings: string[] | undefined
  }
  tracePropagationStyle: GeneratedConfig['tracePropagationStyle']
}

type Primitive = bigint | boolean | null | number | string | symbol | undefined
type Terminal = Date | Function | Primitive | RegExp | URL

type KnownStringKeys<T> = Extract<{
  [K in keyof T]:
    K extends string
      ? string extends K
        ? never
        : K
      : never
}[keyof T], string>

type NestedConfigPath<T> = [NonNullable<T>] extends [Terminal]
  ? never
  : [NonNullable<T>] extends [readonly unknown[]]
    ? never
    : [NonNullable<T>] extends [object]
      ? ConfigPathFor<NonNullable<T>>
      : never

type ConfigPathFor<T> = {
  [K in KnownStringKeys<T>]:
    | K
    | (NestedConfigPath<T[K]> extends never ? never : `${K}.${NestedConfigPath<T[K]>}`)
}[KnownStringKeys<T>]

type ConfigPathValueFor<T, TPath extends string> =
  TPath extends `${infer TKey}.${infer TRest}`
    ? TKey extends KnownStringKeys<T>
      ? ConfigPathValueFor<NonNullable<T[TKey]>, TRest>
      : never
    : TPath extends KnownStringKeys<T>
      ? T[TPath]
      : never

export type ConfigKey = KnownStringKeys<ConfigProperties>
export type ConfigPath = ConfigPathFor<ConfigProperties>
export type ConfigPathValue<TPath extends ConfigPath> = ConfigPathValueFor<ConfigProperties, TPath>
export type ConfigDefaults = Partial<{ [TPath in ConfigPath]: ConfigPathValue<TPath> }>
