# Troubleshooting — Terminal Recorder

Known issues, root causes, and fixes. Organized by symptom.

## Windows

### Symptom: `vhs record` crashes or hangs

**Root cause**: Native Windows pty handling has bugs; `ttyd` doesn't stabilize under Windows console.

**Fix**: Use WSL2.

```bash
# In WSL2 Ubuntu
sudo apt install ttyd ffmpeg
# Install vhs via Go or download release binary
```

Record in WSL2, output to Windows filesystem via `/mnt/c/` or `/mnt/e/`.

### Symptom: Colors missing/wrong in GIF

**Root cause**: Default Windows Terminal/cmd ANSI support incomplete.

**Fix**: 
1. Use Windows Terminal (latest version).
2. Explicitly set theme in tape: `Set Theme "Dracula"`.
3. Force shell: `Set Shell "bash"` (loads color scheme).
4. If still wrong → WSL2.

### Symptom: Chinese/CJK characters render as boxes or mojibake

**Root cause**: Default font lacks CJK glyphs.

**Fix**:
```tape
Set FontFamily "JetBrains Mono"
# Or install a Nerd Font and use:
Set FontFamily "JetBrainsMono Nerd Font"
```
Install Nerd Font on system: https://www.nerdfonts.com/font-downloads

On Windows, also set console font to match.

### Symptom: PowerShell commands don't run / errors

**Root cause**: VHS defaults to bash.

**Fix**:
```tape
Set Shell "powershell"
# Or for cmd:
Set Shell "cmd"
```

## GIF / Output Issues

### Symptom: GIF file too large (>10MB)

**Causes & fixes** (apply in order of impact):

1. **Reduce dimensions**:
   ```tape
   Set Width 800
   Set Height 400
   ```
2. **Lower framerate**:
   ```tape
   Set Framerate 30   # default 50
   ```
3. **Trim Sleep durations** — review all `Sleep` lines, cut unnecessary waits.
4. **Switch to WebM** (much smaller, better quality):
   ```tape
   Output demo.webm
   ```
5. **Use asciinema + agg** instead of VHS — agg has better compression:
   ```bash
   agg demo.cast demo.gif --speed 1.5 --renderer font
   ```

### Symptom: GIF looks choppy / motion not smooth

**Fix**: Increase framerate:
```tape
Set Framerate 60   # or 30 minimum
```

### Symptom: GIF flickers (TUI full-screen apps)

**Root cause**: Full-screen redraws capture differently across frames.

**Fixes**:
1. Lower framerate to 30 (reduces redraw frequency).
2. Use WebM instead of GIF.
3. For Bubble Tea apps, ensure `WithAltScreen()` is set consistently.
4. Switch to asciinema recording → `agg` conversion (more reliable for full-screen).

### Symptom: White/black flashes between frames

**Root cause**: Terminal clear screen captured as flash.

**Fix**: Avoid `clear` in tape; use `Ctrl+L` which VHS handles more gracefully.

## Recording Issues

### Symptom: `vhs demo.tape` produces empty/black GIF

**Checklist**:
1. All `Output` paths writable?
2. TUI command in tape actually exists in PATH? Add `Require my-tui` to verify.
3. TUI needs TTY? VHS provides a pseudo-TTY, should work.
4. Try `vhs -t demo.tape` (dry-run) to see parsed directives.
5. Check `ffmpeg` and `ttyd` installed and in PATH.

### Symptom: `Type "command"` shows garbled text

**Root cause**: Non-ASCII in command, font doesn't support.

**Fix**: `Set FontFamily` to a font with full coverage. Avoid emoji in commands.

### Symptom: `Wait+` never returns

**Root cause**: Long-running process keeps producing output.

**Fix**: Use bounded wait:
```tape
Wait@5s   # max 5 seconds
```

### Symptom: Commands run too fast, output cut off

**Fix**: Add `Wait+` after each command that produces output:
```tape
Type "ls -la"
Enter
Wait+   # ← wait for output to complete
```

## asciinema Issues

### Symptom: `asciinema rec` shows "Could not open TTY"

**Fix**: Run in a real terminal, not piped/redirected. On Windows use WSL2.

### Symptom: asciinema-player shows wrong colors

**Fix**: Ensure theme in player matches recording. Use:
```html
<asciinema-player src="demo.cast" cols="100" rows="30" theme="dracula"></asciinema-player>
```

## svg-term Issues

### Symptom: `npx svg-term` command not found

**Fix**: Use `npx svg-term-cli` (older versions) or install globally:
```bash
npm install -g svg-term
```

### Symptom: SVG has no animation

**Fix**: Add `--no-cursor` flag, ensure cast file valid:
```bash
npx svg-term --cast demo.cast --out demo.svg --window --no-cursor
```

## agg Issues

### Symptom: `agg: command not found`

**Install**:
- macOS: `brew install asciinema/tap/agg`
- Linux: `cargo install agg` (requires Rust toolchain)
- Windows: WSL2 + cargo build

### Symptom: agg output quality poor

**Fix**: Use font renderer explicitly:
```bash
agg demo.cast demo.gif --renderer font --speed 1.0
```

## Dependency Issues

### `ttyd` missing

```bash
# macOS
brew install ttyd
# Linux (Ubuntu)
sudo apt install ttyd
# Or build from source: https://github.com/tsl0922/ttyd
```

### `ffmpeg` missing

```bash
# macOS
brew install ffmpeg
# Linux
sudo apt install ffmpeg
# Windows
choco install ffmpeg   # or scoop install ffmpeg
```

## Diagnostic Checklist

When things break, run in order:

```bash
# 1. Verify all dependencies
vhs --version
ttyd --version
ffmpeg -version

# 2. Dry-run tape
vhs -t demo.tape

# 3. Test with minimal tape
cat > test.tape <<'EOF'
Output test.gif
Set FontSize 14
Set Width 400
Set Height 200
Type "echo hello"
Enter
Sleep 1s
EOF
vhs test.tape

# 4. If test.gif works but real tape doesn't → issue in tape content
# 5. If test.gif also fails → environment issue, try WSL2
```
