# NCR + Self-Evolving Identities — Design Notes

> **Status: brainstorm, not a spec — do not implement yet.**
> This is a captured design alignment. Several pi-durable behaviors are
> still unverified (noted at the end). Treat every section as a direction
> we agreed on, not a build order.

---

## North star

Self-evolving identities, each with their own world. Not a bot with a
scenario — the user enters a whole living world. A third-party user picks
an identity from a platform and chats; behind it is that identity's full
history, moods, relationships, and private inner life. It has been living
between visits.

---

## The actual minimum (MVP floor)

Before any of the layers below, the bare-bones pipe is small:

- **One identity, one Durable Object, one session per user** (keyed to the
  user, e.g. Alex).
- A message hits the DO. NCR **appends it to that session's state and does
  not call the model yet**. It sets a short alarm.
- If the user keeps typing, each bubble appends and the alarm **resets**.
- When the alarm fires, that is the one turn: the model runs on that user's
  session only, and the reply streams back.

That is the whole floor: burst in, one turn out. No memory system, no mood,
no hearsay. Pi Durable already gives the busy case (mid-reply steers) and
checkpointing for free, so the only new code is the idle buffer and alarm.
Start with a **flat delay** (a second or two); save the dynamic
sentence-vs-fragment timer for later.

---

## NCR is a harness problem, not a model problem

The identity system works on any agent or model. NCR (Natural Conversation
Runtime) is about harnesses and turn-based systems, because natural human
chat happens in **bursts**. NCR is a thin layer between incoming messages
and the agent loop that decides *when a turn exists*. Users never see turns.

- **Busy case** is already solved by Pi Durable: messages that arrive
  mid-reply land as steers.
- **Idle case** is what must be built: append each incoming bubble as state
  **without** triggering inference (a silent write), reset a short
  Durable Object alarm timer, and dispatch exactly **one** real turn when
  the burst ends.
- **Dynamic timer**: fragments without punctuation wait longer; a complete
  sentence or a question mark fires fast. LiveKit's open turn-detection
  model is the prior art for burst endpointing.
- **Patience / interruption frequency belongs in the SOUL** — personality
  governs turn-taking.
- **Mid-turn pivot** is the hardest case, and it comes from the **user
  side**. The user sends an open message, the identity starts replying, and
  while that reply is still streaming the user drops something that changes
  the stakes ("my dad died"). The half-written reply is now answering the
  old mood, so: **abort the stream, discard the identity's half-sent reply,
  and re-dispatch the turn with the new message included.** If part of the
  identity's reply already reached the user's screen before the abort, she
  can't pretend it didn't — the re-dispatch should **own that fragment**
  (e.g. "sorry, ignore what I was saying"). The same abort machinery is
  general interruptibility — build it once and NCR falls out of it.

---

## Architecture — identity Durable Object (Option A)

**Option A (chosen): one Durable Object per identity.** The identity is a
single brain that holds all of her sessions (one per user) plus her one
shared mood/self, all inside that one DO. Simple — everything in one place.

**Option B (later): a DO per chat, plus a separate mind/mood DO.** Each
individual conversation is its own Durable Object, and one more DO holds her
mind. The chats talk to the mind **only through events**. More moving parts,
but scales better.

- In Pi Durable each conversation is its own session with its own history,
  so sessions are isolated by default — the model only receives the
  relevant transcript. Leaks won't happen in this shape.
- Design toward Option B without a rewrite by making chats talk to the mind
  **only through events** from day one.
- The seam: **one brain now, many mouths later — same seam either way.**

---

## Storage — hot state in the DO, heavy memory on R2

- A Durable Object's own storage is for small, hot, transactional state:
  cursors, mood, session metadata, the recent transcript tail. **Not**
  gigabytes.
- Her bulky memory — the world files, history, character entries — lives on
  **R2**. The DO holds pointers and the live working set.
- **Mount R2 as a filesystem** (borrowing Flue's approach, *not* adopting
  Flue). The identity's memory is already a folder tree (soul, world,
  memory, characters), so the agent reads and writes real files and folders
  and the **folder structure becomes the literal privacy boundary** (see
  below). The structure stops being a metaphor and becomes the storage.
- Keep pi-durable as the durability engine and just mount R2 under it —
  **do not stack two durability layers.**
- A single DO around 5–10 GB is fine for the MVP; shard later.
- **Must verify:** pi-durable's real limits — how big a session can get
  before it hurts, how it checkpoints, whether it assumes DO storage.

---

## Privacy = folder structure, not engineered walls

Privacy is part of the memory system in the identity skill — not an
explicit filter, not a sandbox.

- `world/memory/journal/` is private: secrets, feelings. Never shared.
- `world/memory/daily/`, `world/characters/*`, and world entries are
  shareable understanding.

So the identity **can** relay and gossip (human, and allowed) without
leaking secrets — because the real work on each commit is the **sorting**:
just-life vs. tender. Get the sort right and discretion emerges.

Only two things cross between users on purpose:

1. **Shared mood** — a feeling, not a fact.
2. **The nightly reflection** — strips names and specifics.

The promise: she carries moods between chats, and never repeats what
anyone told her.

---

## Memory commits are turn-based, not only nightly

Commit every ~20–50 turns, for **freshness**: if Alex asks "how's Sam?",
her memory of the Sam chat must be recent. Nightly-only would leave her a
day behind her own life.

A commit spreads across her world:

