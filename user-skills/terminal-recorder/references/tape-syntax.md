# VHS Tape Syntax — Complete Reference

Tape files (`.tape`) are declarative scripts describing terminal actions. Each line is a directive. Comments start with `#`.

## Output Directives

| Directive | Description |
|-----------|-------------|
| `Output demo.gif` | Output as GIF (default) |
| `Output demo.webm` | Output as WebM (smaller, better quality) |
| `Output demo.mp4` | Output as MP4 |
| `Output "/path/with spaces.gif"` | Absolute/quoted path |

Multiple `Output` lines → multiple files from one tape.

## Set Directives (Window & Style)

| Directive | Default | Description |
|-----------|---------|-------------|
| `Set FontSize <n>` | 16 | Terminal font size (px) |
| `Set FontFamily "<name>"` | "Monaco" | Font family; use Nerd Font for icons |
| `Set Width <n>` | 1200 | Output width (px) |
| `Set Height <n>` | 600 | Output height (px) |
| `Set Padding <n>` | 0 | Window padding (px) |
| `Set LetterSpacing <n>` | 0 | Letter spacing (px) |
| `Set LineHeight <f>` | 1.2 | Line height multiplier |
| `Set Framerate <n>` | 50 | Frames per second |
| `Set LoopOffset <duration>` | 0s | GIF loop start offset |
| `Set Theme "<name>"` | "Dracula" | Color theme |
| `Set Shell "<name>"` | "bash" | Shell: bash / zsh / fish / powershell / cmd |
| `Set CursorBlink <bool>` | true | Cursor blink animation |
| `Set TypingSpeed <duration>` | 50ms | Default per-char typing speed |

### Built-in Themes

`Dracula`, `Catppuccin Mocha`, `Catppuccin Macchiato`, `Catppuccin Frappe`, `Catppuccin Latte`, `Gotham`, `GitHub Dark`, `GitHub Light`, `Gruvbox Dark`, `Gruvbox Light`, `Monokai`, `Nord`, `One Dark`, `One Light`, `PowerShell`, `Solarized Dark`, `Solarized Light`, `Tokyo Night`, `Rose Pine`, `Rose Pine Moon`, `Rose Pine Dawn`

## Input Directives

### Typing

| Directive | Description |
|-----------|-------------|
| `Type "text"` | Simulated typing with animation (uses TypingSpeed) |
| `Type@100ms "text"` | Typing with custom per-char speed |
| `Type "multi\nline"` | Type with newlines |

### Single Keys

| Directive | Description |
|-----------|-------------|
| `Key "x"` | Single keypress, no animation |
| `Key@500ms "x"` | Key with explicit hold duration |
| `Enter` | Return key |
| `Space` | Spacebar |
| `Tab` | Tab key |
| `Backspace` | Backspace |
| `Backtab` | Shift+Tab |
| `Ctrl+C` / `Ctrl+D` / `Ctrl+L` | Ctrl combinations |
| `KeyUp` / `KeyDown` / `KeyLeft` / `KeyRight` | Arrow keys |
| `PageUp` / `PageDown` | Page navigation |
| `Home` / `End` | Line navigation |
| `Escape` | ESC key |

### Special Characters in Type

| Literal | Meaning |
|---------|---------|
| `\n` | Newline (without submitting) |
| `\t` | Tab |
| `\r` | Carriage return |

## Flow Control

| Directive | Description |
|-----------|-------------|
| `Sleep 2s` | Wait fixed duration (s/ms) |
| `Sleep 500ms` | Half-second wait |
| `Wait+` | Wait for terminal to be idle (no output for ~1s) |
| `Wait@5s` | Wait, max 5s |
| `Wait@500ms` | Wait, max 500ms |

## Display Control

| Directive | Description |
|-----------|-------------|
| `Hide` | Hide subsequent input (typed text not shown) |
| `Show` | Restore input visibility |
| `Screenshot frame.png` | Capture current frame as PNG |
| `Require foo` | Fail if command `foo` not found in PATH |

## Environment

| Directive | Description |
|-----------|-------------|
| `Env KEY=value` | Set environment variable |
| `Source ~/.bashrc` | Source a shell file before recording |

## Duration Format

All `Sleep`, `Wait@`, `Type@`, `Key@` accept durations:

- `500ms` — milliseconds
- `2s` — seconds
- `1m` — minutes
- `2s500ms` — combined

## Execution Modes

```bash
vhs demo.tape                # Execute tape → GIF (primary mode)
vhs -o out.gif demo.tape     # Override output path
vhs -t demo.tape             # Dry-run, print parsed tape (no GIF)
echo 'Type "ls" Enter Sleep 1s' | vhs -o out.gif -   # stdin mode
vhs record demo.tape         # Record real interaction → tape file
vhs record > demo.tape       # Record to stdout
```

## Comments

```tape
# This is a comment, ignored by VHS
Output demo.gif  # Inline comments also work
```

## Example: Full Feature Showcase

```tape
# Output and window
Output showcase.gif
Set FontSize 14
Set FontFamily "JetBrains Mono Nerd Font"
Set Width 1000
Set Height 560
Set Padding 16
Set Theme "Catppuccin Mocha"
Set Framerate 60
Set CursorBlink true
Set Shell "bash"

# Environment
Env MY_VAR=demo
Source ~/.bashrc

# Recording
Type@30ms "echo 'Starting demo'"
Enter
Wait+

# Hidden setup
Hide
Type "secret-setup-command"
Enter
Wait+
Show

# TUI interaction
Type@30ms "./my-tui --demo"
Enter
Sleep 1s

Key@500ms Down
Key@500ms Down
Key@1s Enter
Sleep 2s

# Capture a frame
Screenshot menu-frame.png

# Navigation
Key@500ms Tab
Key@500ms Tab
Sleep 1s

# Exit
Type "q"
Sleep 800ms

# Cleanup
Type@30ms "echo 'Demo complete'"
Enter
Sleep 1s
```
