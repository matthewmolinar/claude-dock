/**
 * A small markdown-to-HTML renderer for the artifact pane's document view,
 * ported from claude-dock `src/shared/markdown.js`. Deliberately tiny and
 * dependency-free: headings, paragraphs, emphasis, code, lists, blockquotes,
 * rules, and links cover what the assistant writes. All input is escaped
 * first, so a document can never smuggle live HTML.
 */

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export interface MarkdownRenderOptions {
  citationCount?: number
  /** Artifact documents use anchors; assistant prose leaves model links inert. */
  links?: 'anchors' | 'inert' | 'external'
  /** Artifact work programs may opt exact implementation links into buttons. */
  workProgramActions?: boolean
}

export const MAX_NESTED_LIST_DEPTH = 32

// Delimits the inline-code placeholder sentinel that inline() mints while it
// protects code spans from emphasis formatting. This must be a character
// escapeHtml never emits and that never appears in ordinary prose — a NUL
// byte (U+0000) fits both. The previous delimiter was a plain space around
// the index (" <n> "), which any bare integer in prose can also match; that
// collision resolved to `codes[n]`, i.e. `undefined`, whenever no code span
// existed at that index. renderMarkdown strips any NUL from the source
// before this runs (see below), so the sentinel is unforgeable by input text.
const NUL = String.fromCharCode(0)
const CODE_PLACEHOLDER = new RegExp(`${NUL}(\\d+)${NUL}`, 'g')

function isSafeOrdinaryAnchorTarget(target: string): boolean {
  if (/%(?![0-9a-f]{2})/i.test(target) || /[\u0000-\u001f\u007f\\]/.test(target)) return false
  let decoded: string
  try {
    decoded = decodeURIComponent(target)
  } catch {
    return false
  }
  if (/[\u0000-\u001f\u007f\\]/.test(decoded) || decoded.startsWith('//')) return false

  const rawScheme = /^([a-z][a-z0-9+.-]*):/i.exec(target)
  if (rawScheme) {
    if (!/^https?$/i.test(rawScheme[1])) return false
    try {
      const parsed = new URL(target)
      return parsed.protocol === 'http:' || parsed.protocol === 'https:'
    } catch {
      return false
    }
  }
  // A scheme that appears only after decoding is never an intentional
  // document-relative target (and includes encoded control/scheme variants).
  if (/^[a-z][a-z0-9+.-]*:/i.test(decoded)) return false
  try {
    new URL(target, 'https://artifact.invalid/document/')
    return true
  } catch {
    return false
  }
}

function isSafeExternalUrl(target: string): boolean {
  try {
    const parsed = new URL(target)
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && Boolean(parsed.hostname)
  } catch {
    return false
  }
}

