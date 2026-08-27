# CLAUDE.md — working agreement for ProjectTracker

A portfolio and project tracker over MariaDB, built to the shape of the tracker
in the SeedFall repository and to the design canvas attached to the brief.

Read `README.md` first, then `context-map.md`. This file is the rules.

---

## 0. Read first, every session

1. This file.
2. `context-map.md` — where everything lives, and which layer owns what. Check it
   before searching blind.
3. `docs/decisions/` — the five decisions that would otherwise be re-derived.
   `0002` (the progress model) is the one that touches the most code.
4. `docs/features.md` — the brief's feature list mapped to code, with every gap
   named. **Read this before claiming something works.**

---

## 1. The rules that are load-bearing

These exist because breaking one makes the product lie, which is worse than
making it fail.

### A percentage is computed in exactly one place

`src/domain/rollup.js`. The web app, the CLI and the MCP server all call it.
Anything that computes its own percentage is a second progress model, and the two
will disagree in front of somebody who has to decide which to believe.

### Weighted readiness is not completion

Readiness is a weighted sum. Completion is three separate counts. They are always
shown together and never folded into one number. The SeedFall tracker added
*done* and *in build* together and called the total "built", which reported a
milestone as 49/49 with four features unfinished.

### Excluded is not zero

A status with a NULL progress weight leaves the denominator. Scoring it zero
makes the figure gameable in both directions. When you write about it, say the
word "excluded" — a blank cell and a `0` look similar in a table and mean
opposite things.

### A parent never counts its children

Story points and estimates are summed over leaf work only. Otherwise velocity
drifts upward the more structure a project grows.

### Rust is reserved

`--blocked` is for things that need a decision. Nothing decorative may use it, so
a rust pixel anywhere in the product means something is waiting on a person. If
you need a fourth colour for something that is merely late, use amber.

### The URL is the state

Route, project, filter text, board mode, wiki document, open drawer — all in the
hash. Nothing that a person might want to come back to is held in a variable the
URL does not also carry. That is what makes a filtered list shareable, the back
button work through a drawer, and a bug reproducible from a screenshot.

### No `innerHTML`

`public/lib/dom.js` sets text through `textContent` and attributes through
`setAttribute`. There is no HTML-string path, which is why a work package subject
containing a script tag is text in all sixteen views without anybody having to
remember to escape it. The markdown renderer builds nodes for the same reason.

### An unknown filter throws

`src/domain/query.js` refuses a filter key that is not in `FILTERS`. Silently
ignoring one returns more than the caller asked for, and on a shared link that is
a disclosure.

### Internal comments are filtered in the SQL

Not in a wrapper, not in the renderer. A UI filter is a filter an API call goes
around. Every read path — the drawer, the share, every MCP tool — excludes them
in the query.

### No credential in the database

A repository or integration records the **name** of the environment variable its
token is read from. A database dump carries no secret. Do not add a column that
holds one.

### The activity trail is written in the same transaction as the change

A change with no trail is a change nobody can explain. An automation and the MCP
write tools go through the same function with `actorLabel` instead of `actorId`,
so an automated change is never indistinguishable from a human one. *Instead of*
is enforced in `notify.record`, not at the call sites: a label always nulls the
id, because a call site that forgets is a call site that lies.

### An MCP write runs as the person who issued the token

A token is not a person and every permission here is answered per person, so a
write borrows its issuer's authority and can do no more than they can — and
calls the same functions in `src/api/mutations*.js` that the web app calls, so
the status workflow and the rest are not reimplemented behind them.
`docs/decisions/0006`.

### A pull mirrors, it does not decide

`src/gitdeck/pull.js` writes what the forge says and changes no work package's
status until a repository is configured to — every status rule ships NULL. When
one is set the move still goes through `mutations.updateWorkPackage`, so
`status_transitions` refuses an illegal one exactly as it would refuse a person's,
and the trail records `gitdeck` instead of whoever ran the pull.

### A link says why it exists, and a person outranks the matcher

Every row in `work_package_git_links` carries `origin`, `matched_key` and
`matched_in`, and no screen paints a link a regex made the same as one a person
made. A key in a title or a branch is a claim; a key in a body is a mention until
a closing verb claims it. A link somebody removed keeps its row and is never
re-made by a pull — an integration that overturns a decision every quarter of an
hour is one nobody leaves switched on. A key that matches nothing is kept in
`git_unmatched_keys`, not dropped.

### An unsigned webhook delivery is never accepted

The URL in `POST /api/hooks/git/:id` is not a secret, so the signature is the
whole of the security. A repository with no `hook_secret_env` has no open
endpoint; the HMAC is computed over the raw bytes before anything is parsed and
compared in constant time; and every delivery — including every refusal, with its
reason — keeps a row in `git_hook_deliveries`. A delivery moves a status only
where the repository names somebody for it to act as, and then only as far as
that person and the status workflow allow. `docs/decisions/0009`.

### A pull and a webhook write through one path

`src/gitdeck/mirror.js`. Hearing by asking and hearing by being told are
different; writing it down two ways is how the two come to disagree about what a
link means. A new way of hearing from a forge goes through `mirror.match` and
`mirror.write`, or it is a second writer.

### A health score is not readiness

`src/domain/gitdeck.js` computes repository health, CI success and mapping
coverage. None of them is progress, none enters a denominator in `rollup.js`, and
every surface that shows one says which is which. This is the same mistake as the
SeedFall *built* figure, one layer out.

