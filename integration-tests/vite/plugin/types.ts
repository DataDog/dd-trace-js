import { defineConfig, type Plugin, type UserConfig } from 'vite'

import { datadogVite } from 'dd-trace/vite'

const plugin: Plugin = datadogVite()
const config: UserConfig = defineConfig({ plugins: [datadogVite({})] })

void plugin
void config

// @ts-expect-error datadogVite takes no options.
datadogVite({ service: 'vite-plugin-app' })
