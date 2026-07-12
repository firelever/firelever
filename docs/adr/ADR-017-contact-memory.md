# ADR-017: Contact memory — exact entity recall, not vector association

**Status:** Accepted (2026-07-12)

## Context

Live test, July 12: the user gave Levi Dana's address (metapetey@gmail.com),
spelled out and confirmed, for an email. Two turns later, dictating a calendar
invite, he said "metapd@gmail.com" (misspoken or misheard) — and Levi accepted
it without noticing it had just confirmed a different address for the same
person. The correction then dead-ended because update_event had no way to
change an event's guest list.

The user proposed a vector database over chat history so Levi forms
"neuro-associations." That instinct is half right.

## Decision

**Exact identifiers get exact memory.** `tenant_contacts` (person → confirmed
email, upserted the moment the user actually uses an address: a sent compose,
a calendar invite, a guest-list fix). Vector similarity is explicitly the
wrong tool here: "metapd" and "metapetey" embed nearly identically, so a
semantic lookup would *confirm* the wrong address rather than catch it.

- Actions that carry an address (`compose_email`, `add_event`/`update_event`
  invites) also carry `contact_name`; on success the pair is persisted.
- A CONTACTS block rides in every voice prompt: Levi proposes the known
  address instead of asking again.
- Server-side conflict check: a dictated address that differs from the one on
  file for that person returns a question ("I have Dana at metapetey…, you
  said metapd… — which one?") instead of executing. Deterministic, exact,
  cannot be talked out of it by a confident model.

**The address gate (amendment, same day).** Voice cannot distinguish "metapd"
from "metapetey", so no first-time address is used on faith: any dictated
address not already on a contact makes the server spell it back letter by
letter ("m, e, t, a, p, d, at gmail dot com — did I get every letter right?")
and act only when the user confirms and the model re-tags the same address
(short-lived pending slot; a corrected spelling starts a fresh round). Applies
to compose, invites, guest-list changes, and forwards. Once confirmed, the
address becomes a contact and is never re-interrogated.

**Guest lists are editable.** `update_event` accepts `invite` (replaces
attendees, `sendUpdates=all` notifies added and removed alike), closing the
dead end where a wrong invite couldn't be fixed by voice.

**Conversation history becomes durable** (`voice_turns`, logged per turn with
at-least-once dedupe). This is the substrate for the semantic layer the user
asked about: embedding past conversations into the existing vector store
(embeddings + FTS + vec0 already run for documents) so "what did we decide
about Midwest Freight?" retrieves by meaning. Deferred: retrieval mixing needs
source-typing so conversation recall never contaminates document answers.

## Consequences

- The metapd/metapetey class of error is now structurally caught at the
  server, not left to model attention.
- Contacts only record what the user actually confirmed by using it — the
  same ground-truth discipline as ADR-015/016.
- The right split going forward: exact stores for identifiers (contacts,
  memories), vector recall for meaning (documents today, conversations next).
