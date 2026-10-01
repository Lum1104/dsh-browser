/**
 * Build all three extension targets sequentially into dist/ (or dist-firefox/
 * with --firefox):
 * background (es|iife) → content (iife) → panel (React). The first target
 * cleans the output; the later ones append. Pass --watch for dev rebuilds.
 *
 * Optional: EXT_CONNECT_SRC='…' appends extra connect-src tokens at copy time.
 * Default manifests already allow any ws/http(s) host for LAN bridge URLs.
 */

import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const watch = process.argv.includes('--watch')

// --firefox switches the manifest and background bundle for the Firefox build.
if (process.argv.includes('--firefox')) {
  process.env.EXT_TARGET = 'firefox'
}

const configs = [
  'vite.background.config.ts',
  'vite.content.config.ts',
  'vite.panel.config.ts',
]

if (watch) {
  // 三个 watcher 并行启动（串行时第一个永不停机，后面的永远不会启动）。
  const children = configs.map((config) => spawn('vite', ['build', '--config', config, '--watch'], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  }))
  for (const child of children) {
    child.on('exit', (code) => { if (code !== 0) process.exit(code ?? 1) })
  }
} else {
  for (const config of configs) {
    const result = spawnSync('vite', ['build', '--config', config], {
      cwd: root,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
    if (result.status !== 0) process.exit(result.status ?? 1)
  }
}
