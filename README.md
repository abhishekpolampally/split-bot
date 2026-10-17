# SplitBot

A Splitwise-style bill splitter where splitting is a chat message. Tag `@splitbot` in a group chat with what you paid and it replies with a proposal card; the payer taps **Confirm**, balances update, and everyone settles over UPI.

Next.js 16 (App Router; the backend lives in route handlers), Postgres via Docker, Drizzle ORM, Tailwind v4, and an installable PWA.

## Quick start

```bash
pnpm install
pnpm setup            # starts Postgres in Docker (port 5440) and runs migrations
pnpm dev              # http://localhost:3000
```

Copy `.env.example` to `.env.local` if it isn't there already. The only required value is `DATABASE_URL`.

### OpenAI (optional)

Put `OPENAI_API_KEY=sk-...` in `.env.local` and restart. Without a key, SplitBot uses its built-in rule parser (`src/lib/bot/rules.ts`). That parser handles the common phrasings already, so the app works fully without the key. With a key, messages go to `OPENAI_MODEL` (default `gpt-5-mini`) using a strict JSON schema. If the call fails it falls back to the rule parser.

### Login / OTP

Login is phone number + 6-digit OTP. No SMS provider is wired up yet (`sendSms` in `src/lib/server/auth.ts`), so with `OTP_DEV_MODE=true` the code shows on the login screen and in the server log. That's fine for a private beta with friends. Set it to `false` once SMS is connected.

## Using it with friends tonight

**Same Wi-Fi (simplest):**

```bash
pnpm build && pnpm start      # listens on 0.0.0.0:3000
```

Friends open `http://<your-laptop-ip>:3000` on their phones; `ipconfig getifaddr en0` shows the IP. Everything works over plain http. The only gap is "Add to Home Screen" installs, which need HTTPS.

**From anywhere, plus PWA install (HTTPS tunnel):**

```bash
brew install cloudflared
cloudflared tunnel --url http://localhost:3000
```

Share the `https://….trycloudflare.com` URL. Session cookies become `Secure` automatically over HTTPS.

Flow: create a group → add friends by name (a phone number is optional and auto-links them when they sign up) → share the invite link from **Group info** → each friend logs in and taps "I'm Riya" to claim their name.

## What the bot understands

| You type | Result |
| --- | --- |
| `@splitbot cab 640, me and Neha` | ₹320 each, paid by you |
| `@splitbot dinner 2.4k everyone except Riya` | equal split among the rest |
| `@splitbot Kabir paid 1800 for petrol` | Kabir is the payer (Kabir confirms) |
| `@splitbot rent 30000 60-40 between me and Neha` | percentages |
| `@splitbot villa 5000 Kabir 2 shares` | shares (others 1) |
| `@splitbot groceries 1500, Riya 500, rest on me` | exact + remainder |
| `@splitbot drinks 2000, Kabir +200` | adjustment on top |
| `@splitbot paneer 380, beer x3 540, gst 46, service 92. only me and Kabir had beer` | item-wise, tax/service pro-rated, tap-to-claim chips |
| `@splitbot dinner 2400, drinks 600 except Riya` | Riya skips only the drinks |
| reply to a card: `@splitbot make that 2000` / `actually Kabir paid` / `remove Riya` | updated card |
| `@splitbot cancel the cab one` | asks before deleting |
| `@splitbot who owes me?` · `how much did we spend on food` · `settle` | answers / settle-up card |

When something is ambiguous (an unknown name, two Riyas, "split 3 ways" in a 5-person group, "Riya didn't drink" with no drinks amount), the bot asks one question with tappable options. It asks at most two before it falls back to defaults. The **+** button in the composer opens a manual add/edit form that goes through the same confirm flow.

## Design notes (from the PRD)

- **The LLM never does maths that ships.** Parsers output a structured intent (`src/lib/bot/types.ts`). The split engine (`src/lib/split/engine.ts`) computes everything in integer paise, floors to the paisa and gives leftover paise to the payer. It also rejects totals that don't reconcile (±1%).
- **Nothing hits the ledger silently.** Every expense starts as a proposal card. Only the payer can confirm, or the sender if the payer hasn't joined yet. Anyone can tap their own item chips; the payer or sender can change anyone's. Edits use optimistic locking (`version`).
- **Prompt-injection guard:** amounts the LLM returns must appear in the sender's own text, otherwise the card is flagged for review. The payer can't be set to someone else without that person's tap.
- Settle-up uses greedy minimum transfers and UPI deep links (`upi://pay?pa=…&am=…&tn=…`), plus "I've paid", "Mark received" and "Remind" (which posts a bot nudge in the chat).
- Realtime is short polling (2.5s, or 0.9s while the bot is typing) on `/api/groups/:id/messages?after=&since=`, which keeps it simple and reliable.

## Layout

```
src/app/                 pages (chat list, /g/[id] chat, balances, settle, info, login, join) + /api routes
src/lib/split/           engine, debt simplification, types (unit-tested)
src/lib/bot/             rule parser, OpenAI parser, spec builder (clarifications), orchestrator
src/lib/server/          auth (OTP + sessions), ledger, proposals, messages
src/db/schema.ts         Drizzle schema; migrations in drizzle/
public/sw.js             service worker (app shell + offline page; API is never cached)
```

`pnpm test` runs the engine and parser tests, including the PRD's Toit dinner example (₹701.50 / ₹701.50 / ₹391 / ₹391).

## Not in V1 yet

Receipt photo parsing (phase 2), push notifications, read receipts and reactions, 1:1 chats, real SMS delivery, a dispute window, and CSV export.
# split-bot
