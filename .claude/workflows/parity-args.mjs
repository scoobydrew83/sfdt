#!/usr/bin/env node
// Emits the `args` payload for the sfdt-surface-parity workflow.
//   node .claude/workflows/parity-args.mjs            # print args JSON
//   node .claude/workflows/parity-args.mjs --selftest # run the check
// Then: Workflow({name: 'sfdt-surface-parity', args: <that JSON>})
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'

// golden principle #8 — resolve from this file, never CWD
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

// ponytail: surfaces hardcoded; they change about as often as the repo topology does.
// If a sixth surface lands, add it here and to SURFACE_DIR in sfdt-surface-parity.js.
const SURFACES = ['gui', 'chrome', 'vscode']

// A gap is a command the CLI has that a given surface does not. Commands absent
// from the CLI itself aren't parity gaps — they're not features yet. A surface with no
// gaps is dropped: an agent handed an empty list can still invent verdicts.
export const buildArgs = (commands, surfaces = SURFACES) =>
  surfaces
    .map(surface => ({
      surface,
      gaps: commands
        .filter(c => c.surfaces?.cli && !c.surfaces?.[surface])
        .map(c => ({ id: c.id, mcpTools: c.mcpTools ?? [] })),
    }))
    .filter(s => s.gaps.length)

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain && process.argv.includes('--selftest')) {
  const { strict: assert } = await import('node:assert')
  const fake = [
    { id: 'deploy', surfaces: { cli: true, gui: true, chrome: false }, mcpTools: ['sfdt_deploy'] },
    { id: 'soql', surfaces: { cli: true, gui: false, chrome: false } },
    { id: 'browser-only', surfaces: { cli: false, gui: false, chrome: true } },
  ]
  const [gui, chrome] = buildArgs(fake, ['gui', 'chrome'])
  assert.deepEqual(gui.gaps.map(g => g.id), ['soql'], 'gui gap set')
  assert.deepEqual(chrome.gaps.map(g => g.id), ['deploy', 'soql'], 'chrome gap set')
  assert.deepEqual(chrome.gaps[0].mcpTools, ['sfdt_deploy'], 'mcpTools carried through')
  assert.deepEqual(gui.gaps[0].mcpTools, [], 'missing mcpTools defaults to []')
  assert.deepEqual(buildArgs(fake, ['gui', 'vscode', 'chrome']).map(s => s.surface), ['gui', 'vscode', 'chrome'], 'surfaces with gaps kept')
  assert.deepEqual(buildArgs([fake[0]], ['gui', 'chrome']).map(s => s.surface), ['chrome'], 'gap-free surface dropped')
  console.log('ok — selftest passed')
} else if (isMain) {
  const { commands } = JSON.parse(readFileSync(resolve(REPO, 'generated/surface-parity.json'), 'utf8'))
  console.log(JSON.stringify(buildArgs(commands)))
}
