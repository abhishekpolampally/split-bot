# ADR 0001: Voice in the group chat

- **Status:** Accepted, 2026-10-20
- **Ticket:** SPLI-26 (decision). The build is SPLI-20.

## Context
We want two kinds of voice in the chat. First, voice messages between people, like WhatsApp. Second, speaking to SplitBot instead of typing ("@splitbot cab 640, me and Neha").

The first idea was to transcribe a clip only when the trigger word "SplitBot" is spoken. That needs speech recognition on every clip to find the word, so it would save no cost. The alternatives were partial transcription of the first few seconds, or wake-word detection on the phone. Both are fragile on iOS and add cost or weight. iOS Safari and the installed PWA are must-have targets.

## Decision
**The user picks who they're talking to by tapping a different button. Nothing is detected.**

| | 🎤 Voice message | 🤖 Talk to SplitBot |
|---|---|---|
| Who hears it | The group | The bot |
| Speech-to-text | **Never** | Yes (Groq Whisper, `src/lib/server/stt.ts`) |
| Audio stored | Yes, in private storage | No, thrown away after transcribing |
| Result | A `voice` message in the chat with a player | The transcript in the text box with `@splitbot `, for the user to check, edit and send |
| Max length | 60 s | 30 s |

Only the SplitBot path ever reaches the speech-to-text provider. Voice messages are never transcribed.

The SplitBot path keeps our product rule that *nothing reaches the ledger silently*. The transcript is never sent automatically, and the bot still only proposes; someone has to confirm.

### Voice messages
- **Message model.** A new `MessageKind` `"voice"`.
  - `data: { blobPath, mime, durationMs, sizeBytes }`.
  - `body` is "🎤 Voice message (0:12)", for previews and push.
  - `kind` is a `text` column, so **no DB migration** is needed.
- **Storage.** **Vercel Blob, private store.** It's native to our Vercel deploy and needs no new vendor. Paths look like `voice/{groupId}/{messageId}.{ext}`.
- **Upload.**
  - `POST /api/groups/[id]/voice` (multipart, ≤ 2 MB / 60 s, `requireMember`). The server writes to Blob and then posts the message.
  - Clips are well under Vercel's 4.5 MB body limit, so we don't need direct client uploads.
- **Playback.**
  - `GET /api/groups/[id]/voice/[messageId]` checks membership and streams the blob. No public URLs.
  - The client `fetch`es the file and plays it from an object URL. This avoids iOS Safari's need for HTTP range responses on `<audio src>`.
- **Format.**
  - Record `audio/mp4` (AAC) where `MediaRecorder.isTypeSupported` allows it; it plays back everywhere. Otherwise use `audio/webm;codecs=opus`.
  - Verify cross-browser playback as part of SPLI-20.
- **Other parts of the chat:**
  - **IndexedDB cache:** stores the message metadata only, never the audio.
  - **Replies and reactions (SPLI-18):** work on voice messages like any other message.
  - **Retention:** audio is kept as long as the message is. Cleaning it up when a group is deleted is a follow-up.

### Talk to SplitBot
This is unchanged from the original SPLI-20 plan: record → `POST /api/groups/[id]/transcribe` → `normalizeTranscript` → fill the Composer.

## Options considered
- **Transcribe every clip and look for "SplitBot".** Accurate, but every voice message goes through speech-to-text: cost, and privacy.
- **Transcribe only the first ~3 s.** Cheaper, but fragile. It needs the word said first, and providers may bill a minimum per request.
- **Wake-word detection on the phone** (Porcupine, an open-source KWS model, the Web Speech API). Licensing or model training, extra client weight, and poor iOS support.
- **Storage alternatives.** Firebase Storage and Cloudflare R2/S3 both work. Neither beats Blob enough to justify another integration, and a storage module behind one interface keeps switching cheap.

## Consequences
- The UX is explicit: two buttons, no surprises. It costs nothing for ordinary voice messages and is reliable on iOS.
- Users can't just say "SplitBot …" in a voice message to reach the bot. Automatic trigger-word detection can come later behind the same message model if it's wanted (see SPLI-23 for on-device STT).
- **Founder setup:**
  - create a **private** Blob store in Vercel and connect it to the project;
  - pull the env vars for local dev;
  - set `STT_API_KEY`, `STT_BASE_URL` and `STT_MODEL`.
