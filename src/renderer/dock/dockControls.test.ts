import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'

const css = readFileSync(resolve(import.meta.dirname, 'dock.css'), 'utf8')

test('occupied slots keep their close controls visible', () => {
  assert.match(css, /\.slot:not\(\[data-status="empty"\]\) \.slot-controls\s*{[^}]*opacity:\s*1;/s)
})

test('empty slots do not show close controls', () => {
  assert.match(css, /\.slot\[data-status="empty"\] \.slot-controls\s*{[^}]*display:\s*none;/s)
})
