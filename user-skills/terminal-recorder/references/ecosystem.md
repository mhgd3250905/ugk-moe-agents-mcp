# Terminal Recording Ecosystem — Tool Comparison

## Tool Comparison Matrix

| Tool | Input | Output | Scriptable | Interactive Record | Vector | Web Embed | Best For |
|------|-------|--------|------------|-------------------|--------|-----------|----------|
| **VHS** | `.tape` | GIF/WebM/MP4 | ✅ (Tape DSL) | ✅ (`vhs record`) | ❌ | `<img>`/`<video>` | Reproducible demos, CI |
| **asciinema** | Real session | `.cast` (JSONL) | ❌ | ✅ (primary) | ✅ (player) | `<asciinema-player>` | Documentation sites |
| **svg-term** | `.cast` | SVG | ✅ (CLI) | ❌ | ✅ | `<img>`/inline | README, blogs |
| **agg** | `.cast` | GIF/WebM | ✅ (CLI) | ❌ | ❌ | `<img>`/`<video>` | High-quality GIF from cast |
| **terminalizer** | Real session | GIF/WebM | ⚠️ (config) | ✅ | ❌ | `<img>` | Legacy alternative |
| **ttype** | Real session | GIF | ❌ | ✅ | ❌ | `<img>` | Simple one-shot GIF |

## Decision Tree

```
What's the goal?
│
├── Reproducible demo for README/CI
│   └── VHS (.tape) → GIF/WebM
│
├── Interactive doc site (playable, pausable, copy text)
│   └── asciinema → .cast → asciinema-player
│
├── Single lightweight SVG for blog/README
│   └── asciinema → .cast → svg-term → SVG
│
├── Highest-quality GIF from real session
│   └── asciinema → .cast → agg → GIF
│
└── Record once, derive multiple formats
    └── asciinema → .cast → {
        asciinema-player (web)
        svg-term (SVG)
        agg (GIF/WebM)
    }
```

## Format Tradeoffs

### GIF
- ✅ Universal support (everywhere)
- ✅ No JS dependency
- ❌ Lossy, large files (often 5-20MB for 10s)
- ❌ 256 colors, dithering on gradients
- ❌ No audio, no interactivity
- **Use when**: README, social, email

### WebM
- ✅ 5-10x smaller than GIF
- ✅ Better quality (true color)
- ✅ Modern browser support
- ❌ Not supported in some markdown renderers (GitHub README shows it raw)
- **Use when**: Website, blog, when size matters

### SVG (svg-term)
- ✅ Vector, infinite resolution
- ✅ Tiny files (often <100KB)
- ✅ Embeddable in markdown
- ❌ No interactivity (autoplay only)
- ❌ Complex TUI output may bloat SVG
- **Use when**: README, blog, lightweight embed

### asciinema-player (.cast)
- ✅ Vector rendering, perfect quality
- ✅ Interactive: pause, seek, speed control
- ✅ Copy terminal text
- ✅ Tiny source file (.cast is JSONL text)
- ❌ Requires JS on page
- ❌ Not for static contexts (email, social)
- **Use when**: Product docs site, tutorial pages

## VHS vs asciinema — When to Pick Which

### Pick VHS when:
- Demo must be **reproducible** (CI generates it)
- Want to **adjust timing** without re-recording
- Need **GIF output** for README
- Have **scripted, predictable** interactions
- Building **multiple demos** with shared template

### Pick asciinema when:
- Demo is **exploratory** (browsing, debugging)
- Want **web-embeddable interactive player**
- Need to **edit content** after recording
- Want **vector quality** on website
- Recording **complex/long** sessions (cast files stay small)

### Combine both when:
- Record real session with asciinema → `.cast`
- Hand-translate to `.tape` for polish → VHS renders final GIF
- Or: record with `vhs record` → `.tape` → render GIF + share `.tape` for reproducibility

## Cast File Format (asciinema)

`.cast` is JSONL (newline-delimited JSON):

```json
{"version":2,"width":100,"height":30,"timestamp":1234567890,"env":{"SHELL":"/bin/bash","TERM":"xterm-256color"}}
[0.5,"o","Hello World\r\n"]
[1.2,"o","\u001b[31mRed text\u001b[0m"]
[2.0,"i","q"]
```

- Line 1: header (dimensions, env)
- Subsequent: `[timestamp, event_type, data]`
  - `o` = output (terminal → user)
  - `i` = input (user → terminal)

This text format is why cast files are small and editable.

## Tape File Format (VHS)

Declarative script, one directive per line. See `tape-syntax.md` for full reference.

## Size Comparison (typical 10s TUI demo)

| Format | Typical Size | Quality |
|--------|-------------|---------|
| `.cast` (asciinema source) | 20-80 KB | Perfect (vector) |
| `.svg` (svg-term) | 50-200 KB | Perfect (vector) |
| `.webm` (agg) | 200-500 KB | Excellent |
| `.gif` (VHS, 60fps) | 3-8 MB | Good (lossy) |
| `.gif` (agg, optimized) | 1-3 MB | Good (lossy) |
| `.mp4` (VHS) | 500KB-2MB | Excellent |

## Recommended Stack for TUI Product

For a TUI product needing demos in multiple places:

1. **Source of truth**: `.tape` file in repo (reproducible, reviewable)
2. **README**: VHS → GIF (universal)
3. **Docs site**: VHS → WebM OR asciinema-player (interactive)
4. **Blog/social**: VHS → GIF or svg-term → SVG

Single `.tape` can output all formats with multiple `Output` lines.

## CI Integration Examples

### GitHub Actions — VHS

```yaml
name: Generate Demo
on: [push]
jobs:
  demo:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: charmbracelet/vhs-action@v2
        with:
          path: demos/main.tape
      - uses: stefanzweifel/git-auto-commit-action@v5
        with:
          commit_message: "Update demo GIF"
          file_pattern: "demos/*.gif"
```

### GitHub Actions — asciinema → SVG

```yaml
- name: Convert cast to SVG
  run: npx svg-term --cast demos/demo.cast --out demos/demo.svg --window
```