### Automations fire after the commit, never inside it

One that ran inside would see uncommitted state; one that failed would roll back
the change that triggered it. And an automation never triggers an automation —
`dispatch` takes a depth and refuses to recurse.

---

## 2. Safety rules

- **Never delete without asking.** That includes rows: a revoked share, a
  rejected email, a superseded summary and a skipped automation run all keep
  their row on purpose.
- **`npm test` runs against a throwaway database.** Keep it that way. The
  connection pool is repointed before the first query, and the last check
  fingerprints the configured schema before and after. If you add a check that
  needs the real database, you have added the bug this suite was written to
  prevent.
- **`db/schema.sql` is the base, not the current shape.** Once a database exists,
  changes are numbered files in `db/migrations/`.
- **No secret in a file.** Read from the environment. `.env` is gitignored.
- **Do not commit or push unless asked.**

---

## 3. Writing

**Comments carry derivations, not descriptions.** A comment that says what the
line does is noise; a comment that says why the number is 0.35, or why this is a
copy rather than a reference, is the most valuable thing in the file. Every
non-obvious column in `db/schema.sql` has one.

**Say what is thin.** `docs/features.md` uses three words precisely — done,
partial, modelled — and names every gap. A feature list that reads
"implemented" against everything is a feature list nobody can plan from.

**In the product, prefer the sentence to the label.** `EXCLUDED FROM THE
DENOMINATOR` beats a blank cell. `BASIS: BOOKED AGAINST ESTIMATE` beats a bare
percentage. `@nobody matched anybody` beats silence.

**En-GB in code, comments and content.** US English in conversation.

No puffery — "robust", "seamless", "comprehensive". No significance inflation.
No three-part lists for rhythm.

**Reply shape for any non-trivial change:**

```
What I did       — the change, in a sentence or two.
Why this way     — only if there was a real choice.
Verified         — what was actually run, with the output.
Found along the way — unrelated problems spotted, not fixed.
Open questions   — what you need to keep going.
```

---

## 4. Code conventions

- **Match the file you are in.** Existing patterns beat preferences.
- **One runtime dependency.** `mysql2`. Adding a second needs the argument in
  `docs/decisions/0001` answered — say what it replaces and why forty lines will
  not do.
- **Every identifier reaching SQL goes through `db.ident()`**, which throws on
  anything outside `[A-Za-z0-9_]` rather than escaping it. There is no legitimate
  column in this schema that needs escaping; a name that does came from a request
  body.
- **Every value is a placeholder.** No SQL string is built by concatenating one.
- **A new column lands with its writer, its reader, its validation and a check.**
  A column that is parsed and ignored is a column that lies to whoever fills it.
- **Errors name the thing.** `you do not have "sign_gate" on this project`, not
  `forbidden`. A refusal with no reason is a refusal somebody works around.
- **A bug fix gets a check named after the mistake.** The suite already has
  several: *a row carries its raw foreign keys as well as its labels* exists
  because a missing `status_id` made every status transition fail; *the Gantt
  survives a work package with no dates* exists because it once returned a 500
  for the whole chart.
- **No literal control characters in source.** Build them from `String.fromCharCode`
  or a `\uXXXX` escape. The CLI's colour codes do this and say why.

---

## 5. Commands

```bash
node db/migrate.js [--status|--force]   # schema
node db/seed.js [--reference]           # reference data, and the demo portfolio
node db/import-state.js FILE [--dry-run]  # merge a SeedFall tracker state file
node src/cli/tracker.js deck              # repositories, health, CI, what is mapped
node src/cli/tracker.js pull [--dry-run]  # fetch a repository, re-match its keys
node src/cli/tracker.js hooks             # the webhook endpoints, and what has arrived
npm start                               # the web server
npm test                                # 356 checks, throwaway database
node src/cli/tracker.js help
node src/mcp/server.js                  # stdio
```

**Definition of done for a change:**

1. `npm test` is green.
2. If it touched a screen, it has been opened in a browser — no console errors,
   and no horizontal overflow at 390px.
3. If it touched a number, `docs/decisions/0002` still describes what the code
   does.
4. If it touched a feature the brief names, `docs/features.md` still describes it
   accurately, including the word done / partial / modelled.

---

## 6. What is deliberately not here

Named so nobody builds them thinking they were forgotten:

- **Real-time push.** Notifications are correct and immediate in the database;
  delivery waits for the next request. SSE is a small change and is not
  pretended to be there.
- **A scheduler.** The forge client is real — the git deck pulls GitHub, GitLab
  and Forgejo, and a webhook delivers what changes as it changes — but a *pull*
  only ever happens because a person pressed PULL, ran `pt pull` or called the
  `git.pull` MCP tool. That matters because a delivery missed while the server
  was down is missed for good, and reconciling is what a pull is for. Put the CLI
  in cron. Nothing polls git, SVN, XWiki or IMAP at all; those tables, displays
  and inbound endpoints are real and the fetchers are not written.
- **Character-level collaborative editing.** Presence plus a refusal to merge —
  `docs/decisions/0004` has the argument, and it is the most likely thing to
  clear the dependency bar later.
- **A designed PDF.** The PDF export is a plain paginated listing and says so in
  its own footer. Making it look designed needs a layout engine.
- **Editors for configuration currently edited as data.** Themes, automations,
  form layouts, saved views, meetings, news and forum posts are stored, validated
  and displayed, and created by insert. The model and the read surface are the
  parts that are expensive to get wrong, and they are the parts that are done.
