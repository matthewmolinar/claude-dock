import assert from 'node:assert/strict'
import { test } from 'node:test'

import { renderMarkdown } from './dockMarkdown'

test('renders headings, paragraphs, and emphasis', () => {
  const html = renderMarkdown('# Title\n\nSome **bold** and *italic* text.')
  assert.match(html, /<h1>Title<\/h1>/)
  assert.match(html, /<p>Some <strong>bold<\/strong> and <em>italic<\/em> text\.<\/p>/)
})

test('renders lists', () => {
  const html = renderMarkdown('- one\n- two\n\n1. first\n2. second')
  assert.match(html, /<ul>\s*<li>one<\/li>\s*<li>two<\/li>\s*<\/ul>/)
  assert.match(html, /<ol>\s*<li>first<\/li>\s*<li>second<\/li>\s*<\/ol>/)
})

test('renders code blocks and inline code without formatting their contents', () => {
  const html = renderMarkdown('```\nconst a = "**not bold**";\n```\n\nUse `x*y*z` here.')
  assert.match(html, /<pre><code>const a = &quot;\*\*not bold\*\*&quot;;\n<\/code><\/pre>/)
  assert.match(html, /<code>x\*y\*z<\/code>/)
})

test('escapes embedded HTML so documents stay inert', () => {
  const html = renderMarkdown('Hello <script>alert(1)</script> & <b>tags</b>')
  assert.ok(!html.includes('<script>'))
  assert.match(html, /&lt;script&gt;/)
  assert.match(html, /&amp;/)
})

test('renders blockquotes, rules, and links', () => {
  const html = renderMarkdown('> wise words\n\n---\n\n[site](https://example.com)')
  assert.match(html, /<blockquote><p>wise words<\/p><\/blockquote>/)
  assert.match(html, /<hr\s*\/?>/)
  assert.match(html, /<a href="https:\/\/example\.com">site<\/a>/)
})
