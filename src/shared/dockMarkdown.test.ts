import assert from 'node:assert/strict'
import { test } from 'node:test'

import { MAX_NESTED_LIST_DEPTH, renderMarkdown } from './dockMarkdown'

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

test('renders images as inert text and external links as explicit controls', () => {
  const images = renderMarkdown('![diagram](https://example.com/a.png) ![map][asset]', { links: 'external' })
  assert.doesNotMatch(images, /<img\b|\bsrc=/i)
  assert.match(images, /Image: diagram/)
  assert.match(images, /Image: map/)
  assert.equal(
    renderMarkdown('[site](https://example.com/path?one=1&two=2)', { links: 'external' }),
    '<p><button type="button" class="markdown-external-link" data-external-url="https://example.com/path?one=1&amp;two=2">site</button></p>',
  )
})

test('renders an exact work-program action only when explicitly enabled', () => {
  const source = '[Implement **this** item](workbench:implement?item=WP-001)'
  assert.equal(
    renderMarkdown(source, { workProgramActions: true }),
    '<p><button type="button" data-work-program-item="WP-001">Implement <strong>this</strong> item</button></p>',
  )
})

test('leaves work-program actions inert in default and transcript rendering', () => {
  const source = '[Implement this item](workbench:implement?item=WP-001)'
  for (const html of [renderMarkdown(source), renderMarkdown(source, { links: 'inert' })]) {
    assert.equal(html, '<p>Implement this item</p>')
    assert.doesNotMatch(html, /(?:href|data-work-program-item)=/)
  }
})

test('leaves malformed and unsupported workbench targets inert', () => {
  const targets = [
    'workbench:implement?item=WP-01',
    'workbench:implement?item=WP-0001',
    'workbench:implement?item=wp-001',
    'workbench:implement?item=WP-00x',
    'workbench:implement?item=WP-001#fragment',
    'workbench:implement?item=WP-001&extra=true',
    'workbench:implement?item=WP%2D001',
    'xworkbench:implement?item=WP-001',
    'workbench:implement?item=WP-001x',
    'workbench:delete?item=WP-001',
  ]
  for (const target of targets) {
    const html = renderMarkdown(`[Do it](${target})`, { workProgramActions: true })
    assert.equal(html, '<p>Do it</p>', target)
    assert.doesNotMatch(html, /(?:href|data-work-program-item)=/, target)
  }
})

