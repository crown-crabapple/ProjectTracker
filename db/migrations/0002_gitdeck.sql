-- 0002 — gitdeck: the forge side of the tracker
--
-- Everything here exists to answer one question in both directions:
--
--   given a work package, what is happening to it in the repository
--   given a pull request, which work package is it
--
-- WHY A SECOND TABLE FOR ITEMS AND NOT A WIDER `repository_revisions`.
-- A revision is a commit: it is immutable, it has one identifier, and the row
-- never changes after it is written. A pull request has a state that moves
-- (open, draft, merged), a head branch that can be force-pushed, and a body that
-- is edited — it is a mirror of something still alive, and mirroring it into a
-- table whose rows are supposed to be final would make "when did this change"
-- unanswerable. `git_items` carries the living objects, `repository_revisions`
-- keeps the commits it already had, and neither is asked to be the other.
--
-- NO CREDENTIAL LANDS HERE EITHER. A repository already records the NAME of the
-- environment variable its token is read from; nothing below adds a column that
-- could hold a token, and the puller reads `process.env[token_env]` per call.

-- ------------------------------------------------------------ the repositories

ALTER TABLE repositories
  -- Forgejo/Gitea speaks its own API and gitdeck supports it, so the vocabulary
  -- gains it rather than filing a Forgejo host under 'git' and losing the fact.
  MODIFY COLUMN scm ENUM('git','svn','github','gitlab','forgejo') NOT NULL,
  -- owner/name as the forge knows it. Derived from the URL when it can be, and
  -- stored rather than re-derived on every call: a self-hosted URL behind a path
  -- prefix cannot be parsed reliably, and one wrong guess is a 404 per pull.
  ADD COLUMN slug VARCHAR(190) NULL AFTER url,
  -- NULL means the public host for that scm. Set it for self-hosted Forgejo,
  -- GitLab or GitHub Enterprise.
  ADD COLUMN api_base VARCHAR(300) NULL AFTER slug,
  ADD COLUMN pull_state ENUM('never','ok','error') NOT NULL DEFAULT 'never' AFTER last_synced_at,
  ADD COLUMN pull_detail VARCHAR(300) NULL AFTER pull_state;

-- ------------------------------------------------- the key a forge can carry

-- The tracker's own key is `WP-124` and is derived from the id, so it cannot be
-- chosen. A repository's history usually names work by a key that came from
-- somewhere else — a SeedFall feature id like F-LOAD-012, a Jira key, whatever
-- the branch names have said for two years. `ref_key` is that name, and it is
-- what a branch, a pull request title or a commit trailer is matched against.
--
-- Unique per project rather than globally: two projects legitimately both have
-- an F-LOAD-012, and forcing a portfolio-wide namespace would mean renaming
-- somebody's history to import it.
ALTER TABLE work_packages
  ADD COLUMN ref_key VARCHAR(48) NULL AFTER wp_key,
  ADD UNIQUE KEY uq_wp_ref (project_id, ref_key);

-- --------------------------------------------- what each type maps to by default

-- The brief's six types each mean something different in a repository, and the
-- default mapping is here rather than in code so that changing it is an
-- administration action. `db/seed-reference.js` carries the same six defaults
-- for a database that has not been seeded yet; the UPDATEs below are for one
-- that has, and are a no-op on a fresh install where the table is still empty.
--
-- 'none' means the type has no forge counterpart and the puller will not invent
-- one — a link found for it is recorded as 'mentions' and nothing else.
ALTER TABLE work_package_types
  ADD COLUMN git_item_kind ENUM('pull_request','issue','milestone','release','branch','none')
    NOT NULL DEFAULT 'none' AFTER subject_pattern,
  ADD COLUMN git_relation ENUM('implements','fixes','tracks','releases','mentions')
    NOT NULL DEFAULT 'mentions' AFTER git_item_kind,
  -- The letter a key of this type starts with: F-LOAD-012 is a FEATURE. NULL
  -- means this type has no key form of its own and is matched by WP- only.
  ADD COLUMN git_key_prefix VARCHAR(16) NULL AFTER git_relation;

