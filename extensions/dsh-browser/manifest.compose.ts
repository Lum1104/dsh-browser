/**
 * Per-browser manifests, composed from one base.
 *
 * `manifest.json` is both the Chrome manifest and the base: Chrome is the
 * primary target, and the in-panel update check fetches that exact path from
 * `main` to read the published version, so it stays a real manifest at a
 * stable location. Every other browser is a delta on top of it.
 *
 * Composition rules, in full: a delta entry replaces that top-level key
 * outright, and `null` removes it — which is how Firefox and Opera drop
 * `side_panel`. Nothing merges recursively, deliberately: a nested merge of
 * Firefox's `background` onto Chrome's produced `service_worker`, `type` and
 * `scripts` together, which is not a manifest either browser accepts. A key is
 * either shared verbatim or restated in full.
 *
 * Keeping a browser's own keys out of the others is not tidiness: Chrome warns
 * "Unrecognized manifest key 'sidebar_action'" on every unpacked install, and
 * this project has no Web Store listing, so every user loads unpacked and would
 * see it.
 *
 * @module
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const EXTENSION_TARGETS = ['chrome', 'firefox', 'opera'] as const
export type ExtensionTarget = (typeof EXTENSION_TARGETS)[number]

/** The output directory for each target, so the builds can coexist. */
export const TARGET_OUT_DIR: Record<ExtensionTarget, string> = {
  chrome: 'dist',
  firefox: 'dist-firefox',
  opera: 'dist-opera',
}

const MANIFEST_ROOT = import.meta.dirname

type JsonObject = Record<string, unknown>

function readManifestJson(name: string): JsonObject {
  return JSON.parse(readFileSync(resolve(MANIFEST_ROOT, name), 'utf8')) as JsonObject
}

function applyDelta(base: JsonObject, delta: JsonObject): JsonObject {
  const merged: JsonObject = { ...base }
  for (const [key, value] of Object.entries(delta)) {
    if (value === null) delete merged[key]
    else merged[key] = value
  }
  return merged
}

/** The manifest a target ships, with no other browser's keys in it. */
export function composeManifest(target: ExtensionTarget): JsonObject {
  const base = readManifestJson('manifest.json')
  if (target === 'chrome') return base
  return applyDelta(base, readManifestJson(`manifest.${target}.json`))
}

/** Serialize exactly as the committed manifests are formatted. */
export function serializeManifest(manifest: JsonObject): string {
  return `${JSON.stringify(manifest, null, 2)}\n`
}
