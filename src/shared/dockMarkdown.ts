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

/** Bold, italic, inline code, links — applied inside a single line. */
function inline(s: string): string {
  // Protect inline code spans from emphasis formatting.
  const codes: string[] = []
  s = s.replace(/`([^`]+)`/g, (_, c: string) => {
    codes.push(`<code>${c}</code>`)
    return ` ${codes.length - 1} `
  })
  s = s
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/_([^_]+)_/g, '<em>$1</em>')
  return s.replace(/ (\d+) /g, (_, i: string) => codes[Number(i)])
}

export function renderMarkdown(source: string): string {
  const lines = escapeHtml(source.replace(/\r\n/g, '\n')).split('\n')
  const out: string[] = []
  let i = 0

  const isUl = (l: string): boolean => /^\s*[-*]\s+/.test(l)
  const isOl = (l: string): boolean => /^\s*\d+\.\s+/.test(l)

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
      out.push(`<h${level}>${inline(heading[2].trim())}</h${level}>`)
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
      out.push(`<blockquote><p>${inline(buf.join(' ').trim())}</p></blockquote>`)
      continue
    }

    if (isUl(line) || isOl(line)) {
      const ordered = isOl(line)
      const match = ordered ? isOl : isUl
      const strip = ordered ? /^\s*\d+\.\s+/ : /^\s*[-*]\s+/
      const buf: string[] = []
      while (i < lines.length && match(lines[i])) {
        buf.push(`<li>${inline(lines[i].replace(strip, '').trim())}</li>`)
        i++
      }
      const tag = ordered ? 'ol' : 'ul'
      out.push(`<${tag}>\n${buf.join('\n')}\n</${tag}>`)
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
      !/^\s*(---+|\*\*\*+)\s*$/.test(lines[i])
    ) {
      buf.push(lines[i].trim())
      i++
    }
    out.push(`<p>${inline(buf.join(' '))}</p>`)
  }

  return out.join('\n')
}
