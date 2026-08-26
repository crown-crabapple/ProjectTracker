# 0004 — Collaborative editing shows presence and refuses to merge

**Date:** 2026-08-26
**Status:** accepted

## Context

The brief asks for "collaborative document editing". That phrase covers a range
from "two people can see each other" to "Google Docs".

## Decision

**Presence plus optimistic concurrency, and an explicit refusal to merge.**

- `document_presence` carries who is in a document, which section they claimed,
  and the revision they started from. It is a heartbeat, not a lock.
- Every save names the revision it started from. A save against a stale revision
  is **refused**, and the refusal carries the other version so the client can
  show both.
- The UI offers three moves at that point: take theirs, overwrite with mine, or
  cancel. It does not choose.

## Why not a silent merge

A three-way text merge on prose picks one author's sentence over another's and
tells neither. On a wiki page that records a decision, the sentence that
survives is the decision — so a merge that silently drops half of one is a merge
that changes what the project decided.

## Why not a lock

A lock on a document nobody is actually editing is the failure mode of every
locking wiki: somebody opens a page, goes to lunch, and the page is unavailable
for two hours with no way to tell whether that is real. Presence with a five
minute window degrades to "nobody is here" on its own.

## Why not a CRDT

A CRDT would give real concurrent editing and is the correct answer if that is
the requirement. It is also a dependency, and a large one, sitting underneath
the thing that stores the project's decisions. Decision `0001` sets the bar for
adding a dependency, and this is the most likely thing to clear it later.

## What the product claims

The rail says how many other people are live in the document. The editor says
which revision it started from and that a conflicting save will be refused
rather than merged. Neither says "collaborative editing" without qualification,
because claiming what we do not do is worse than doing less.

## Consequences

- `document_versions` keeps every revision, so an overwrite is recoverable.
- Two people typing in the same document at the same time will lose one of them
  a save. They will be told, and they will have both texts.
