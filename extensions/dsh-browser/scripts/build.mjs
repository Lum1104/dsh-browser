/**
 * Build all three extension bundles sequentially into the target's output
 * directory (dist/, or dist-firefox/ with --firefox, or dist-opera/ with
 * --opera): background (es|iife) → content (iife) → panel (React). The first
 * bundle cleans the output; the later ones append. Pass --watch for dev
 * rebuilds.
 */

import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const watch = process.argv.includes('--watch')

// The target switches the composed manifest, and for Firefox the background
// bundle format as well.
if (process.argv.includes('--firefox')) {
  process.env.EXT_TARGET = 'firefox'
} else if (process.argv.includes('--opera')) {
  process.env.EXT_TARGET = 'opera'
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
