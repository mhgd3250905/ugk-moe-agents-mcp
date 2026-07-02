---
name: skill-guide
description: Use when the user wants to install, create, edit, list, or remove a skill in UGK, asks where skills live, where to put a new skill, how to add an external skill repo, or why a skill is/isn't loading. Also use when you finish drafting a skill with skill-creator and need to know where to save it.
---

# Skill Guide

UGK skills come from exactly two sources, both inside the ugk install directory. Everything outside is ignored.

## Two sources

1. **System skills** — `<ugk>/skills/` (ugk-guide, mcp-guide, bash-guide, chrome-cdp-guide, skill-creator, docx, skill-guide, ...). Ship with ugk. **Read-only** — a ugk update overwrites them.
2. **User skills** — `<ugk>/user-skills/`. Where every skill you install or create goes. Travels with the ugk install: clone ugk to a new machine and these come along.

`<ugk>` is the ugk install root — the repo dir if you `git clone`d, or the npm package dir if you installed globally. It is the same place for every `ugk` launch, regardless of which folder you run it from.

Directories like `~/.agents/skills/`, `~/.pi/agent/skills/`, and `<cwd>/.pi/skills/` are excluded by ugk's `!skills/**` rule. A skill placed there **will not load**. Don't use them.

## Where to install / create

**Every** user skill goes directly under `<ugk>/user-skills/<skill-name>/`:

```
<ugk>/user-skills/
├── bili-spider/
│   ├── SKILL.md
│   └── scripts/fetch.py
└── tts-concat/
    ├── SKILL.md
    └── assets/template.json
```

Create the dir if missing: `mkdir -p <ugk>/user-skills/<name>`.

### Install from an external repo (flatten)

External skill repos often nest skills: `someRepo/skills/foo/SKILL.md`, `someRepo/skills/bar/SKILL.md`, plus `README`, `.git`, `tests`, `benchmarks`. **Do not** keep that wrapper structure. Flatten — take each skill bundle's body and lay it directly under `user-skills/`:

```
source: someRepo/
  skills/
    foo/SKILL.md          ──→  <ugk>/user-skills/foo/SKILL.md
    foo/scripts/x.py      ──→  <ugk>/user-skills/foo/scripts/x.py
    bar/SKILL.md          ──→  <ugk>/user-skills/bar/SKILL.md
  README.md, .git/, ...        (drop these)
```

Steps:
1. Clone/download to a temp dir.
2. Find every `SKILL.md` under it.
3. For each, copy its **whole bundle** (the `SKILL.md` plus same-dir `scripts/`, `assets/`, `references/`) into `<ugk>/user-skills/<skill-name>/`.
4. Drop the repo's wrapper dirs, `README`, `.git`, `tests`, `benchmarks`, license files — anything that isn't part of a skill bundle.

Wrong: `user-skills/someRepo/skills/foo/SKILL.md` (nested wrapper).
Right: `user-skills/foo/SKILL.md` (flattened).

### Create a new skill

```bash
mkdir -p <ugk>/user-skills/<name>
```

Write `<ugk>/user-skills/<name>/SKILL.md` with frontmatter (`name` + `description`) and the body. You may use the **skill-creator** skill to draft and refine the content — but the **final save path must be `<ugk>/user-skills/<name>/`**, never skill-creator's default locations (`/tmp/`, project root, etc.).

### Remove a skill

```bash
rm -rf <ugk>/user-skills/<name>
```

## What not to do

- Do not save skills to `~/.agents/skills/`, `~/.pi/agent/skills/`, `/tmp/`, or the project `cwd` — they won't load.
- Do not edit system skills under `<ugk>/skills/` — updates overwrite them. If you need to customize one, copy it into `user-skills/` and edit there.
- Do not use `pi install` / the `packages` settings field to add skills. That clones whole repos into `~/.pi/agent/git/` and registers a package — not ugk's skill model. ugk only loads `<ugk>/user-skills/`.
- Do not keep wrapper/nesting layers when installing from a repo. Flatten to one dir per skill.
- 不要把 skill 写进带中间包裹目录的层级(如 `user-skills/repo-name/skills/foo/`),直接平铺到 `user-skills/foo/`。

## Skill bundle shape

A skill bundle is one directory containing `SKILL.md` plus optional siblings:

```
skill-name/
├── SKILL.md          (required; frontmatter name + description)
├── scripts/          (executable helpers)
├── assets/           (templates, icons)
└── references/       (docs loaded on demand)
```

Keep `SKILL.md` under ~500 lines; offload detail to `references/`.
