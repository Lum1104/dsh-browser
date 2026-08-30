/**
 * The subset of the Host `llm` (`LlmRuntime`) business API the browser
 * bridge calls for the extension's model-discovery flow. `@deepseek-ai/dsh-llm`
 * is a genuinely published, resolvable package (unlike the controller
 * packages in `harness-types.ts`), so its real types are used directly.
 * @module @yuxianglin/dsh-bridge-browser/src/llm-api
 */

import type { Context } from '@deepseek-ai/cordis'
import type { LlmDiscoveredModel, LlmModelDiscoveryRequest } from '@deepseek-ai/dsh-llm'

/** The `llm` surface the bridge needs. */
export interface BridgeLlmApi {
  discoverModels(settingsNs: string, request: LlmModelDiscoveryRequest): Promise<LlmDiscoveredModel[]>
}

/** Bind the injected `llm` service into a {@link BridgeLlmApi}. */
export function createLlmApi(ctx: Context): BridgeLlmApi {
  return {
    discoverModels: (settingsNs, request) => ctx.llm.discoverModels(settingsNs, request),
  }
}
