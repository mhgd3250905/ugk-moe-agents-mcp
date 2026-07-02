# TUI Product Demo Template — VHS Tape
# Copy this file, rename to <your-product>.tape, customize the marked sections.
# Usage: vhs <your-product>.tape

# ============================================================
# OUTPUT — choose one or more formats
# ============================================================
Output demo.gif
# Output demo.webm          # smaller + better quality, for websites
# Output demo.mp4           # universal video

# ============================================================
# WINDOW & STYLE
# ============================================================
Set FontSize 14
Set FontFamily "JetBrains Mono"          # use Nerd Font variant for icons
Set Width 1000
Set Height 560
Set Padding 16
Set Theme "Catppuccin Mocha"             # alternatives: Dracula, Tokyo Night, Nord, Gruvbox Dark
Set Framerate 60                          # 30 for smaller GIF, 60 for smooth
Set CursorBlink true
Set Shell "bash"                          # powershell / cmd / zsh / fish
Set LoopOffset 3s                         # skip intro on loop

# ============================================================
# ENVIRONMENT (optional)
# ============================================================
# Env DEMO_MODE=true
# Source ~/.bashrc

# ============================================================
# RECORDING — customize below
# ============================================================

# --- Intro: show a welcome line -----------------------------
Type@30ms "echo 'Welcome to <Your Product>'"
Enter
Wait+
Sleep 1s

# --- Launch the TUI -----------------------------------------
# Replace './your-tui' with the actual command to start your TUI
Type@30ms "./your-tui"
Enter
Sleep 1s                  # give TUI time to render

# --- Demo: navigation ---------------------------------------
# Adjust keys to match your TUI's keybindings
Key@1s Down               # move down
Key@1s Down
Key@1s Enter              # select item
Sleep 2s                  # let user see result

Key@500ms Tab             # switch pane/tab
Key@500ms Tab
Sleep 1s

Key@500ms Up              # move back up
Sleep 1s

# --- Optional: capture a still frame ------------------------
# Screenshot menu.png

# --- Demo: search/filter (if applicable) --------------------
# Type@30ms "search term"
# Sleep 1s
# Backspace
# Sleep 500ms

# --- Exit ---------------------------------------------------
Type "q"                  # or Ctrl+C, or whatever your TUI uses
Sleep 800ms

# --- Outro --------------------------------------------------
Type@30ms "echo 'Demo complete'"
Enter
Sleep 1s
