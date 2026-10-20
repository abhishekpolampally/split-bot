<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Project management (Project Tracker)

This repo is tracked in Project Tracker as project `splitbot` (item refs look like `SPLI-12`).
Use the `project-tracker` MCP tools (or the REST API at http://localhost:3737/api/v1).

**At the start of every session**
1. Call `get_briefing` with project `splitbot` and read it fully.
2. Handle **directives** from the human first. Mark each `acknowledged` when you start and
   `resolved` with a short response when done (`update_input`).
3. Read **answers to your questions**, apply them, then mark those questions `resolved`.

**Picking up work**
- Work through the items in `todo` (`list_items` with status `todo`), highest priority first.
- Skip any item whose `blocked_by` lists an item that isn't `done` (shown as ⛔ in the
  briefing). Merged or `in_review` isn't enough: come back to it once the blocker is `done`.
- Take items one after another. Give each its own branch from `master` (e.g. `spli-12-short-title`)
  and its own pull request whose title starts with the ref (`SPLI-12: …`). Link the PR in an item
  comment and move the item to `in_review`.
- Items that change nothing in the repo (local setup, console clicks) need no PR: do them, then
  comment with what was done.

**While working**
- Move items you work on to `in_progress`; when done, move to `in_review` (or `done` if fully
  verified by tests) and add a comment with what changed (files, PR link, how to verify).
- Log bugs, improvement ideas and follow-up tasks you notice with `create_item` (don't fix
  unrelated things silently).
- If you need a product decision, call `ask_human` and continue with other work. Don't block.
- Keep the project overview current with `update_project` if architecture or scope changes.

**At the end of every session**
- Call `post_update` with a one-line summary and markdown details: what changed, what's next,
  open risks.