/** Bold, italic, inline code, links — applied inside a single line. */
function inline(s: string, options: MarkdownRenderOptions): string {
  // Protect inline code spans from emphasis formatting.
  const codes: string[] = []
  s = s.replace(/`([^`]+)`/g, (_, c: string) => {
    codes.push(`<code>${c}</code>`)
    return `${NUL}${codes.length - 1}${NUL}`
  })
  s = s
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, 'Image: $1 ($2)')
    .replace(/!\[([^\]]*)\]\[([^\]]*)\]/g, 'Image: $1 [$2]')
    .replace(
      /\[([^\]]+)\]\(([^)\s]+)\)/g,
      (_, label: string, target: string) => {
        const workProgramItem = /^workbench:implement\?item=(WP-\d{3})$/.exec(target)
        if (workProgramItem) {
          return options.workProgramActions && options.links !== 'inert'
            ? `<button type="button" data-work-program-item="${workProgramItem[1]}">${label}</button>`
            : label
        }
        if (options.links === 'external') {
          return isSafeExternalUrl(target)
            ? `<button type="button" class="markdown-external-link" data-external-url="${target}">${label}</button>`
            : `<span class="markdown-link">${label}</span>`
        }
        if (!isSafeOrdinaryAnchorTarget(target)) return label
        return options.links === 'inert'
          ? `<span class="markdown-link">${label}</span>`
          : `<a href="${target}">${label}</a>`
      },
    )
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    // Underscore emphasis only at word boundaries, so it never fires inside
    // an identifier like snake_case_name: the lookbehind/lookahead require a
    // non-word (or string-edge) character on both outer sides of the pair.
    .replace(/(?<![A-Za-z0-9_])_(\S(?:[^_]*\S)?)_(?![A-Za-z0-9_])/g, '<em>$1</em>')
    .replace(/\[S(\d+)]/g, (match, rawNumber: string) => {
      const sourceNumber = Number(rawNumber)
      if (sourceNumber < 1 || options.links !== 'inert') return match
      return sourceNumber <= (options.citationCount ?? 0)
        ? `<sup><button type="button" class="citation" data-source-index="${sourceNumber - 1}" aria-label="Open source ${sourceNumber}">${sourceNumber}</button></sup>`
        : `<sup>${sourceNumber}</sup>`
    })
  return s.replace(CODE_PLACEHOLDER, (_, i: string) => codes[Number(i)])
}

export function renderMarkdown(source: string, options: MarkdownRenderOptions = {}): string {
  // Strip any NUL up front so inline()'s placeholder sentinel can never be
  // forged by the source text itself (see CODE_PLACEHOLDER above).
  const sanitized = source.replace(/\r\n/g, '\n').split(NUL).join('')
  const lines = escapeHtml(sanitized).split('\n')
  const out: string[] = []
  let i = 0

  const isUl = (l: string): boolean => /^\s*[-*]\s+/.test(l)
  const isOl = (l: string): boolean => /^\s*\d+\.\s+/.test(l)
  const indentOf = (l: string): number => /^\s*/.exec(l)?.[0].length ?? 0

  // A GFM pipe table's header separator row: cells of only `-`, optionally
  // flanked by `:` for alignment (which we parse but intentionally discard —
  // this renderer never emits align attributes). Requires at least one pipe
  // so a bare `---` line is left alone (it's an <hr />, handled elsewhere).
  const isTableSeparator = (l: string): boolean =>
    /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(l) && l.includes('-') && l.includes('|')

  const splitRow = (l: string): string[] => {
    let row = l.trim()
    if (row.startsWith('|')) row = row.slice(1)
    if (row.endsWith('|')) row = row.slice(0, -1)
    return row.split('|').map((cell) => cell.trim())
  }

  // A table "opens" at index idx when that line has a pipe and the very next
  // line is a separator row. Shared by the top-level dispatch and the
  // paragraph loop's block-opener guard so the two never disagree about what
  // counts as a table start.
  const isTableOpener = (idx: number): boolean =>
    idx + 1 < lines.length && lines[idx].includes('|') && isTableSeparator(lines[idx + 1])

  // Buffer-until-predicate-fails, same shape as the list branch below:
  // consumes a header row, its separator, and every following row that still
  // looks tabular (non-blank, pipe-bearing). Ragged rows (fewer/more cells
  // than the header) render with whatever cells they have rather than
  // throwing or padding.
  function parseTable(startIndex: number): { html: string; next: number } {
    let idx = startIndex
    const headerCells = splitRow(lines[idx])
    idx += 2 // header row + separator row
    const bodyRows: string[][] = []
    while (idx < lines.length && lines[idx].trim() && lines[idx].includes('|')) {
      bodyRows.push(splitRow(lines[idx]))
      idx++
    }
    const theadRow = headerCells.map((cell) => `<th>${inline(cell, options)}</th>`).join('')
    const tbodyRows = bodyRows
      .map((row) => `<tr>${row.map((cell) => `<td>${inline(cell, options)}</td>`).join('')}</tr>`)
      .join('\n')
    const html = `<table>\n<thead>\n<tr>${theadRow}</tr>\n</thead>\n<tbody>\n${tbodyRows}\n</tbody>\n</table>`
    return { html, next: idx }
  }

  // Buffer-until-predicate-fails, but recursive by indent depth: a list item
  // may open a nested list (ul or ol, independent of the parent's kind) at
  // greater indent, which is parsed and folded into that <li> before the
  // parent list continues at its own indent.
  function parseList(startIndex: number, indent: number, depth = 0): { html: string; next: number } {
    let idx = startIndex
    const ordered = isOl(lines[idx])
    const match = ordered ? isOl : isUl
    const strip = ordered ? /^\s*\d+\.\s+/ : /^\s*[-*]\s+/
    const items: string[] = []
    while (idx < lines.length && lines[idx].trim() && indentOf(lines[idx]) === indent && match(lines[idx])) {
      const content = inline(lines[idx].replace(strip, '').trim(), options)
      idx++
      if (idx < lines.length && lines[idx].trim() && (isUl(lines[idx]) || isOl(lines[idx])) && indentOf(lines[idx]) > indent) {
        if (depth < MAX_NESTED_LIST_DEPTH) {
          const nested = parseList(idx, indentOf(lines[idx]), depth + 1)
          items.push(`<li>${content}${nested.html}</li>`)
          idx = nested.next
        } else {
          const deeper: string[] = []
          while (idx < lines.length && lines[idx].trim() && (isUl(lines[idx]) || isOl(lines[idx])) && indentOf(lines[idx]) > indent) {
            deeper.push(inline(lines[idx].replace(/^\s*(?:[-*]|\d+\.)\s+/, '').trim(), options))
            idx++
          }
          items.push(`<li>${content}${deeper.length ? `<ul>\n${deeper.map((item) => `<li>${item}</li>`).join('\n')}\n</ul>` : ''}</li>`)
        }
      } else {
        items.push(`<li>${content}</li>`)
      }
    }
    const tag = ordered ? 'ol' : 'ul'
    return { html: `<${tag}>\n${items.join('\n')}\n</${tag}>`, next: idx }
  }

  while (i < lines.length) {
    const line = lines[i]

    if (!line.trim()) {
      i++
      continue
    }

    // Fenced code block: verbatim until the closing fence.
    if (/^```/.test(line)) {
      const buf: string[] = []
      i++
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++])
      i++ // closing fence
      out.push(`<pre><code>${buf.join('\n')}\n</code></pre>`)
      continue
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      const level = heading[1].length
      out.push(`<h${level}>${inline(heading[2].trim(), options)}</h${level}>`)
      i++
      continue
    }

    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      out.push('<hr />')
      i++
      continue
    }

    if (/^\s*&gt;\s?/.test(line)) {
      const buf: string[] = []
      while (i < lines.length && /^\s*&gt;\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*&gt;\s?/, ''))
        i++
      }
      out.push(`<blockquote><p>${inline(buf.join(' ').trim(), options)}</p></blockquote>`)
      continue
    }

    if (isTableOpener(i)) {
      const { html, next } = parseTable(i)
      out.push(html)
      i = next
      continue
    }

    if (isUl(line) || isOl(line)) {
      const { html, next } = parseList(i, indentOf(line))
      out.push(html)
      i = next
      continue
    }

    // Paragraph: consume until a blank line or a block opener.
    const buf: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,6}\s|```|\s*&gt;)/.test(lines[i]) &&
      !isUl(lines[i]) &&
      !isOl(lines[i]) &&
      !/^\s*(---+|\*\*\*+)\s*$/.test(lines[i]) &&
      !isTableOpener(i)
    ) {
      buf.push(lines[i].trim())
      i++
    }
    out.push(`<p>${inline(buf.join(' '), options)}</p>`)
  }

  return out.join('\n')
}