UPDATE work_package_types SET git_item_kind = 'milestone', git_relation = 'tracks',     git_key_prefix = 'PH' WHERE name = 'PHASE';
UPDATE work_package_types SET git_item_kind = 'issue',     git_relation = 'tracks',     git_key_prefix = 'E'  WHERE name = 'EPIC';
UPDATE work_package_types SET git_item_kind = 'pull_request', git_relation = 'implements', git_key_prefix = 'F' WHERE name = 'FEATURE';
UPDATE work_package_types SET git_item_kind = 'issue',     git_relation = 'implements', git_key_prefix = 'T'  WHERE name = 'TASK';
UPDATE work_package_types SET git_item_kind = 'issue',     git_relation = 'fixes',      git_key_prefix = 'B'  WHERE name = 'BUG';
UPDATE work_package_types SET git_item_kind = 'release',   git_relation = 'releases',   git_key_prefix = 'M'  WHERE name = 'MILESTONE';

-- A repository may disagree with the default. One row per (repository, type);
-- absent means the type's own default applies.
CREATE TABLE git_type_rules (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  repository_id BIGINT UNSIGNED NOT NULL,
  type_id       BIGINT UNSIGNED NOT NULL,
  item_kind     ENUM('pull_request','issue','milestone','release','branch','none') NOT NULL,
  relation      ENUM('implements','fixes','tracks','releases','mentions') NOT NULL,
  key_prefix    VARCHAR(16) NULL,
  -- What a merge or a close in the repository does to the work package. BOTH ARE
  -- NULL BY DEFAULT AND THAT IS THE POINT: a pull mirrors, it does not decide.
  -- A repository that has earned it can name a status here, and then the move
  -- goes through the same status workflow the web app uses — an illegal
  -- transition is refused rather than forced, and the trail records the machine.
  merged_status_id BIGINT UNSIGNED NULL,
  closed_status_id BIGINT UNSIGNED NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_rule (repository_id, type_id),
  CONSTRAINT fk_rule_repo   FOREIGN KEY (repository_id)    REFERENCES repositories(id)       ON DELETE CASCADE,
  CONSTRAINT fk_rule_type   FOREIGN KEY (type_id)          REFERENCES work_package_types(id) ON DELETE CASCADE,
  CONSTRAINT fk_rule_merged FOREIGN KEY (merged_status_id) REFERENCES statuses(id)           ON DELETE SET NULL,
  CONSTRAINT fk_rule_closed FOREIGN KEY (closed_status_id) REFERENCES statuses(id)           ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------- the mirror

CREATE TABLE git_items (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  repository_id BIGINT UNSIGNED NOT NULL,
  -- Commits are NOT here. They live in repository_revisions, which already has
  -- them, already displays them and already links them to work packages.
  kind          ENUM('pull_request','issue','milestone','release','branch','workflow_run','security_alert') NOT NULL,
  -- The forge's identifier for the kind: a number for a pull request or an
  -- issue, a tag for a release, a name for a branch, a run id for a workflow
  -- run. A string because those are not all integers, and comparing '978' to
  -- 978 in three languages is a bug waiting for its Tuesday.
  ref           VARCHAR(190) NOT NULL,
  title         VARCHAR(500) NULL,
  -- The forge's word, not ours: open, closed, merged, draft, success, failure.
  -- Mapping it into the tracker's status vocabulary here would be the second
  -- progress model this codebase exists to avoid.
  state         VARCHAR(32) NOT NULL,
  author        VARCHAR(190) NULL,
  head_branch   VARCHAR(190) NULL,
  base_branch   VARCHAR(190) NULL,
  url           VARCHAR(500) NULL,
  -- Kept because the key that maps the item to a work package is as often in the
  -- body ("closes F-LOAD-012") as in the title, and re-fetching every body on
  -- every pull to re-run the matcher would be the slowest part of the pull.
  body          MEDIUMTEXT NULL,
  labels        VARCHAR(500) NULL,
  opened_at     DATETIME NULL,
  updated_at    DATETIME NULL,
  closed_at     DATETIME NULL,
  merged_at     DATETIME NULL,
  additions     INT NULL,
  deletions     INT NULL,
  comment_count INT NULL,
  duration_sec  INT NULL,            -- workflow_run only
  conclusion    VARCHAR(32) NULL,    -- workflow_run only: success, failure, cancelled
  severity      VARCHAR(32) NULL,    -- security_alert only: low … critical
  pulled_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_git_item (repository_id, kind, ref),
  KEY ix_git_item_state (repository_id, kind, state),
  KEY ix_git_item_updated (repository_id, updated_at),
  CONSTRAINT fk_git_item_repo FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------- the mapping

CREATE TABLE work_package_git_links (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  work_package_id BIGINT UNSIGNED NOT NULL,
  git_item_id     BIGINT UNSIGNED NOT NULL,
  relation        ENUM('implements','fixes','tracks','releases','mentions') NOT NULL,
  -- How this link came to exist, and it is shown: a link a person made and a
  -- link a regex made are different claims, and a page that draws them
  -- identically is a page that cannot be argued with.
  origin          ENUM('key','branch','manual') NOT NULL,
  -- The literal text that produced the match — 'F-LOAD-012', 'WP-124' — and
  -- where it was found. A link that cannot say why it exists is a link nobody
  -- will dare delete.
  matched_key     VARCHAR(48) NULL,
  matched_in      ENUM('title','body','branch','manual') NOT NULL DEFAULT 'manual',
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by      BIGINT UNSIGNED NULL,
  actor_label     VARCHAR(60) NULL,      -- 'gitdeck' when the puller made it
  -- A removed link KEEPS ITS ROW, like a revoked share and a rejected email.
  -- It also stops the puller: a link a person removed is a decision, and the
  -- next pull re-matching the same key and re-creating it would overturn that
  -- decision silently, every fifteen minutes, for ever.
  removed_at      DATETIME NULL,
  removed_by      BIGINT UNSIGNED NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_wp_git_link (work_package_id, git_item_id, relation),
  KEY ix_link_item (git_item_id),
  CONSTRAINT fk_link_wp      FOREIGN KEY (work_package_id) REFERENCES work_packages(id) ON DELETE CASCADE,
  CONSTRAINT fk_link_item    FOREIGN KEY (git_item_id)     REFERENCES git_items(id)     ON DELETE CASCADE,
  CONSTRAINT fk_link_creator FOREIGN KEY (created_by)      REFERENCES users(id)         ON DELETE SET NULL,
  CONSTRAINT fk_link_remover FOREIGN KEY (removed_by)      REFERENCES users(id)         ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A key found in the repository that matches no work package. Kept rather than
-- discarded: "the branch says F-LOAD-207 and the tracker has never heard of it"
-- is the most useful thing a pull can tell you, and a counter cannot say which
-- key it was.
CREATE TABLE git_unmatched_keys (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  repository_id BIGINT UNSIGNED NOT NULL,
  git_item_id   BIGINT UNSIGNED NULL,
  candidate     VARCHAR(48) NOT NULL,
  matched_in    ENUM('title','body','branch','manual') NOT NULL,
  first_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  seen_count    INT NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_unmatched (repository_id, candidate),
  CONSTRAINT fk_unmatched_repo FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE,
  CONSTRAINT fk_unmatched_item FOREIGN KEY (git_item_id)   REFERENCES git_items(id)    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Every pull, kept — including the ones that failed and the ones that were dry
-- runs. `automation_runs` keeps its skipped rows for the same reason: "it did
-- not run" and "it ran and did nothing" are different answers.
CREATE TABLE git_pulls (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  repository_id BIGINT UNSIGNED NOT NULL,
  started_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at   DATETIME NULL,
  actor_id      BIGINT UNSIGNED NULL,
  actor_label   VARCHAR(60) NULL,
  state         ENUM('ok','error','dry_run') NOT NULL DEFAULT 'ok',
  items_seen    INT NOT NULL DEFAULT 0,
  items_new     INT NOT NULL DEFAULT 0,
  links_made    INT NOT NULL DEFAULT 0,
  unmatched     INT NOT NULL DEFAULT 0,
  statuses_moved INT NOT NULL DEFAULT 0,
  -- What the forge said was left. A pull that stopped because the hourly budget
  -- ran out looks identical to a repository with nothing in it unless this is
  -- recorded.
  rate_remaining INT NULL,
  detail        VARCHAR(500) NULL,
  PRIMARY KEY (id),
  KEY ix_pull_repo (repository_id, started_at),
  CONSTRAINT fk_pull_repo FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE,
  CONSTRAINT fk_pull_actor FOREIGN KEY (actor_id)     REFERENCES users(id)        ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------- the MCP surface

-- Same reasoning as 0001: a tool that is not in this table is not offered, and
-- the table treats empty as "no opinion". These three are additions, so listing
-- only them is safe — a database with the twelve rows from 0001 gains three, and
-- one with an empty table still offers everything.
--
-- `git.pull` is a write because it reaches the network on the tracker's behalf
-- and can move a status; the two read tools cannot.
INSERT IGNORE INTO mcp_tools (name, mode, detail, status, position, enabled) VALUES
  ('git.links',  'read',  'What a work package maps to in the repository, and what maps back',  'done',     12, 1),
  ('git.deck',   'read',  'Pull requests, issues, CI and mapping coverage per repository',       'done',     13, 1),
  ('git.pull',   'write', 'Pull a repository now and re-match its keys to work packages',        'in_build', 14, 1);
