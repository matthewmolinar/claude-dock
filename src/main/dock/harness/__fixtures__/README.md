# Test fixtures for the dock harness

Binary fixtures are **committed**, never generated at test time: generating one
needs a tool that may not exist on the machine running the suite (Linux CI has
no `cupsfilter`), and a fixture that varies by host makes a failure impossible
to reproduce.

## `real-sample.pdf`

A real, single-page, `/FlateDecode`-compressed PDF — 13,392 bytes, PDF 1.3.

**Provenance.** Generated on macOS with `/usr/sbin/cupsfilter` from a two-line
plain-text file whose visible content was:

```
Q3 revenue was 4.2M.
Owner: Dana. Due: Sept 30.
```

**Why it exists.** It pins the measured defect that `read_file`'s UTF-8
refusal exists to fix (TAN-5474). Before that change, `read_file` on this exact
file returned a *successful* tool result carrying 12,778 characters of mojibake
— 37.7% U+FFFD replacement characters — and **none** of the four strings above
were recoverable from it, because the text lives in a Flate-compressed content
stream. A synthetic byte sequence cannot stand in for this: the point is that a
genuine document a person would actually bind decodes to garbage, not that
invalid bytes are invalid.

**Known gap it does not cover.** A PDF whose structure is ASCII and whose
streams are *uncompressed* decodes cleanly, contains no NUL byte, and so still
reads as text. That is deliberate — such a file's text genuinely is its text,
and extracting real content from a PDF is the bind-time extraction pipeline's
job, not `read_file`'s. Do not close that gap by adding an extension allowlist
to `read_file`: the model must stay able to read any text file in the folder.

**Contains nothing sensitive.** The text above is the whole of it.
