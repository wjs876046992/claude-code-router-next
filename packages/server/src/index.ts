/**
 * Compatibility facade for @wengine-ai/claude-code-router-server.
 *
 * The complete CCR runtime now lives in @wengine-ai/llms. This package keeps
 * the historical import path working without maintaining a second runtime.
 */
export {
  getServer,
  createCcrServer,
  initDir,
  initConfig,
  readConfigFile,
  readConfigFileRaw,
  writeConfigFile,
  backupConfigFile,
  pluginManager,
  tokenSpeedPlugin,
  normalizeUsagePayload,
  mergeUsageCapture,
  collectReachableModelKeys,
  reconcileHealthStore,
  clearProviderHealth,
  usageStore,
} from "@wengine-ai/llms";
export type { RunOptions, IAgent, ITool } from "@wengine-ai/llms";