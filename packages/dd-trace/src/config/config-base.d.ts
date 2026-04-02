import type { ConfigProperties } from './config-types'

declare class ConfigBase {}

interface ConfigBase extends ConfigProperties {}

export = ConfigBase