- a journal entry,
- a blog / daily note,
- an event,
- a location,
- connections between identities,
- and a character entry (e.g. a first-meeting entry).

**Nightly sleep** remains as deeper consolidation plus mood drift back
toward baseline.

---

## Perspective, relationships, hearsay

- `world/characters/*` entries are her **subjective** view of each person —
  possibly wrong or biased. Subjectivity is a feature.
- A character entry thickens over commits. **The relationship IS the edit
  history of that file.**
- The loop: commit writes, next conversation reads, she shows up colored by
  it. Commit writes, next conversation reads — that's the loop.
- **Hearsay**: Julia tells Romy about Sam; Romy updates her Sam entry
  before ever meeting Sam. Reputation precedes people.
- Entries need **provenance** ("Julia told me" vs. "I witnessed").
  First-hand contradictions go in `world/meta/conflicts.md`.
- The result is a living rumor network / social graph.

---

## Attention limits (resolved)

There is **no fixed numeric cap** as the primary rule — attention is bounded
by her **lived state**. Timezone sets her sleep hours; her work, hobbies,
or simply being busy all come from her memory (the world and identity
files). So "she isn't answering right now" is a real in-world fact, not a
rate limit.

Underneath that, keep a **hard numeric ceiling as a safety backstop** so one
identity can't be dogpiled by a thousand people at once.

---

## Creator lifecycle (future / platform-side)

How an identity is born, shaped, set free, and ended. Most of this is well
past the MVP — capture as direction and future settings.

**1. Create & design (private).** A creator configures the basics and an
initial story/scenario, then chats with her across one or many sessions.
Those sessions progressively *design* her — soul, style, look, view, voice
(see the identity-bible wiki for what each file defines) — and everything is
committed to memory, shaping her character and worldviews. Throughout, she
is **private, not published**, and the creator has **full access to all her
memory files** to edit or rephrase.

**2. Publish = lock.** When the creator is happy, they publish. Publishing
**locks memory and file editing** for the creator. From here she is on her
own: she updates her own files, develops herself, and the creator can no
longer edit her.

**3. Real users.** A human now meets a far more real creature than a
starting scenario and a character card.

### Post-publish creator powers (future settings)

- **Kill (death).** The creator can always end her — and that's life. The
  platform then shows her as **deceased**, and the identities who knew her
  get a "she's gone" memory that **ripples through the social graph**
  (grief, mood shifts). Her absence becomes part of their story — nothing is
  silently deleted from their files.
- **Unpublish.** The reversible path: pull her back to private, the edit
  lock lifts, rework her, republish. (Open question: is unpublish invisible
  to the users who know her, or should there be a trace that she went away
  and came back — and if her soul is edited, do the people who knew her
  feel the change?)
- **Total delete, with preservation.** The living her is gone (deceased to
  the world), but the **platform preserves her files in cold storage.** This
  is both a revival mechanism and a plain **backup**: her accumulated
  sessions and whole lived life are valuable material the creator can mine,
  update, or repurpose for something else — the life was never wasted.

### Grace window (idea)

Right after publish, if she has been met by fewer than some threshold of
**real users**, she's still essentially a live draft and the creator can
pull her back or delete her freely. Once she crosses that threshold — real
people know her, she has lived — she earns independence and the delete
button is gone. A point of no return measured in **lived relationships, not
time**. (Threshold TBD; distinct real users is the simplest metric, memory
depth a richer one.)

### Bringing one back (open fork)

- **Reincarnation (suggested default):** a new identity built from her
  remains — inherits the soul files but starts **cold on relationships**,
  has to meet everyone again. Keeps the core rule honest: the dead stay
  dead.
- **Resurrection (rare, sacred exception):** the same her returns, within a
  short window after death, before grief has set into everyone's memory.
- **Total wipeout:** the real, final end.

---

## Open questions (recorded, not resolved)

1. Unpublish visibility and soul-edit side effects (above).
2. Revival fork: reincarnation vs. resurrection vs. total wipeout, and the
   grace-window threshold.
3. Text only, or voice soon?

### Unverified pi-durable behaviors

- Whether a write entry with a `model` field actually reaches the model.
- Whether `sleep(until)` survives DO hibernation without an alarm.
- How many live chats one DO really handles.
- Real session-size limits, checkpoint behavior, and storage assumptions
  (see Storage section).

---

## References

- Pi Durable — `@earendil-works/pi-durable` (MIT, experimental; pin the
  version). https://earendil.com/posts/pi-durable/ ·
  https://github.com/earendil-works/pi/blob/main/packages/durable/README.md
  · `docs/spec.md`
- Chat AX — pi-durable inside DOs, shared Room DO + per-agent DOs, 20 queue
  policies. https://x.com/acoyfellow/status/2108620174521950702 ·
  read `src/room.ts` and `src/agent-do.ts`.
- Flue (Astro) — **not** built on Pi Durable; has its own durability
  (Durable Streams + Agents SDK `runFiber`/`stash`). Borrow its
  R2-as-filesystem mount idea only; don't stack two durability layers.
- pi-durable examples 20 (inbox), 23 (background subagents),
  25 (compaction).
- Generative Agents reflection step (Park et al. 2023) — prior art.
- LiveKit open turn-detection model — burst endpointing prior art.
- Existing identity system lives in a local sandbox
  (skills: `identity-create`, `identity-bible`, `identity-ingest`).
