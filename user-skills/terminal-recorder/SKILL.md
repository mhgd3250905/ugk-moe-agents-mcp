---
name: terminal-recorder
description: Record terminal/TUI sessions and produce web-embeddable animated demos (GIF/SVG/WebM) using VHS and asciinema. Use when the user wants to record terminal/TUI/CLI running process, create product demo GIFs for README/website/docs, script-ize terminal recordings, or embed animated terminal sessions into web pages. Covers VHS tape scripting, asciinema cast recording, svg-term/agg conversion, Windows/WSL2 setup, and CI integration.
agent_created: true
---

# Terminal Recorder Skill

Record terminal/TUI sessions and produce web-embeddable animated demos. Primary tool is VHS (script-driven GIF/SVG/WebM generation); secondary tools are asciinema (cast recording) + svg-term/agg (format conversion).

## When to Use

Trigger when the user expresses any of:

- "录个 TUI 演示" / "把终端运行录下来做成动图"
- "给 README/官网加个动态演示"
- "TUI 产品的 demo gif"
- "asciinema 录制终端"
- "终端转 SVG/GIF"
- Recording any CLI/TUI/REPL session for web embedding

## Core Decision Flow

```
Need to record terminal session?
├── Script-driven, reproducible, GIF/SVG output  → VHS (primary)
├── Real-time recording, editable source         → asciinema (.cast)
└── Both: record cast → convert to tape/SVG/GIF  → asciinema + VHS/agg/svg-term
```

**Default recommendation**: VHS for product demos (reproducible, CI-friendly). asciinema for interactive documentation sites (asciinema-player).

## Prerequisites & Installation

### VHS (primary)

```bash
# macOS
brew install vhs

# Windows (Scoop, auto-installs ttyd + ffmpeg)
scoop install vhs

# Windows (Chocolatey)
choco install vhs

# Cross-platform via Go
go install github.com/charmbracelet/vhs@latest

# Docker
docker run --rm -v "$PWD:/vhs" ghcr.io/charmbracelet/vhs
```

Verify:
```bash
vhs --version && ttyd --version && ffmpeg -version
```

### asciinema (secondary)

```bash
# macOS/Linux
brew install asciinema    # or: pip install asciinema

# Windows: prefer WSL2
sudo apt install asciinema
```

### svg-term (cast → SVG)

```bash
npx svg-term --version
```

### agg (cast → GIF, higher quality than built-in)

```bash
# macOS
brew install asciinema/tap/agg
# Linux: build from source (cargo install agg)
```

## Windows-Specific Guidance

**Critical**: VHS native Windows has stability issues with `vhs record` and full-screen TUI apps. Recommendation matrix:

| Scenario | Recommended Environment |
|----------|-------------------------|
| Script-driven `vhs demo.tape` | Windows native (Scoop) |
| `vhs record` interactive capture | WSL2 |
| Full-screen TUI recording | WSL2 |
| Chinese/CJK text | WSL2 + Nerd Font |
| CI auto-generation | Linux container |

WSL2 output to Windows filesystem:
```tape
Output "/mnt/e/path/to/output.gif"
```

For full Windows pitfalls and fixes, load `references/troubleshooting.md` and grep for `## Windows`.

## Core Workflow: VHS Script-Driven Recording

### Step 1: Create `.tape` file

Use the templates in `assets/` as starting points:

- `assets/minimal.template.tape` — smallest valid tape, for quick tests
- `assets/demo.template.tape` — full TUI demo skeleton with theme/window/interaction flow

Copy a template and customize for the specific TUI product.

### Step 2: Execute

```bash
vhs demo.tape
# Generates demo.gif (or .webm/.mp4 based on Output directive)
```

### Step 3: Iterate

Edit `.tape` (adjust Sleep timing, add/remove actions, change theme), re-run `vhs demo.tape`. No need to re-record — that's VHS's core advantage over screen capture.

## Core Workflow: asciinema Real-Time Recording

```bash
asciinema rec demo.cast       # Record; Ctrl+D or exit to stop
asciinema play demo.cast      # Preview locally
```

Embed in web page:
```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/asciinema-player/dist/bundle/asciinema-player.css">
<script src="https://cdn.jsdelivr.net/npm/asciinema-player/dist/bundle/asciinema-player.min.js"></script>
<asciinema-player src="demo.cast" cols="100" rows="30" autoplay loop preload></asciinema-player>
```

## Format Conversion

From `.cast` (asciinema source):

```bash
# To SVG (lightweight, vector, for README/blog)
npx svg-term --cast demo.cast --out demo.svg --window

# To GIF (lossy, universal)
agg demo.cast demo.gif --speed 1.5

# To WebM (smaller, better quality than GIF)
agg demo.cast demo.webm --codec vp9
```

## Tape Syntax Quick Reference

Load `references/tape-syntax.md` for the complete command list. Key directives:

```tape
# Output
Output demo.gif            # .gif | .webm | .mp4

# Window
Set FontSize 16
Set Width 1200
Set Height 600
Set Padding 20
Set Theme "Dracula"        # Dracula | Catppuccin Mocha | Gotham | ...
Set Framerate 60

# Input
Type "command"             # Simulated typing with animation
Type@100ms "faster"        # Custom per-char speed
Key "j"                    # Single keypress, no animation
Enter / Space / Tab / Backspace / Ctrl+C
KeyUp / KeyDown / KeyLeft / KeyRight

# Flow
Sleep 2s                   # Wait fixed duration
Wait+                      # Wait for terminal idle (async commands)
Hide / Show                # Toggle input visibility
Screenshot frame.png       # Capture a frame
```

## Common Use Cases

### 1. TUI Product README Demo

```tape
Output demo.gif
Set FontSize 14
Set Width 1000
Set Height 560
Set Theme "Catppuccin Mocha"
Set Framerate 60

Type@30ms "./my-tui"
Enter
Sleep 1s

# Demo navigation
Key@1s Down
Key@1s Down
Key@1s Enter
Sleep 2s

Key@500ms Tab
Sleep 1s

Type "q"
Sleep 800ms
```

### 2. CI Auto-Generation (GitHub Action)

```yaml
- uses: charmbracelet/vhs-action@v2
  with:
    path: demo.tape
```

Commit `.tape` to repo; GIF regenerates on every push.

### 3. Multi-Format Output (record once, derive many)

```bash
# Source: record real session
asciinema rec demo.cast

# Derive three formats
asciinema play demo.cast                              # local preview
npx svg-term --cast demo.cast --out demo.svg --window # README/blog
agg demo.cast demo.gif                                # universal GIF
```

## Troubleshooting

For known issues (Windows crashes, color loss, font/emoji rendering, GIF size, flicker), load `references/troubleshooting.md` and grep for the symptom.

## References

- `references/tape-syntax.md` — Complete VHS Tape directive reference
- `references/troubleshooting.md` — Known issues, Windows pitfalls, fixes
- `references/ecosystem.md` — asciinema/svg-term/agg/terminalizer comparison and when to pick which
- `assets/minimal.template.tape` — Smallest valid tape for quick tests
- `assets/demo.template.tape` — Full TUI demo skeleton
