---
name: protoserve
description: Serve HTML prototypes with inline element comments, and read, address, reply to or resolve them. Use when the user wants to preview a prototype, check prototype feedback, or act on comments left on an HTML page.
allowed-tools:
  - Bash(protoserve *)
  - Bash(open *)
  - Read
  - Edit
  - Write
---

# protoserve — comments on HTML prototypes

The user clicks elements in a served HTML prototype and leaves comments. Comments live in `.protoserve/` beside the file; **the prototype source is never modified by the tool** — only by you, when addressing feedback.

## Serve a prototype

```bash
protoserve <absolute-path> --no-open &
```

Use an absolute path. A file serves its folder and opens at that file; a folder serves everything in it. Tell the user to press **C** in the page to start commenting.

## Read the comments

```bash
protoserve comments <file>           # JSON, all comments
protoserve comments <file> --open    # only unresolved
protoserve comments <file> --text    # human-readable
```

Each comment gives you:

- `text` — what the user wants changed
- `number` — the pin number they see on screen; refer to comments this way
- `anchor.line` / `anchor.col` — the element's position **in the file as it is right now**
- `anchor.selector`, `anchor.tag`, `anchor.outer_html` — what was clicked
- `anchor.selected_text` — set when they highlighted specific copy; the change is about that wording
- `anchor.computed` and `anchor.box` — real spacing, type and colour values, for visual feedback
- `anchor.verified` — `false` means do not trust the line; find the element by `outer_html` first
- `anchor.resolution` — `"not_found"` means it is not in the static HTML, usually because JavaScript built it
- `anchor.source_matches` — candidate `{file, line, matched, preview}` locations that generate the element, offered whenever the anchor could not be pinned down. When `matched` is `"text"` the line contains the exact copy; `"class"`/`"id"` usually lands on the template literal or the stylesheet. Read the previews and pick the one that builds the element — do not assume the first.
- `state` — open dialogs, active tab, viewport, scroll: which screen they were on
- `screenshot` — an absolute path to a PNG of what they were looking at
- `replies` — prior discussion on the thread

## Addressing comments — the loop

1. `protoserve comments <file> --open` to get the work.
2. **Read the screenshot** with the Read tool for anything visual — spacing, alignment, hierarchy, "this looks wrong". It shows you exactly what they saw, including the state.
3. Edit the source at `anchor.line`. Confirm you are on the right element by checking it against `anchor.outer_html` before editing — always, and especially when `verified` is `false`. If there is no line, work from `anchor.source_matches`: open the candidate that generates the element and edit the template there.
4. Reply on the thread saying what you changed:
   `protoserve reply <file> <id> "Changed the label to Make a payment."`
5. Resolve it: `protoserve resolve <file> <id1> <id2> ...`

Resolve only what you actually did. If a comment is ambiguous or you disagree, reply asking the question and leave it open — the user sees replies in the page.

The user's open browser updates live as you resolve, without reloading, so they keep whatever prototype state they had set up. Never tell them to refresh.

## React to comments as they arrive

```bash
protoserve watch <file> --new
```

One JSON object per line, emitted as each comment lands. Use this when the user wants you working alongside them rather than in a batch.

## Other commands

```bash
protoserve unresolve <file> <id>...   # reopen
protoserve delete <file> <id>...      # permanent; only when the user asks
protoserve list                       # running instances
protoserve kill --all                 # stop them
```

## Rules

- Never edit `.protoserve/comments.json` by hand — use the CLI.
- Never delete a comment unless the user explicitly asks.
- Group your edits by file and re-read comments after a large refactor, since line numbers are recomputed on every read.
- If several comments touch the same element, address them together.
- Report back by pin number ("#1, #3 and #4 done; #2 needs a decision from you"), because that is what the user sees on screen.
