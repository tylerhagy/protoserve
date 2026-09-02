# protoserve

Serve a folder of standalone HTML prototypes, click any element to leave a comment, then hand the whole batch to your AI coding agent to address.

Prototyping with an AI agent is fast right up to the moment you want to give feedback. Then it collapses into describing things one at a time — "the button in the second card", "the spacing under the heading" — and taking screenshots. protoserve replaces that with the thing design tools already got right: point at it and say what's wrong.

You leave ten comments in two minutes. Your agent reads them with one command, and each one arrives with an exact source line, a screenshot of what you were looking at, and the state the page was in.

**Your prototype files are never modified.** Comments live beside them in `.protoserve/`.

---

## Install

Requires Node 18+.

```bash
npm install -g github:tylerhagy/protoserve
```

If that asks for `sudo` — npm's global folder is often root-owned on macOS — install without it:

```bash
git clone https://github.com/tylerhagy/protoserve.git ~/Projects/protoserve
cd ~/Projects/protoserve && npm install
ln -s ~/Projects/protoserve/bin/protoserve.js ~/.local/bin/protoserve
```

(Use any folder on your `PATH` in place of `~/.local/bin`.)

Check it: `protoserve --version`

---

## Quick start

```bash
protoserve ./prototypes          # a folder of .html files
protoserve ./prototypes/dashboard.html   # or one file
```

Your browser opens. Then:

1. Press **C** (or click **Comment**).
2. Click any element — a button, a heading, an icon, a whole card. Or select text and click.
3. Type what should change. **⌘↵** saves.
4. Keep going. Comment mode stays on, so you can work through a screen in one pass.
5. Press **Esc** when you're done, and tell your agent: *"address the protoserve comments on dashboard.html"*

---

### Keeping a server up

`protoserve` runs in the foreground and stops with Ctrl+C, which is what you want at a terminal. It also means the server dies with whatever launched it — close the terminal, or let a CI step or an AI agent's task get torn down, and the server goes with it.

```bash
protoserve ./prototypes --detach
```

`--detach` starts it in its own session, reparented away from the caller, and returns as soon as it has bound the port. It prints the URL and pid, survives the shell that started it, and is stopped with `protoserve kill`.

---

## Working with Claude Code

Install the bundled skill once:

```bash
cp -r skills/protoserve ~/.claude/skills/
```

Then just say **"address the comments on dashboard.html"**. Claude reads them, edits the HTML, replies on each thread, and resolves it. Your open page updates as it goes — no reload, so you keep whatever state you had set up.

Without the skill, this also works:

```
Run `protoserve comments ./prototypes/dashboard.html`, fix each unresolved
comment at the line it names, then resolve it with `protoserve resolve`.
```

---

## What a comment carries

Everything an agent needs to act without asking you a follow-up question:

| | |
|---|---|
| **`line` / `col`** | Where the element is in the source **right now** — re-resolved on every read, so it stays correct after edits |
| **`selector`, `tag`, `outer_html`** | What was clicked, and its markup |
| **`selected_text`** | The exact copy you highlighted, for wording changes |
| **`screenshot`** | A PNG of the viewport as you saw it |
| **`state`** | Open dialogs, active tab, viewport size, scroll position, hash |
| **`computed`** | Real margin, padding, font size and colour — so "too tight" is actionable |
| **`box`** | Position and size of the element |
| **`verified`** | Whether the anchor is certain (see below) |
| **`source_matches`** | When the element was built by JavaScript: candidate lines in your source that generate it |

---

## Keyboard and UI

| | |
|---|---|
| **C** | Toggle comment mode |
| **Esc** | Close a card, or leave comment mode |
| **⌘↵** / **Ctrl+↵** | Save the comment you're typing |
| Numbered pin | Click to open that thread |
| List button | All comments, filtered by Open / Resolved |

Comment mode and the comment list survive a live reload, so when your agent edits the file mid-review you carry on where you were.

### Switching prototypes

The comment panel is titled with the prototype you're on and the number of open comments against it. When the folder holds more than one `.html`, that title is a menu: it lists every prototype with its own open count, so you can see where the feedback is before you jump. Serve a folder and you can work through a set of variants without going back to the index.

### Pin colour

Pins, the element highlight and the selector tag are drawn in one colour, chosen from the swatches at the bottom of the panel. The choice is stored in the browser, per origin — and the port is part of the origin, so if protoserve has to fall back from 8300 to 8301 (another instance already holds the port) you'll start from blue again on the new one.

The default is blue, which is the wrong choice for a lot of prototypes — most design systems lean on blue, and blue pins disappear into a blue UI. Pick a colour your product doesn't use and the annotation layer stops competing with the thing you're annotating. Green and red aren't offered: this UI already spends them on resolved and delete.

