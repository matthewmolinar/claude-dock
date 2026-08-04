import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import type { Protocol } from 'electron'

import { installArtifactHandler, registerArtifact, unregisterArtifact } from './artifactProtocol'

test('Markdown registrations are per-load capabilities revoked on replace and unregister', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-protocol-'))
  const firstFile = path.join(dir, 'first.md')
  const secondFile = path.join(dir, 'second.markdown')
  fs.writeFileSync(firstFile, '[Implement](workbench:implement?item=WP-001)')
  fs.writeFileSync(secondFile, '# Second')
  let handler!: (request: Request) => Promise<Response> | Response
  installArtifactHandler({
    handle(_scheme: string, callback: (request: Request) => Promise<Response> | Response) { handler = callback },
  } as unknown as Protocol)

  const first = registerArtifact(3, firstFile)
  const second = registerArtifact(3, secondFile)
  assert.match(first, /^artifact:\/\/markdown-slot-3-[0-9a-f]{32}\/$/)
  assert.match(second, /^artifact:\/\/markdown-slot-3-[0-9a-f]{32}\/$/)
  assert.notEqual(new URL(first).host, new URL(second).host)
  assert.equal((await handler(new Request(first))).status, 404)
  const response = await handler(new Request(second))
  assert.equal(response.status, 200)
  const wrapper = await response.text()
  assert.match(wrapper, /Content-Security-Policy/)
  assert.match(wrapper, /default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'/)
  assert.match(wrapper, /data-work-program-item/)
  assert.match(wrapper, /parent\.postMessage\(\{ type: 'work-program:implement', itemId \}, '\*'\)/)

  unregisterArtifact(3)
  assert.equal((await handler(new Request(second))).status, 404)
})

test('HTML registrations retain the stable storage origin and are not host wrapped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-protocol-html-'))
  const html = path.join(dir, 'game.html')
  fs.writeFileSync(html, '<script>localStorage.setItem("score", "1")</script>')
  assert.equal(registerArtifact(4, html), 'artifact://slot-4/')
  assert.equal(registerArtifact(4, html), 'artifact://slot-4/')
  assert.doesNotMatch(fs.readFileSync(html, 'utf8'), /work-program:implement|Content-Security-Policy/)
  unregisterArtifact(4)
})
