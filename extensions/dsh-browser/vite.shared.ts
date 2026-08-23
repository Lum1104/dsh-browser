import { cpSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vite'
import {
  composeManifest,
  EXTENSION_TARGETS,
  serializeManifest,
  TARGET_OUT_DIR,
  type ExtensionTarget,
} from './manifest.compose.ts'

/**
 * Shared build plumbing for the extension's three targets (background ES
 * service worker, iife content script, React panel). Each target has its own
 * config file; scripts/build.mjs runs them sequentially into one dist/.
 */

/**
 * Build target: `chrome` (default), `firefox`, or `opera` (set EXT_TARGET or
 * pass --firefox / --opera to scripts/build.mjs). Each target gets its own
 * composed manifest and output directory so the builds can coexist.
 */
function resolveTarget(): ExtensionTarget {
  const requested = process.env.EXT_TARGET
  return EXTENSION_TARGETS.find((target) => target === requested) ?? 'chrome'
}

export const browserTarget = resolveTarget()

export const outDir = resolve(import.meta.dirname, TARGET_OUT_DIR[browserTarget])

/** Write the composed manifest, locale catalogs, and icons into the target's outDir. */
export const copyManifest = {
  name: 'copy-manifest',
  closeBundle(): void {
    mkdirSync(outDir, { recursive: true })
    writeFileSync(resolve(outDir, 'manifest.json'), serializeManifest(composeManifest(browserTarget)))
    cpSync(resolve(import.meta.dirname, '_locales'), resolve(outDir, '_locales'), { recursive: true })
    cpSync(resolve(import.meta.dirname, 'assets'), resolve(outDir, 'assets'), { recursive: true })
  },
}

/** Shared plugins for every target: tsconfig paths (plugin protocol source,
 * SDK-like source consumption) plus the manifest copy. */
export const sharedPlugins = [tsconfigPaths({ projects: ['./tsconfig.json'] }), copyManifest]

/** Shared build options for the non-panel targets. */
export function targetBuild(entry: string, format: 'es' | 'iife', entryFileNames: string, emptyOutDir: boolean) {
  return defineConfig({
    define: {
      'import.meta.env.EXT_TARGET': JSON.stringify(browserTarget),
    },
    build: {
      outDir,
      emptyOutDir,
      rollupOptions: {
        input: resolve(import.meta.dirname, entry),
        output: { format, entryFileNames },
      },
    },
    plugins: sharedPlugins,
  })
}
