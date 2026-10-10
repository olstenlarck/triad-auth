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
- **Mid-turn pivot** is the hardest case: if stakes change mid-reply
  ("my dad died"), abort the stream, drop the half-written reply,
  re-dispatch, and own the fragment already sent. The same abort machinery
  is general interruptibility — build it once and NCR falls out of it.

---

## Architecture — identity Durable Object (Option A)

One DO per identity = one brain holding many private sessions plus one
shared "heart" (mood / self).

- In Pi Durable each conversation is its own session with its own history,
  so sessions are isolated by default — the model only receives the
  relevant transcript. Leaks won't happen in this shape.
- Design toward **Option B** (per-chat DO + separate mind DO) without a
  rewrite, by making chats talk to the mind **only through events** from
  day one.
- The seam: **one brain now, many mouths later — same seam either way.**

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

## Open questions (recorded, not resolved)

1. A hard cap on simultaneous live chats per identity, or unbounded —
   with limited attention as a world rule (sleep hours per timezone, busy
   state, leave-on-read)?
2. Can a creator edit a soul after the identity has lived, or does it own
   itself?
3. Text only, or voice soon?

### Unverified pi-durable behaviors

- Whether a write entry with a `model` field actually reaches the model.
- Whether `sleep(until)` survives DO hibernation without an alarm.
- How many live chats one DO really handles.

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
  (Durable Streams + Agents SDK `runFiber`/`stash`). Don't stack two
  durability layers.
- pi-durable examples 20 (inbox), 23 (background subagents),
  25 (compaction).
- Generative Agents reflection step (Park et al. 2023) — prior art.
- LiveKit open turn-detection model — burst endpointing prior art.
- Existing identity system on disk: `/home/arcka/opencode-sandbox/`
  (skills: `identity-create`, `identity-bible`, `identity-ingest`).
