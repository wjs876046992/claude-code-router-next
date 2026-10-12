/**
 * Plugin registration from config — reads the `plugins`/`Plugins` config array
 * and enables registered plugins on the server instance.
 *
 * Extracted from the legacy server's index.ts.
 */
import { pluginManager, tokenSpeedPlugin, tokenSpeedTempFileHandlerConfig } from "../plugins";

interface PluginConfig {
  name: string;
  enabled?: boolean;
  options?: Record<string, any>;
}

/**
 * Register plugins from configuration
 * @param serverInstance Server instance
 * @param config Application configuration
 */
export async function registerPluginsFromConfig(serverInstance: any, config: any): Promise<void> {
  // Get plugins configuration from config file
  const pluginsConfig: PluginConfig[] = config.plugins || config.Plugins || [];

  for (const pluginConfig of pluginsConfig) {
      const { name, enabled = false, options = {} } = pluginConfig;

      switch (name) {
        case 'token-speed':
          pluginManager.registerPlugin(tokenSpeedPlugin, {
            enabled,
            outputHandlers: [
              {
                type: 'temp-file',
                enabled: true,
                // Shared factory: keeps this registration identical to the
                // default-reporter path in token-speed.ts (drift between the
                // two copies is what caused the writer/reader mismatch behind
                // the 3.23M temp-file incident).
                config: tokenSpeedTempFileHandlerConfig()
              }
            ],
            ...options
          });
          break;

        default:
          console.warn(`Unknown plugin: ${name}`);
          break;
      }
    }
  // Enable all registered plugins
  await pluginManager.enablePlugins(serverInstance);
}