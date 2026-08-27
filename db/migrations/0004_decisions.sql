-- 0004 — decisions
--
-- A decision was a wiki page: a title, then prose. A page cannot say which
-- features wait on it or which other decision has to be answered first, and
-- those are the two questions people actually ask about a decision — not
-- "what does it say" but "what is stuck behind it" and "what is it stuck
-- behind". A decision becomes a record of its own, with two link tables that
-- draw both questions explicitly rather than leaving them to be re-read out
-- of prose every time somebody needs the answer.
--
-- THE WIKI KEEPS ITS ROWS. Nothing is deleted here, following the rule the
-- rest of this database already keeps. `decisions.document_id` records which
-- page a decision came out of, so a database that already has one-page-per-
-- decision documents (the shape `db/import-state.js` wrote before this
-- change) gets a `decisions` row for each of them below, pointing back at the
-- page it came from — and stops showing the same decision twice, once as a
-- page and once as a row, because the wiki index excludes a page a decision
-- points at.

CREATE TABLE decisions (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  project_id    BIGINT UNSIGNED NULL,       -- NULL: a portfolio-wide decision
  ref           VARCHAR(24) NOT NULL,       -- 'D-14' — what people call it in prose
  title         VARCHAR(250) NOT NULL,      -- the question, phrased as a question
  question      LONGTEXT NULL,              -- the full question and its context, markdown
  answer        LONGTEXT NULL,              -- what was decided. One sentence first.
  rationale     LONGTEXT NULL,              -- why, markdown. Read second, or never.
  state         ENUM('open','settled','superseded') NOT NULL DEFAULT 'open',
  owner_id      BIGINT UNSIGNED NULL,       -- who owes the answer while it is open
  due_on        DATE NULL,
  decided_by    BIGINT UNSIGNED NULL,
  decided_at    DATETIME NULL,
  superseded_by BIGINT UNSIGNED NULL,       -- a decision is replaced, never deleted
  document_id   BIGINT UNSIGNED NULL,       -- the wiki page this came out of, if any
  position      INT NOT NULL DEFAULT 0,
  created_by    BIGINT UNSIGNED NULL,
  updated_by    BIGINT UNSIGNED NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_decision_ref (project_id, ref),
  KEY ix_decision_project (project_id, state, position),
  CONSTRAINT fk_dec_project    FOREIGN KEY (project_id)    REFERENCES projects(id)  ON DELETE CASCADE,
  CONSTRAINT fk_dec_owner      FOREIGN KEY (owner_id)      REFERENCES users(id)     ON DELETE SET NULL,
  CONSTRAINT fk_dec_decider    FOREIGN KEY (decided_by)    REFERENCES users(id)     ON DELETE SET NULL,
  CONSTRAINT fk_dec_supersede  FOREIGN KEY (superseded_by) REFERENCES decisions(id) ON DELETE SET NULL,
  CONSTRAINT fk_dec_document   FOREIGN KEY (document_id)   REFERENCES documents(id) ON DELETE SET NULL,
  CONSTRAINT fk_dec_creator    FOREIGN KEY (created_by)    REFERENCES users(id)     ON DELETE SET NULL,
  CONSTRAINT fk_dec_updater    FOREIGN KEY (updated_by)    REFERENCES users(id)     ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- What waits on this decision. `relation` separates the work that CANNOT
-- proceed from the work that merely wants to know: folding the two together
-- makes an open decision look like it is blocking six things when it blocks one.
CREATE TABLE decision_work_packages (
  decision_id     BIGINT UNSIGNED NOT NULL,
  work_package_id BIGINT UNSIGNED NOT NULL,
  relation   ENUM('blocks','informs','arose_from') NOT NULL DEFAULT 'blocks',
  -- Why this link exists, the same rule the git deck runs on: a link a person
  -- made and a link a matcher made are not the same claim and are never drawn
  -- the same. 'matcher' means a 'D-14' found in the Decision ref custom field.
  origin     ENUM('person','import','matcher') NOT NULL DEFAULT 'person',
  matched_in VARCHAR(24) NULL,        -- 'custom_field' | 'description' | 'subject'
  note       VARCHAR(300) NULL,
  -- A link somebody removed keeps its row, and is never re-made by a matcher.
  removed_at DATETIME NULL,
  removed_by BIGINT UNSIGNED NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (decision_id, work_package_id),
  KEY ix_dwp_wp (work_package_id),
  CONSTRAINT fk_dwp_decision FOREIGN KEY (decision_id)     REFERENCES decisions(id)      ON DELETE CASCADE,
  CONSTRAINT fk_dwp_wp       FOREIGN KEY (work_package_id) REFERENCES work_packages(id)  ON DELETE CASCADE,
  CONSTRAINT fk_dwp_remover  FOREIGN KEY (removed_by)      REFERENCES users(id)          ON DELETE SET NULL,
  CONSTRAINT fk_dwp_creator  FOREIGN KEY (created_by)      REFERENCES users(id)          ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One decision gating another: `decision_id` cannot be settled until
-- `depends_on_id` is. Kept as an edge list rather than a parent column because
-- a decision routinely waits on two.
CREATE TABLE decision_dependencies (
  decision_id   BIGINT UNSIGNED NOT NULL,   -- cannot be settled ...
  depends_on_id BIGINT UNSIGNED NOT NULL,   -- ... until this one is
  note       VARCHAR(300) NULL,
  removed_at DATETIME NULL,
  removed_by BIGINT UNSIGNED NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (decision_id, depends_on_id),
  KEY ix_dd_depends (depends_on_id),
  CONSTRAINT fk_dd_decision FOREIGN KEY (decision_id)   REFERENCES decisions(id) ON DELETE CASCADE,
  CONSTRAINT fk_dd_depends  FOREIGN KEY (depends_on_id) REFERENCES decisions(id) ON DELETE CASCADE,
  CONSTRAINT fk_dd_remover  FOREIGN KEY (removed_by)    REFERENCES users(id)     ON DELETE SET NULL,
  CONSTRAINT fk_dd_creator  FOREIGN KEY (created_by)    REFERENCES users(id)     ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A live link is `removed_at IS NULL`. Every read filters on it.

ALTER TABLE activities
  MODIFY COLUMN kind ENUM('status','comment','gate','repo','wiki','file','mention','ai','automation','sprint','member','share','version','baseline','meeting','project','decision') NOT NULL;

-- Every wiki page shaped like one decision per page — `number` matching
-- 'D25' or 'D-25' is the shape `db/import-state.js` wrote before this change,
-- one page per decision — becomes a `decisions` row. `document_id` keeps the
-- link back, so nothing here is a guess about which page a row replaces.
--
-- STATE. The page's own `status` column held whatever the source tracker's
-- decision state was, upper-cased; 'SETTLED' becomes settled here and
-- anything else becomes open, because a page can encode 'superseded' or
-- 'carried' in prose but this migration cannot read prose. A person can move
-- a moved-in decision to 'superseded' by hand once it has a place to live.
--
-- The document itself is untouched. It is not deleted, not archived, not
-- flagged — `decisions.document_id` pointing at it is the only record that it
-- moved. The wiki index elsewhere excludes a page a decision points at, rather
-- than this migration marking the page itself.
INSERT INTO decisions (project_id, ref, title, rationale, state, document_id, position, created_by, updated_by)
SELECT
  d.project_id,
  d.number,
  d.title,
  d.body,
  IF(UPPER(d.status) = 'SETTLED', 'settled', 'open'),
  d.id,
  d.position,
  d.created_by,
  d.updated_by
FROM documents d
WHERE d.number REGEXP '^D-?[0-9]+$'
  AND NOT EXISTS (SELECT 1 FROM decisions x WHERE x.document_id = d.id);
