/**
 * The subset of the Host `settingsController`/`credentialsController`/
 * `directoryPickerController` business API the loopback-only
 * `PRIVILEGED_METHODS` wire methods call.
 * @module @yuxianglin/dsh-bridge-browser/src/privileged-api
 */

import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-session/types'
import type { CredentialInfo, SettingsDescribeValue, SettingsDocumentOpenValue, SettingsNamespaceView, SettingsPathOpView } from './harness-types.ts'

/** The `settingsController` surface the bridge needs. */
export interface BridgeSettingsApi {
  describe(): SettingsDescribeValue
  update(ns: string, patch: Record<string, JsonValue>, expectedRevision: number | undefined): Promise<SettingsNamespaceView>
  replace(ns: string, section: Record<string, JsonValue>, expectedRevision: number | undefined): Promise<SettingsNamespaceView>
  mutate(ns: string, ops: SettingsPathOpView[], expectedRevision: number | undefined): Promise<SettingsNamespaceView>
  openSettingsDocument(signal: AbortSignal): Promise<SettingsDocumentOpenValue>
}

/** The `credentialsController` surface the bridge needs. */
export interface BridgeCredentialsApi {
  describe(refs: string[]): Promise<Record<string, CredentialInfo>>
  set(ref: string, value: string): Promise<void>
  unset(ref: string): Promise<void>
}

/** The `directoryPickerController` surface the bridge needs. */
export interface BridgeDirectoryPickerApi {
  pick(signal: AbortSignal): Promise<string | null>
}

/** Bind the injected `settingsController` service into a {@link BridgeSettingsApi}. */
export function createSettingsApi(ctx: Context): BridgeSettingsApi {
  return {
    describe: () => ctx.settingsController.describe(),
    update: (ns, patch, expectedRevision) => ctx.settingsController.update(ns, patch, expectedRevision),
    replace: (ns, section, expectedRevision) => ctx.settingsController.replace(ns, section, expectedRevision),
    mutate: (ns, ops, expectedRevision) => ctx.settingsController.mutate(ns, ops, expectedRevision),
    openSettingsDocument: signal => ctx.settingsController.openSettingsDocument(signal),
  }
}

/** Bind the injected `credentialsController` service into a {@link BridgeCredentialsApi}. */
export function createCredentialsApi(ctx: Context): BridgeCredentialsApi {
  return {
    describe: refs => ctx.credentialsController.describe(refs),
    set: (ref, value) => ctx.credentialsController.set(ref, value),
    unset: ref => ctx.credentialsController.unset(ref),
  }
}

/** Bind the injected `directoryPickerController` service into a {@link BridgeDirectoryPickerApi}. */
export function createDirectoryPickerApi(ctx: Context): BridgeDirectoryPickerApi {
  return {
    pick: signal => ctx.directoryPickerController.pick(signal),
  }
}