Changing it moves only the marks protoserve paints **on** your prototype. The panel's own chrome stays put.

Every destructive action is undoable. Delete and resolve both show an **Undo** toast for eight seconds, and a deleted thread comes back with its id, number, replies and screenshot intact. Both are reachable from the pin, from inside the thread, and straight from the comment list on hover.

While comment mode is on, clicks are intercepted so buttons don't fire and links don't navigate. Turn it off to click through your prototype normally, get to the state you care about — a modal, step 3 of a flow, an error — then turn it back on and comment there. The state travels with the comment.

---

## CLI

```
protoserve [path] [-p PORT] [--host HOST] [--no-open]

protoserve comments <file> [--open|--resolved] [--text]   List comments as JSON
protoserve resolve <file> <id>...                         Mark resolved
protoserve unresolve <file> <id>...                       Reopen
protoserve delete <file> <id>...                          Delete permanently
protoserve reply <file> <id> <text>                       Reply on a thread
protoserve watch [file] [--new]                           Stream events as JSONL
protoserve list                                           Running instances
protoserve kill <pid>... | --all                          Stop instances
```

`protoserve watch <file> --new` prints one JSON object per line as comments land. Park it on stdout if you want your agent reacting to feedback as you type it rather than in a batch.

---

## How anchoring stays accurate

An element is recorded several ways at once: its `id`, its identifying attributes (`aria-label`, `alt`, `title`, `href`…), its tag, text and classes, its structural path, its exact position in the file, and where it sits relative to the nearest sibling that *differs* from it. When comments are read back, protoserve re-parses the file **as it is at that moment** and weighs every candidate element against all of that evidence at once.

Weighing matters, because any single signal lies. Text repeats across four identical cards. A class set matches a sibling. A structural index shifts the moment something is inserted above. Three identical pricing cards are told apart only by their position relative to the one card that reads differently — which is exactly what the sibling signature records, and it survives insertions and deletions.

The rule it follows: **a confidently wrong line is worse than no line.** `verified: true` is granted only when some matched signal identifies exactly one element and nothing else contradicts the recording. Otherwise the comment comes back `verified: false`, or `resolution: "not_found"` with the original `outer_html` to match against — never a plausible-looking line number pointing at the wrong thing.

`npm run bench` measures this: 22 anchors built by the real browser client, put through 20 realistic edits (insert a sibling, wrap in a container, rename a tag, rewrite copy, delete a row, reorder, restyle). Current result over 680 cases:

| | |
|---|---|
| correct and verified | **94.7%** |
| correct but flagged unverified | 1.8% |
| not found (flagged, with source candidates) | 1.5% |
| wrong but flagged unverified | 0.9% |
| **wrong and verified** | **0%** |

The last row is the one that matters, and a test fails the build if it ever stops being zero. The remaining imperfect cases are all the genuinely ambiguous kind — a block of byte-identical cards with another identical card inserted into it — and every one of them is flagged rather than asserted.

---

## Where things live

```
your-prototypes/
├── dashboard.html          ← never modified
└── .protoserve/
    ├── comments.json
    ├── screenshots/
    └── .gitignore          ← screenshots ignored by default
```

Delete `.protoserve/` to clear every comment. Commit `comments.json` if you want feedback tracked in git.

---

## Honest limitations

- **Built for standalone HTML.** The served DOM is the source, which is what makes line mapping exact.
- **Markup built by JavaScript has no source line**, and protoserve says so rather than guessing. It then greps your prototype and its sibling `.js`/`.html` files for the element's text, id and class names, and returns candidate lines — usually landing directly on the template literal that renders it. Good enough to work from; not the certainty you get with static markup.
- **React/Vite builds are out of scope.** A bundled app's DOM has no relationship to your source files.
- **Screenshots are DOM-rendered**, not real browser captures. `backdrop-filter`, some shadows, cross-origin images and iframes may look off. The computed styles and bounding box are there so your agent isn't relying on the picture alone.
- **Localhost only.** Requests from other hosts and cross-origin writes are refused. There is no auth and no sharing — it is a single-person tool.
- **Chromium and Safari** get the top-layer handling that keeps the UI usable above native modal dialogs. Firefox works otherwise.

---

## Development

```bash
npm install
npm test          # 87 tests: unit + end-to-end in real Chromium
npm run bench     # resolver accuracy matrix (680 cases)
npm run test:unit # fast, no browser
```

The end-to-end suite drives an actual browser: it verifies the overlay never shifts the prototype's layout, that clicks are intercepted, that comments survive edits to the file, that the store can't be read over HTTP, and that the UI still works above a modal dialog.

---

## License

MIT