test('work-program action labels and surrounding model input stay escaped', () => {
  const html = renderMarkdown(
    '<script>[Do "it" <img onerror="alert(1)">](workbench:implement?item=WP-123)</script>',
    { workProgramActions: true },
  )
  assert.match(html, /&lt;script&gt;/)
  assert.match(html, /<button type="button" data-work-program-item="WP-123">/)
  assert.match(html, /Do &quot;it&quot; &lt;img onerror=&quot;alert\(1\)&quot;&gt;/)
  assert.doesNotMatch(html, /<script>|<img|onerror="/)
})

test('ordinary links keep their configured behavior beside work-program actions', () => {
  const source = '[site](https://example.com) [Do it](workbench:implement?item=WP-001)'
  const artifact = renderMarkdown(source, { workProgramActions: true })
  assert.match(artifact, /<a href="https:\/\/example\.com">site<\/a>/)
  assert.match(artifact, /data-work-program-item="WP-001"/)

  const transcript = renderMarkdown(source, { links: 'inert', workProgramActions: true })
  assert.match(transcript, /<span class="markdown-link">site<\/span>/)
  assert.doesNotMatch(transcript, /data-work-program-item=/)
  assert.doesNotMatch(transcript, /href=/)
})

test('ordinary HTTPS targets containing workbench text remain anchors', () => {
  const targets = [
    'https://example.com/?next=workbench:help',
    'HTTPS://example.com/workbench%3Aimplement?item=WP-001',
    '../docs/workbench',
  ]
  for (const target of targets) {
    assert.equal(
      renderMarkdown(`[site](${target})`, { workProgramActions: true }),
      `<p><a href="${target}">site</a></p>`,
      target,
    )
  }
})

test('ordinary anchors use an explicit safe-target allowlist', () => {
  const safe = [
    'http://example.com/a', 'HTTPS://example.com/a', '#section', '?tab=one',
    '/docs/page', './page.md', '../page.md', 'docs/page.md', 'image%20name.png',
  ]
  const inert = [
    'javascript:alert(1)', 'data:text/html,x', 'vbscript:msgbox(1)', 'file:///tmp/a',
    'artifact://slot-1/', 'mailto:user@example.com', 'unknown:thing', '//evil.test/a',
    '\\\\evil.test\\a', '/\\evil.test/a', '\\evil.test/a',
    '%6aavascript:alert(1)', 'java%73cript:alert(1)', '%2f%2fevil.test/a',
    'java%0ascript:alert(1)', 'java%00script:alert(1)', 'https%3A%2F%2Fevil.test',
    'bad%escape', 'bad%2', 'http://[invalid', 'HTTPS://',
    'WORKBENCH:implement?item=WP-001', 'workbench:implement?item=WP-01',
  ]

  for (const target of safe) {
    assert.equal(renderMarkdown(`[safe](${target})`, { workProgramActions: true }), `<p><a href="${target}">safe</a></p>`, target)
  }
  for (const target of inert) {
    const html = renderMarkdown(`[unsafe](${target})`, { workProgramActions: true })
    assert.doesNotMatch(html, /(?:href|data-work-program-item)=/, target)
  }
})

test('case-varied and encoded workbench scheme lookalikes stay inert', () => {
  const targets = [
    'WORKBENCH:implement?item=WP-001',
    'WorkBench:implement?item=WP-001',
    'workbench%3Aimplement?item=WP-001',
    'WORKBENCH%3aimplement?item=WP-001',
    'workbench%ZZimplement?item=WP-001',
    'work%62ench%ZZimplement?item=WP-001',
    '%77orkbench%ZZimplement?item=WP-001',
  ]
  for (const target of targets) {
    const html = renderMarkdown(`[Do it](${target})`, { workProgramActions: true })
    assert.equal(html, '<p>Do it</p>', target)
    assert.doesNotMatch(html, /(?:href|data-work-program-item)=/, target)
  }
})

test('assistant mode shows citation numbers without exposing internal S tokens', () => {
  const html = renderMarkdown(
    'Supported [S1], missing [S3], **nested [S2]**, and [site](https://example.com).',
    { citationCount: 2, links: 'inert' },
  )
  assert.match(html, /data-source-index="0"/)
  assert.match(html, /data-source-index="1"/)
  assert.match(html, /missing <sup>3<\/sup>/)
  assert.doesNotMatch(html, /\[S\d+]/)
  assert.match(html, /<span class="markdown-link">site<\/span>/)
  assert.doesNotMatch(html, /href=/)
})

test('artifact documents preserve citation-like text without source controls', () => {
  assert.match(renderMarkdown('Literal [S1].'), /Literal \[S1\]\./)
})

test('a bare integer surrounded by spaces survives verbatim', () => {
  const html = renderMarkdown('We shipped 3 changes and 12 tests.')
  assert.equal(html, '<p>We shipped 3 changes and 12 tests.</p>')
  assert.ok(!html.includes('undefined'))
})

test('multiple bare integers in one line all survive', () => {
  const html = renderMarkdown('1 apple, 2 pears, 3 plums, and 44 grapes.')
  assert.equal(html, '<p>1 apple, 2 pears, 3 plums, and 44 grapes.</p>')
  assert.ok(!html.includes('undefined'))
})

test('a real code span and a bare integer both survive on the same line', () => {
  const html = renderMarkdown('Call `foo()` then wait 5 seconds.')
  assert.equal(html, '<p>Call <code>foo()</code> then wait 5 seconds.</p>')
})

test('adjacent code spans restore in the correct order', () => {
  const html = renderMarkdown('First `a` then `b` then `c`.')
  assert.equal(html, '<p>First <code>a</code> then <code>b</code> then <code>c</code>.</p>')
})

test('a code span whose content is itself a bare integer is not confused with a placeholder', () => {
  const html = renderMarkdown('The answer is `7`.')
  assert.equal(html, '<p>The answer is <code>7</code>.</p>')
})

test('a literal NUL in the source cannot forge a placeholder', () => {
  // Mimics the internal sentinel shape (NUL, digit, NUL) that inline() mints
  // around a real code span placeholder. If NUL weren't stripped from the
  // source up front, this forged sequence could resolve to the unrelated
  // code span's content instead of staying a literal digit.
  const NUL = String.fromCharCode(0)
  const forged = `Here is \`real\` and here is a forgery: ${NUL}0${NUL}.`
  const html = renderMarkdown(forged)
  assert.equal(html, '<p>Here is <code>real</code> and here is a forgery: 0.</p>')
  assert.ok(!html.includes(NUL))
})

test('snake_case identifiers keep their underscores intact', () => {
  const html = renderMarkdown('The var is snake_case_name and other_thing here.')
  assert.equal(html, '<p>The var is snake_case_name and other_thing here.</p>')
})

test('underscore emphasis at word boundaries still renders <em>', () => {
  const html = renderMarkdown('This is _emphasis_ here.')
  assert.equal(html, '<p>This is <em>emphasis</em> here.</p>')
})

test('bold and strong asterisk emphasis are unaffected', () => {
  const html = renderMarkdown('Some **strong** and *bold* text.')
  assert.equal(html, '<p>Some <strong>strong</strong> and <em>bold</em> text.</p>')
})

test('a pipe table with a header separator renders thead/tbody', () => {
  const html = renderMarkdown('| A | B |\n| --- | --- |\n| 1 | 2 |')
  assert.match(html, /<table>/)
  assert.match(html, /<thead>\s*<tr>\s*<th>A<\/th>\s*<th>B<\/th>\s*<\/tr>\s*<\/thead>/)
  assert.match(html, /<tbody>\s*<tr>\s*<td>1<\/td>\s*<td>2<\/td>\s*<\/tr>\s*<\/tbody>/)
  assert.match(html, /<\/table>/)
})

test('table cell content passes through inline formatting', () => {
  const html = renderMarkdown('| A | B |\n| --- | --- |\n| **bold** | `code` |')
  assert.match(html, /<td><strong>bold<\/strong><\/td>/)
  assert.match(html, /<td><code>code<\/code><\/td>/)
})

test('table leading and trailing pipes are optional and cells are trimmed', () => {
  const html = renderMarkdown('A | B\n--- | ---\n 1  |  2 ')
  assert.match(html, /<th>A<\/th>\s*<th>B<\/th>/)
  assert.match(html, /<td>1<\/td>\s*<td>2<\/td>/)
})

test('a table row with fewer or more cells than the header does not throw', () => {
  const html = renderMarkdown('| A | B | C |\n| --- | --- | --- |\n| 1 |\n| 1 | 2 | 3 | 4 |')
  assert.doesNotThrow(() => renderMarkdown('| A | B | C |\n| --- | --- | --- |\n| 1 |\n| 1 | 2 | 3 | 4 |'))
  assert.match(html, /<table>/)
  assert.match(html, /<td>1<\/td>/)
})

test('a pipe-containing line without a separator row stays a paragraph', () => {
  const html = renderMarkdown('This | that is just prose with a pipe.')
  assert.match(html, /<p>This \| that is just prose with a pipe\.<\/p>/)
  assert.doesNotMatch(html, /<table>/)
})

test('alignment markers parse without throwing and are not required to emit alignment', () => {
  assert.doesNotThrow(() => renderMarkdown('| A | B | C |\n| :--- | ---: | :---: |\n| 1 | 2 | 3 |'))
  const html = renderMarkdown('| A | B | C |\n| :--- | ---: | :---: |\n| 1 | 2 | 3 |')
  assert.match(html, /<table>/)
})

test('a table directly after a paragraph with no blank line is not swallowed', () => {
  const html = renderMarkdown('Some prose here.\n| A | B |\n| --- | --- |\n| 1 | 2 |')
  assert.match(html, /<p>Some prose here\.<\/p>/)
  assert.match(html, /<table>/)
})

test('nested unordered lists nest by indent depth', () => {
  const html = renderMarkdown('- top\n  - nested\n- second')
  assert.match(
    html,
    /<ul>\s*<li>top<ul>\s*<li>nested<\/li>\s*<\/ul>\s*<\/li>\s*<li>second<\/li>\s*<\/ul>/,
  )
})

test('nested ordered lists nest by indent depth', () => {
  const html = renderMarkdown('1. top\n   1. nested\n2. second')
  assert.match(
    html,
    /<ol>\s*<li>top<ol>\s*<li>nested<\/li>\s*<\/ol>\s*<\/li>\s*<li>second<\/li>\s*<\/ol>/,
  )
})

test('a ul nested inside an ol nests correctly', () => {
  const html = renderMarkdown('1. top\n   - nested\n2. second')
  assert.match(
    html,
    /<ol>\s*<li>top<ul>\s*<li>nested<\/li>\s*<\/ul>\s*<\/li>\s*<li>second<\/li>\s*<\/ol>/,
  )
})

test('deeply nested lists are consumed without unbounded recursion', () => {
  assert.ok(MAX_NESTED_LIST_DEPTH > 0)
  const input = Array.from({ length: 2_000 }, (_, depth) => `${' '.repeat(depth)}- level ${depth}`).join('\n')
  const html = renderMarkdown(`${input}\n\nafter deep list`)
  assert.match(html, /level 0/)
  assert.match(html, /after deep list/)
})
