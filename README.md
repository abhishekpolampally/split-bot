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

### Firebase: login, analytics, performance, push

Login is mobile number + SMS code through **Firebase Phone Auth**. The browser signs in with Firebase (invisible reCAPTCHA + SMS), posts the ID token to `/api/auth/firebase`, and the server verifies it and issues SplitBot's own session cookie (HttpOnly). Sessions roll: each day of use extends them to a full year, so people only see the OTP screen as new users, after logging out, or after a year away. Accounts are matched by phone number, so users from before Firebase keep their groups.

Setup in the [Firebase console](https://console.firebase.google.com) for the `split-bot` project:

1. **Upgrade to Blaze** (pay as you go). Firebase only sends real SMS on Blaze; India is charged per SMS.
2. **Authentication → Sign-in method → Phone → Enable.** Under *Phone numbers for testing*, add a few test numbers with fixed codes for development (no SMS, no cost).
3. **Authentication → Settings → Authorized domains:** add your Vercel domain(s). `localhost` is there by default.
4. **Project settings → Your apps → Add app → Web**, then copy the config into the `NEXT_PUBLIC_FIREBASE_*` variables (see `.env.example`).
5. **Analytics:** enable Google Analytics for the project; the web config then includes `measurementId`.
6. **Push:** Project settings → Cloud Messaging → *Web Push certificates* → generate a key pair → `NEXT_PUBLIC_FIREBASE_VAPID_KEY`. Then Project settings → Service accounts → *Generate new private key* → `FIREBASE_CLIENT_EMAIL` and `FIREBASE_PRIVATE_KEY` (server only).

Analytics logs page views plus app events (`login`, `group_create`, `member_add`, `invite_share`, `invite_join`, `bot_request`, `expense_confirm`, `settle_record`, `reminder_send`, `push_enable`); no phone numbers, names or message text are sent. Performance Monitoring records real page loads and API timings from phones. Server errors stay in Vercel's logs.

Push notifications (turned on per device from **Profile**) go out for new chat messages, new and confirmed splits, reminders and recorded payments. iPhones only get them after SplitBot is added to the Home Screen (iOS 16.4+). The service worker, and so push, runs in production builds only.

### Who can add people

Only a group's **owner** (its creator) adds people, and always by mobile number: **Choose from contacts** (Chrome on Android, via the Contact Picker API) or **Add by mobile number**, which checks the exact number against SplitBot's users (no partial search, rate limited). People not on SplitBot yet are added by name and linked automatically when they sign up with that number. Everyone else joins through the group's invite link; a joiner can only claim a spot saved for their own number (or an old spot added without one).

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

Flow: create a group → add friends from your contacts or by number (they're linked when they sign up) → or share the invite link from **Group info** so friends can join themselves.

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
src/lib/server/          auth (Firebase sign-in + sessions), membership, push, ledger, proposals, messages
src/db/schema.ts         Drizzle schema; migrations in drizzle/
public/sw.js             service worker (app shell + offline page; API is never cached)
```

`pnpm test` runs the engine and parser tests, including the PRD's Toit dinner example (₹701.50 / ₹701.50 / ₹391 / ₹391).

## Not in V1 yet

Receipt photo parsing (phase 2), read receipts and reactions, 1:1 chats, a dispute window, and CSV export.
# split-bot
