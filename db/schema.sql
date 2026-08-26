-- ProjectTracker — MariaDB schema
--
-- Modelled on the tracker in the SeedFall repository, which keeps three things
-- separate and refuses to let them drift:
--
--   * scope        — what the work is (there: markdown design documents)
--   * tracking     — status, answers, notes, and an activity trail
--   * the rollup   — every number the UI shows, computed, never stored
--
-- The SeedFall tracker held tracking in a single hand-editable state.json. That
-- works for one person over six documents; it does not survive many projects,
-- many people, real-time notification, or an assistant reading the same records
-- over MCP. This schema is that state file normalised into MariaDB, with the two
-- rules it enforced carried over verbatim:
--
--   1. STATUS WEIGHTS ARE DATA, NOT CODE. `statuses.progress_weight` is the
--      whole progress model — speccing 0.35, in build 0.7, done 1. A NULL
--      weight means EXCLUDED FROM THE DENOMINATOR, which is different from a
--      weight of zero: it is what stops a project from looking better because
--      work was deferred out of it. See docs/decisions/0002.
--   2. NOTHING IS DELETED. Rejected work keeps its row and its reason, because
--      the same idea comes back every few months and the answer should not have
--      to be re-derived.
--
-- Conventions
--   * InnoDB, utf8mb4. Every FK is declared; ON DELETE is chosen per table and
--     is RESTRICT wherever losing the row would lose history.
--   * BIGINT UNSIGNED surrogate keys. Where the product shows a human key
--     (WP-124) it is a VIRTUAL generated column over the surrogate, so there is
--     exactly one source of truth for it.
--   * Hours are DECIMAL, never FLOAT — a rounding error in booked time is a
--     rounding error in somebody's invoice.
--   * Timestamps are UTC DATETIME. Dates that a person types (start, due,
--     gate met on) are DATE, because they carry no time and must not acquire
--     one by passing through a timezone.

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ============================================================ identity & access

CREATE TABLE users (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  login           VARCHAR(80)      NULL,          -- NULL for placeholders: they cannot sign in
  name            VARCHAR(160)     NOT NULL,
  email           VARCHAR(190)     NULL,
  initials        VARCHAR(4)       NOT NULL DEFAULT '??',
  colour          VARCHAR(24)      NOT NULL DEFAULT 'rgba(230,228,223,.72)',
  -- 'user'        a real account
  -- 'placeholder' holds work before a person exists: assignable, schedulable,
  --               cannot sign in. Converting one keeps every assignment and
  --               comment attached, which is why it is a kind and not a flag.
  -- 'system'      the tracker itself, and the MCP client, so an automated
  --               change is never indistinguishable from a human one.
  kind            ENUM('user','placeholder','system') NOT NULL DEFAULT 'user',
  password_hash   VARCHAR(255)     NULL,
  password_salt   VARCHAR(64)      NULL,
  is_admin        TINYINT(1)       NOT NULL DEFAULT 0,
  weekly_capacity DECIMAL(6,2)     NOT NULL DEFAULT 0,   -- declared availability, hours/week
  placeholder_for VARCHAR(190)     NULL,                 -- who this placeholder will become
  timezone        VARCHAR(64)      NOT NULL DEFAULT 'UTC',
  theme_id        BIGINT UNSIGNED  NULL,
  highlight_mode  ENUM('none','status','priority','overdue') NOT NULL DEFAULT 'status',
  start_screen    VARCHAR(32)      NOT NULL DEFAULT 'my',
  show_ai_summaries TINYINT(1)     NOT NULL DEFAULT 1,
  active          TINYINT(1)       NOT NULL DEFAULT 1,
  created_at      DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at    DATETIME         NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_login (login),
  UNIQUE KEY uq_users_email (email),
  KEY ix_users_kind (kind, active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE user_groups (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name        VARCHAR(160) NOT NULL,
  description VARCHAR(500) NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_group_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE user_group_members (
  group_id BIGINT UNSIGNED NOT NULL,
  user_id  BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (group_id, user_id),
  CONSTRAINT fk_ugm_group FOREIGN KEY (group_id) REFERENCES user_groups(id) ON DELETE CASCADE,
  CONSTRAINT fk_ugm_user  FOREIGN KEY (user_id)  REFERENCES users(id)       ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Organisations are the addressbook side of a portfolio: the client a project is
-- for, the contractor a person invoices through. Kept separate from groups
-- because a group is a permission subject and an organisation never is.
CREATE TABLE organizations (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name       VARCHAR(190) NOT NULL,
  kind       ENUM('client','vendor','partner','internal') NOT NULL DEFAULT 'internal',
  contact    VARCHAR(190) NULL,
  website    VARCHAR(255) NULL,
  notes      TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_org_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE organization_users (
  organization_id BIGINT UNSIGNED NOT NULL,
  user_id         BIGINT UNSIGNED NOT NULL,
  role_label      VARCHAR(120) NULL,
  PRIMARY KEY (organization_id, user_id),
  CONSTRAINT fk_orgu_org  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_orgu_user FOREIGN KEY (user_id)         REFERENCES users(id)         ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE permissions (
  id       BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code     VARCHAR(80)  NOT NULL,
  category VARCHAR(60)  NOT NULL,
  label    VARCHAR(190) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_perm_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE roles (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name        VARCHAR(80) NOT NULL,
  builtin     TINYINT(1) NOT NULL DEFAULT 0,   -- builtin roles cannot be deleted
  position    INT NOT NULL DEFAULT 0,
  description VARCHAR(500) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_role_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE role_permissions (
  role_id       BIGINT UNSIGNED NOT NULL,
  permission_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (role_id, permission_id),
  CONSTRAINT fk_rp_role FOREIGN KEY (role_id)       REFERENCES roles(id)       ON DELETE CASCADE,
  CONSTRAINT fk_rp_perm FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE sessions (
  token      CHAR(64) NOT NULL,
  user_id    BIGINT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  user_agent VARCHAR(255) NULL,
  PRIMARY KEY (token),
  KEY ix_sessions_user (user_id),
  KEY ix_sessions_expiry (expires_at),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ================================================= portfolio: programs, projects

CREATE TABLE programs (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code        VARCHAR(16)  NOT NULL,
  name        VARCHAR(190) NOT NULL,
  summary     VARCHAR(400) NULL,     -- the one line under the program header
  position    INT NOT NULL DEFAULT 0,
  archived    TINYINT(1) NOT NULL DEFAULT 0,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_program_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE project_templates (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code        VARCHAR(16)  NOT NULL,
  name        VARCHAR(190) NOT NULL,
  detail      VARCHAR(400) NULL,
  -- What the template copies, as authored JSON: phases[], versions[], roles[],
  -- wiki[], work_packages[]. Kept as one document rather than five join tables
  -- because a template is only ever read whole, at project-creation time, and
  -- normalising it would mean maintaining a second copy of every structure it
  -- describes.
  blueprint   JSON NOT NULL,
  archived    TINYINT(1) NOT NULL DEFAULT 0,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_template_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE themes (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name       VARCHAR(80) NOT NULL,
  -- Design tokens as {"--accent":"#e8a94b", ...}. Served to the browser as a
  -- :root block, so a theme is a data row rather than a stylesheet to deploy.
  tokens     JSON NOT NULL,
  -- The one rule the shipped theme enforces: nothing decorative may use the
  -- blocked colour, so a rust pixel anywhere in the product means a decision is
  -- waiting. Recorded here so a custom theme cannot quietly drop it.
  reserved_note VARCHAR(400) NULL,
  is_default TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_theme_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE projects (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code          VARCHAR(16)  NOT NULL,        -- VW, TRK — shown in every table
  identifier    VARCHAR(64)  NOT NULL,        -- url slug
  name          VARCHAR(190) NOT NULL,
  description   TEXT NULL,
  program_id    BIGINT UNSIGNED NULL,
  parent_id     BIGINT UNSIGNED NULL,         -- subprojects; subproject boards read this
  template_id   BIGINT UNSIGNED NULL,         -- what it was created from
  organization_id BIGINT UNSIGNED NULL,
  is_template   TINYINT(1) NOT NULL DEFAULT 0,
  -- Health is a judgement a person records, not a number the tracker derives.
  -- Deriving it was tried and rejected: every derivation made a project look
  -- healthy while its gate was blocked, because a blocked gate has no schedule
  -- signature. See docs/decisions/0003.
  health        ENUM('green','amber','rust','off') NOT NULL DEFAULT 'off',
  health_note   VARCHAR(300) NULL,
  work_week_id  BIGINT UNSIGNED NULL,
  archived      TINYINT(1) NOT NULL DEFAULT 0,
  public        TINYINT(1) NOT NULL DEFAULT 0,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_project_code (code),
  UNIQUE KEY uq_project_identifier (identifier),
  KEY ix_project_program (program_id),
  KEY ix_project_parent (parent_id),
  CONSTRAINT fk_project_program  FOREIGN KEY (program_id)  REFERENCES programs(id)          ON DELETE SET NULL,
  CONSTRAINT fk_project_parent   FOREIGN KEY (parent_id)   REFERENCES projects(id)          ON DELETE SET NULL,
  CONSTRAINT fk_project_template FOREIGN KEY (template_id) REFERENCES project_templates(id) ON DELETE SET NULL,
  CONSTRAINT fk_project_org      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The life cycle. Phases are per project rather than global, copied from the
-- template at creation, because a manuscript's phases are not a spec project's
-- and forcing one list on both is how the gate criterion becomes meaningless.
--
-- A project cannot leave a phase until its gate criterion is recorded as met.
-- That rule lives in src/domain/lifecycle.js and reads gate_met_on: a phase with
-- a criterion and no date is a phase you are still in.
CREATE TABLE project_phases (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  project_id     BIGINT UNSIGNED NOT NULL,
  position       INT NOT NULL,
  name           VARCHAR(80) NOT NULL,
  gate_name      VARCHAR(16) NOT NULL,          -- G1, G2 …
  gate_criterion VARCHAR(400) NOT NULL,
  -- 'blocked' is the one state allowed to draw in the reserved colour: it means
  -- the criterion is itself an open decision, not that the work is late.
  state          ENUM('not_entered','current','gate_met','blocked') NOT NULL DEFAULT 'not_entered',
  gate_met_on    DATE NULL,
  gate_met_by    BIGINT UNSIGNED NULL,
  gate_note      VARCHAR(500) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_phase_position (project_id, position),
  CONSTRAINT fk_phase_project FOREIGN KEY (project_id)  REFERENCES projects(id) ON DELETE CASCADE,
  CONSTRAINT fk_phase_signer  FOREIGN KEY (gate_met_by) REFERENCES users(id)    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE memberships (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  project_id BIGINT UNSIGNED NOT NULL,
  user_id    BIGINT UNSIGNED NULL,
  group_id   BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_member_user  (project_id, user_id),
  UNIQUE KEY uq_member_group (project_id, group_id),
  CONSTRAINT fk_mem_project FOREIGN KEY (project_id) REFERENCES projects(id)    ON DELETE CASCADE,
  CONSTRAINT fk_mem_user    FOREIGN KEY (user_id)    REFERENCES users(id)       ON DELETE CASCADE,
  CONSTRAINT fk_mem_group   FOREIGN KEY (group_id)   REFERENCES user_groups(id) ON DELETE CASCADE,
  -- Exactly one principal. Without this a membership row can name both a user
  -- and a group, and the permission resolver has to guess which one wins.
  CONSTRAINT ck_mem_one_principal CHECK ((user_id IS NULL) <> (group_id IS NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE membership_roles (
  membership_id BIGINT UNSIGNED NOT NULL,
  role_id       BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (membership_id, role_id),
  CONSTRAINT fk_mr_membership FOREIGN KEY (membership_id) REFERENCES memberships(id) ON DELETE CASCADE,
  CONSTRAINT fk_mr_role       FOREIGN KEY (role_id)       REFERENCES roles(id)       ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE project_favorites (
  user_id    BIGINT UNSIGNED NOT NULL,
  project_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, project_id),
  CONSTRAINT fk_fav_user    FOREIGN KEY (user_id)    REFERENCES users(id)    ON DELETE CASCADE,
  CONSTRAINT fk_fav_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A project list is a saved filter over the portfolio, shareable by link. The
-- filter is stored, never the resulting id set: a list that froze its members
-- would go stale silently, and a stale shared link is worse than no link.
CREATE TABLE project_lists (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name        VARCHAR(190) NOT NULL,
  owner_id    BIGINT UNSIGNED NOT NULL,
  filters     JSON NOT NULL,
  columns     JSON NULL,
  sort_order  VARCHAR(120) NULL,
  starred     TINYINT(1) NOT NULL DEFAULT 0,
  visibility  ENUM('private','shared','public') NOT NULL DEFAULT 'private',
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_list_owner (owner_id),
  CONSTRAINT fk_list_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE project_list_shares (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  list_id    BIGINT UNSIGNED NOT NULL,
  token      CHAR(48) NOT NULL,
  permission ENUM('view','comment') NOT NULL DEFAULT 'view',
  expires_at DATETIME NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_list_share_token (token),
  CONSTRAINT fk_ls_list    FOREIGN KEY (list_id)    REFERENCES project_lists(id) ON DELETE CASCADE,
  CONSTRAINT fk_ls_creator FOREIGN KEY (created_by) REFERENCES users(id)         ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Dashboards. project_id NULL and owner_id set is a personal "My page"; both
-- set is a project overview a person rearranged for themselves; project_id set
-- and owner_id NULL is the shared project overview everyone sees.
CREATE TABLE dashboards (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  project_id BIGINT UNSIGNED NULL,
  owner_id   BIGINT UNSIGNED NULL,
  name       VARCHAR(160) NOT NULL,
  columns    TINYINT NOT NULL DEFAULT 4,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_dash_project (project_id),
  KEY ix_dash_owner (owner_id),
  CONSTRAINT fk_dash_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CONSTRAINT fk_dash_owner   FOREIGN KEY (owner_id)   REFERENCES users(id)    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE dashboard_widgets (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  dashboard_id BIGINT UNSIGNED NOT NULL,
  kind         VARCHAR(48) NOT NULL,   -- kpi_strip, status_breakdown, versions, members, activity, availability, alerts, ai_summary, work_table
  title        VARCHAR(160) NULL,
  position     INT NOT NULL DEFAULT 0,
  span         TINYINT NOT NULL DEFAULT 1,
  config       JSON NULL,
  PRIMARY KEY (id),
  KEY ix_widget_dash (dashboard_id, position),
  CONSTRAINT fk_widget_dash FOREIGN KEY (dashboard_id) REFERENCES dashboards(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A saved view: the same object whether it is scoped to one project or to the
-- whole portfolio. project_id NULL is what makes a multi-project view a view
-- rather than a separate feature.
CREATE TABLE saved_views (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name           VARCHAR(190) NOT NULL,
  owner_id       BIGINT UNSIGNED NOT NULL,
  project_id     BIGINT UNSIGNED NULL,
  view_type      ENUM('list','gantt','board','calendar','planner','roadmap') NOT NULL DEFAULT 'list',
  filters        JSON NOT NULL,
  columns        JSON NULL,
  sort_order     VARCHAR(160) NULL,
  group_by       VARCHAR(60) NULL,
  highlight_mode ENUM('none','status','priority','overdue') NOT NULL DEFAULT 'status',
  visibility     ENUM('private','shared','public') NOT NULL DEFAULT 'private',
  starred        TINYINT(1) NOT NULL DEFAULT 0,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_view_owner (owner_id),
  KEY ix_view_project (project_id),
  CONSTRAINT fk_view_owner   FOREIGN KEY (owner_id)   REFERENCES users(id)    ON DELETE CASCADE,
  CONSTRAINT fk_view_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ====================================== work packages: types, statuses, schedule

CREATE TABLE work_package_types (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name         VARCHAR(48) NOT NULL,          -- PHASE, EPIC, FEATURE, TASK, BUG, MILESTONE
  colour       VARCHAR(24) NOT NULL DEFAULT 'rgba(230,228,223,.4)',
  is_milestone TINYINT(1) NOT NULL DEFAULT 0, -- a milestone has one pinned date
  is_parent_ok TINYINT(1) NOT NULL DEFAULT 1, -- may hold children
  -- Automatic subject generation. A pattern over the type's own attributes,
  -- e.g. '{{type}} — {{custom.Domain}} {{version}}'. NULL means the subject is
  -- always typed by hand, which is the default: a generated subject that nobody
  -- can override is worse than no generation.
  subject_pattern VARCHAR(255) NULL,
  position     INT NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_type_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The status workflow. `progress_weight` is the entire progress model and is a
-- column rather than a constant so that adding a status is an administration
-- action rather than a deploy.
--
--   NULL          excluded from the denominator (deferred, rejected)
--   0.00 … 1.00   its share of "finished"
--
-- Excluded is not zero. A project with ten features, five done and five
-- deferred, reads 100% on five scored items — which is the honest number,
-- because the deferred five are no longer work this project claims to be doing.
-- Scoring them zero would read 50% and imply five items still to build.
CREATE TABLE statuses (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code            VARCHAR(32) NOT NULL,       -- not_started, speccing, in_build, done, deferred, rejected
  label           VARCHAR(48) NOT NULL,
  colour          VARCHAR(24) NOT NULL,
  is_closed       TINYINT(1) NOT NULL DEFAULT 0,
  is_default      TINYINT(1) NOT NULL DEFAULT 0,
  progress_weight DECIMAL(3,2) NULL,
  position        INT NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_status_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Which moves are legal. role_id NULL means "any role that may edit the work
-- package"; a row naming a role restricts that transition to it, which is how a
-- gate stays the owner's to sign.
CREATE TABLE status_transitions (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  from_status_id BIGINT UNSIGNED NOT NULL,
  to_status_id   BIGINT UNSIGNED NOT NULL,
  role_id        BIGINT UNSIGNED NULL,
  type_id        BIGINT UNSIGNED NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_transition (from_status_id, to_status_id, role_id, type_id),
  CONSTRAINT fk_tr_from FOREIGN KEY (from_status_id) REFERENCES statuses(id)           ON DELETE CASCADE,
  CONSTRAINT fk_tr_to   FOREIGN KEY (to_status_id)   REFERENCES statuses(id)           ON DELETE CASCADE,
  CONSTRAINT fk_tr_role FOREIGN KEY (role_id)        REFERENCES roles(id)              ON DELETE CASCADE,
  CONSTRAINT fk_tr_type FOREIGN KEY (type_id)        REFERENCES work_package_types(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE priorities (
  id       BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code     VARCHAR(24) NOT NULL,
  label    VARCHAR(32) NOT NULL,
  colour   VARCHAR(24) NOT NULL,
  position INT NOT NULL DEFAULT 0,
  is_default TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_priority_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A work week is scheduling arithmetic, not visibility. Weekends are shaded on
-- the calendar, never hidden: the week definition decides how many days a
-- fourteen-hour estimate spans, not what a person is allowed to look at.
CREATE TABLE work_weeks (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name          VARCHAR(80) NOT NULL,
  monday        TINYINT(1) NOT NULL DEFAULT 1,
  tuesday       TINYINT(1) NOT NULL DEFAULT 1,
  wednesday     TINYINT(1) NOT NULL DEFAULT 1,
  thursday      TINYINT(1) NOT NULL DEFAULT 1,
  friday        TINYINT(1) NOT NULL DEFAULT 1,
  saturday      TINYINT(1) NOT NULL DEFAULT 0,
  sunday        TINYINT(1) NOT NULL DEFAULT 0,
  hours_per_day DECIMAL(4,2) NOT NULL DEFAULT 8.00,
  is_default    TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_workweek_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE non_working_days (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  work_week_id BIGINT UNSIGNED NULL,     -- NULL: applies to every week definition
  day          DATE NOT NULL,
  name         VARCHAR(120) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_nwd (work_week_id, day),
  CONSTRAINT fk_nwd_week FOREIGN KEY (work_week_id) REFERENCES work_weeks(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE versions (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  project_id  BIGINT UNSIGNED NOT NULL,
  code        VARCHAR(32) NOT NULL,
  name        VARCHAR(190) NOT NULL,
  description VARCHAR(500) NULL,
  start_date  DATE NULL,
  due_date    DATE NULL,             -- NULL is UNSCHEDULED, and says so on the roadmap
  state       ENUM('open','locked','closed') NOT NULL DEFAULT 'open',
  -- Version sharing, the same vocabulary the roadmap needs to draw one timeline
  -- across a portfolio without duplicating rows per project.
  sharing     ENUM('none','descendants','hierarchy','tree','system') NOT NULL DEFAULT 'none',
  position    INT NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_version_code (project_id, code),
  KEY ix_version_due (due_date),
  CONSTRAINT fk_version_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Sprints. project_id NULL with sharing='system' is a sprint several projects
-- draw from at once — the SAFe case. A shared sprint counts its points in every
-- project that draws from it but only once in velocity, which is why the
-- membership is an explicit table and not a column.
CREATE TABLE sprints (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code       VARCHAR(24) NOT NULL,
  name       VARCHAR(120) NOT NULL,
  project_id BIGINT UNSIGNED NULL,
  start_date DATE NOT NULL,
  end_date   DATE NOT NULL,
  state      ENUM('planned','active','closed') NOT NULL DEFAULT 'planned',
  sharing    ENUM('project','program','system') NOT NULL DEFAULT 'project',
  goal       VARCHAR(400) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_sprint_code (code),
  KEY ix_sprint_dates (start_date, end_date),
  CONSTRAINT fk_sprint_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE sprint_projects (
  sprint_id  BIGINT UNSIGNED NOT NULL,
  project_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (sprint_id, project_id),
  CONSTRAINT fk_sp_sprint  FOREIGN KEY (sprint_id)  REFERENCES sprints(id)  ON DELETE CASCADE,
  CONSTRAINT fk_sp_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE work_packages (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  -- The human key. VIRTUAL, so WP-124 cannot drift from id 124 and there is
  -- nothing to keep in step when a row is inserted.
  wp_key         VARCHAR(24) AS (CONCAT('WP-', id)) VIRTUAL,
  project_id     BIGINT UNSIGNED NOT NULL,
  type_id        BIGINT UNSIGNED NOT NULL,
  subject        VARCHAR(400) NOT NULL,
  description    MEDIUMTEXT NULL,
  parent_id      BIGINT UNSIGNED NULL,
  status_id      BIGINT UNSIGNED NOT NULL,
  priority_id    BIGINT UNSIGNED NOT NULL,
  -- The three roles, kept apart on purpose. Assignee does the work,
  -- accountable answers for it, watchers are told about it. Collapsing any two
  -- of them loses the question "who do I chase".
  assignee_id    BIGINT UNSIGNED NULL,
  accountable_id BIGINT UNSIGNED NULL,
  author_id      BIGINT UNSIGNED NULL,
  start_date     DATE NULL,
  due_date       DATE NULL,
  -- 'automatic' derives the dates from the children and the relations;
  -- 'manual' pins them. A child cannot leave the dates of an automatic parent;
  -- against a manual parent it can, and that is the only way to plan a slip
  -- without rewriting the parent.
  scheduling     ENUM('automatic','manual') NOT NULL DEFAULT 'automatic',
  estimated_hours DECIMAL(8,2) NOT NULL DEFAULT 0,
  remaining_hours DECIMAL(8,2) NULL,
  story_points   INT NULL,                 -- NULL means not estimated, which is not zero
  version_id     BIGINT UNSIGNED NULL,
  sprint_id      BIGINT UNSIGNED NULL,
  -- Ordering. Two positions because a card's place on a board and its place in
  -- the product backlog are different facts that move independently.
  board_position   INT NOT NULL DEFAULT 0,
  backlog_position INT NOT NULL DEFAULT 0,
  closed_at      DATETIME NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_wp_project (project_id, status_id),
  KEY ix_wp_parent (parent_id),
  KEY ix_wp_assignee (assignee_id),
  KEY ix_wp_accountable (accountable_id),
  KEY ix_wp_sprint (sprint_id),
  KEY ix_wp_version (version_id),
  KEY ix_wp_due (due_date),
  CONSTRAINT fk_wp_project     FOREIGN KEY (project_id)     REFERENCES projects(id)           ON DELETE CASCADE,
  CONSTRAINT fk_wp_type        FOREIGN KEY (type_id)        REFERENCES work_package_types(id) ON DELETE RESTRICT,
  CONSTRAINT fk_wp_parent      FOREIGN KEY (parent_id)      REFERENCES work_packages(id)      ON DELETE SET NULL,
  CONSTRAINT fk_wp_status      FOREIGN KEY (status_id)      REFERENCES statuses(id)           ON DELETE RESTRICT,
  CONSTRAINT fk_wp_priority    FOREIGN KEY (priority_id)    REFERENCES priorities(id)         ON DELETE RESTRICT,
  CONSTRAINT fk_wp_assignee    FOREIGN KEY (assignee_id)    REFERENCES users(id)              ON DELETE SET NULL,
  CONSTRAINT fk_wp_accountable FOREIGN KEY (accountable_id) REFERENCES users(id)              ON DELETE SET NULL,
  CONSTRAINT fk_wp_author      FOREIGN KEY (author_id)      REFERENCES users(id)              ON DELETE SET NULL,
  CONSTRAINT fk_wp_version     FOREIGN KEY (version_id)     REFERENCES versions(id)           ON DELETE SET NULL,
  CONSTRAINT fk_wp_sprint      FOREIGN KEY (sprint_id)      REFERENCES sprints(id)            ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE work_package_watchers (
  work_package_id BIGINT UNSIGNED NOT NULL,
  user_id         BIGINT UNSIGNED NOT NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (work_package_id, user_id),
  CONSTRAINT fk_watch_wp   FOREIGN KEY (work_package_id) REFERENCES work_packages(id) ON DELETE CASCADE,
  CONSTRAINT fk_watch_user FOREIGN KEY (user_id)         REFERENCES users(id)         ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Relations. Stored one-way with a canonical kind; the inverse is derived on
-- read (follows ⇄ precedes, blocks ⇄ blocked). Storing both directions was the
-- first draft and it let the pair disagree.
CREATE TABLE work_package_relations (
  id        BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  from_id   BIGINT UNSIGNED NOT NULL,
  to_id     BIGINT UNSIGNED NOT NULL,
  kind      ENUM('follows','blocks','relates','duplicates','includes','requires') NOT NULL,
  lag_days  INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_relation (from_id, to_id, kind),
  KEY ix_rel_to (to_id),
  CONSTRAINT fk_rel_from FOREIGN KEY (from_id) REFERENCES work_packages(id) ON DELETE CASCADE,
  CONSTRAINT fk_rel_to   FOREIGN KEY (to_id)   REFERENCES work_packages(id) ON DELETE CASCADE,
  CONSTRAINT ck_rel_not_self CHECK (from_id <> to_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A baseline is what the plan was signed off against. It is a copy, deliberately:
-- a baseline derived from history would move whenever history was corrected, and
-- then a slip could be edited away instead of accepted.
CREATE TABLE baselines (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  project_id BIGINT UNSIGNED NOT NULL,
  name       VARCHAR(160) NOT NULL,
  taken_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  taken_by   BIGINT UNSIGNED NULL,
  note       VARCHAR(500) NULL,
  is_current TINYINT(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  KEY ix_baseline_project (project_id, is_current),
  CONSTRAINT fk_base_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CONSTRAINT fk_base_taker   FOREIGN KEY (taken_by)   REFERENCES users(id)    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE baseline_entries (
  baseline_id     BIGINT UNSIGNED NOT NULL,
  work_package_id BIGINT UNSIGNED NOT NULL,
  start_date      DATE NULL,
  due_date        DATE NULL,
  status_id       BIGINT UNSIGNED NULL,
  story_points    INT NULL,
  estimated_hours DECIMAL(8,2) NULL,
  PRIMARY KEY (baseline_id, work_package_id),
  CONSTRAINT fk_be_baseline FOREIGN KEY (baseline_id)     REFERENCES baselines(id)     ON DELETE CASCADE,
  CONSTRAINT fk_be_wp       FOREIGN KEY (work_package_id) REFERENCES work_packages(id) ON DELETE CASCADE,
  CONSTRAINT fk_be_status   FOREIGN KEY (status_id)       REFERENCES statuses(id)      ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE time_entries (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  work_package_id BIGINT UNSIGNED NULL,
  project_id      BIGINT UNSIGNED NOT NULL,
  user_id         BIGINT UNSIGNED NOT NULL,
  spent_on        DATE NOT NULL,
  hours           DECIMAL(6,2) NOT NULL,
  activity        VARCHAR(80) NULL,
  comment         VARCHAR(500) NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_te_wp (work_package_id),
  KEY ix_te_user_date (user_id, spent_on),
  CONSTRAINT fk_te_wp      FOREIGN KEY (work_package_id) REFERENCES work_packages(id) ON DELETE CASCADE,
  CONSTRAINT fk_te_project FOREIGN KEY (project_id)      REFERENCES projects(id)      ON DELETE CASCADE,
  CONSTRAINT fk_te_user    FOREIGN KEY (user_id)         REFERENCES users(id)         ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Resource management. Declared capacity lives on the user; this table is what
-- has been booked against it, per ISO week. Booked and spent are different
-- contracts: booked is a plan for a week that has not happened, spent is a fact
-- about one that has, and the team planner compares the first against capacity.
CREATE TABLE resource_allocations (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id         BIGINT UNSIGNED NOT NULL,
  project_id      BIGINT UNSIGNED NULL,
  work_package_id BIGINT UNSIGNED NULL,
  week_start      DATE NOT NULL,           -- always a Monday
  hours           DECIMAL(6,2) NOT NULL,
  note            VARCHAR(300) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_alloc (user_id, week_start, work_package_id),
  KEY ix_alloc_week (week_start),
  CONSTRAINT fk_alloc_user    FOREIGN KEY (user_id)         REFERENCES users(id)         ON DELETE CASCADE,
  CONSTRAINT fk_alloc_project FOREIGN KEY (project_id)      REFERENCES projects(id)      ON DELETE CASCADE,
  CONSTRAINT fk_alloc_wp      FOREIGN KEY (work_package_id) REFERENCES work_packages(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A date alert is a standing rule, not a message. What it produced is a
-- notification row, so silencing the rule never rewrites the history of what it
-- already told you.
CREATE TABLE date_alerts (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id         BIGINT UNSIGNED NOT NULL,
  project_id      BIGINT UNSIGNED NULL,     -- NULL: every project the user can see
  rule            ENUM('due_soon','overdue','start_soon','no_dates','unassigned') NOT NULL,
  threshold_days  INT NOT NULL DEFAULT 2,
  only_watched    TINYINT(1) NOT NULL DEFAULT 0,
  only_assigned   TINYINT(1) NOT NULL DEFAULT 1,
  enabled         TINYINT(1) NOT NULL DEFAULT 1,
  last_ran_at     DATETIME NULL,
  PRIMARY KEY (id),
  KEY ix_alert_user (user_id, enabled),
  CONSTRAINT fk_alert_user    FOREIGN KEY (user_id)    REFERENCES users(id)    ON DELETE CASCADE,
  CONSTRAINT fk_alert_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================== agile: boards, cards, backlogs

CREATE TABLE boards (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  project_id BIGINT UNSIGNED NOT NULL,
  name       VARCHAR(190) NOT NULL,
  -- 'status'     one column per workflow status — add a status in administration
  --              and it appears here, which is why the columns are derived
  -- 'version'    move work between releases
  -- 'subproject' one column per project in the program; how a shared sprint is planned
  -- 'wbs'        columns are parents, cards are their children — the only board
  --              that shows hierarchy directly
  -- 'sprint'     the sprint board
  -- 'free'       columns are whatever you name them; ordering is stored
  board_type ENUM('status','version','subproject','wbs','sprint','free') NOT NULL DEFAULT 'status',
  config     JSON NULL,
  position   INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_board_project (project_id, position),
  CONSTRAINT fk_board_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Only 'free' boards need stored columns. For the derived types this table is
-- empty and the columns come from statuses / versions / projects / parents,
-- which is what stops a status board from going stale when a status is added.
CREATE TABLE board_columns (
  id        BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  board_id  BIGINT UNSIGNED NOT NULL,
  title     VARCHAR(190) NOT NULL,
  ref_kind  ENUM('status','version','project','parent','none') NOT NULL DEFAULT 'none',
  ref_id    BIGINT UNSIGNED NULL,
  wip_limit INT NULL,
  position  INT NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY ix_bcol_board (board_id, position),
  CONSTRAINT fk_bcol_board FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE board_cards (
  board_id        BIGINT UNSIGNED NOT NULL,
  column_id       BIGINT UNSIGNED NOT NULL,
  work_package_id BIGINT UNSIGNED NOT NULL,
  position        INT NOT NULL DEFAULT 0,
  PRIMARY KEY (board_id, work_package_id),
  KEY ix_bcard_col (column_id, position),
  CONSTRAINT fk_bcard_board  FOREIGN KEY (board_id)        REFERENCES boards(id)         ON DELETE CASCADE,
  CONSTRAINT fk_bcard_column FOREIGN KEY (column_id)       REFERENCES board_columns(id)  ON DELETE CASCADE,
  CONSTRAINT fk_bcard_wp     FOREIGN KEY (work_package_id) REFERENCES work_packages(id)  ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Recorded velocity for sprints that closed before this tracker existed, or
-- before the work was itemised. Live sprints are computed from closed points and
-- never read this table — a stored figure that could be computed is a figure
-- that will one day disagree with the cards.
CREATE TABLE sprint_velocity_history (
  sprint_code   VARCHAR(24) NOT NULL,
  project_id    BIGINT UNSIGNED NULL,
  closed_points INT NOT NULL,
  recorded_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  note          VARCHAR(300) NULL,
  PRIMARY KEY (sprint_code, project_id),
  CONSTRAINT fk_svh_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ==================================================== collaboration & knowledge

CREATE TABLE comments (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  container_type ENUM('work_package','document','meeting','news','forum_message','project') NOT NULL,
  container_id   BIGINT UNSIGNED NOT NULL,
  author_id      BIGINT UNSIGNED NULL,
  body           MEDIUMTEXT NOT NULL,
  -- An internal comment is not visible to readers or placeholder users. It is a
  -- column and not a separate table because a thread reads in one order and
  -- splitting it would mean merging two sequences on every render.
  internal       TINYINT(1) NOT NULL DEFAULT 0,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  edited_at      DATETIME NULL,
  PRIMARY KEY (id),
  KEY ix_comment_container (container_type, container_id, created_at),
  CONSTRAINT fk_comment_author FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE mentions (
  comment_id BIGINT UNSIGNED NOT NULL,
  user_id    BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (comment_id, user_id),
  CONSTRAINT fk_mention_comment FOREIGN KEY (comment_id) REFERENCES comments(id) ON DELETE CASCADE,
  CONSTRAINT fk_mention_user    FOREIGN KEY (user_id)    REFERENCES users(id)    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE documents (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  project_id    BIGINT UNSIGNED NULL,       -- NULL: a portfolio-wide document
  parent_id     BIGINT UNSIGNED NULL,
  number        VARCHAR(16) NULL,           -- '05' — the document's place in a numbered set
  slug          VARCHAR(120) NOT NULL,
  title         VARCHAR(250) NOT NULL,
  body          LONGTEXT NULL,              -- markdown
  status        VARCHAR(24) NOT NULL DEFAULT 'DRAFT',
  -- Cached because the wiki index shows it for every document at once and
  -- counting words in a LONGTEXT per row per page load is the wrong trade. The
  -- writer that sets body is the only thing allowed to set these, so they cannot
  -- drift from it.
  word_count    INT NOT NULL DEFAULT 0,
  section_count INT NOT NULL DEFAULT 0,
  position      INT NOT NULL DEFAULT 0,
  created_by    BIGINT UNSIGNED NULL,
  updated_by    BIGINT UNSIGNED NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_doc_slug (project_id, slug),
  KEY ix_doc_project (project_id, position),
  CONSTRAINT fk_doc_project FOREIGN KEY (project_id) REFERENCES projects(id)  ON DELETE CASCADE,
  CONSTRAINT fk_doc_parent  FOREIGN KEY (parent_id)  REFERENCES documents(id) ON DELETE SET NULL,
  CONSTRAINT fk_doc_creator FOREIGN KEY (created_by) REFERENCES users(id)     ON DELETE SET NULL,
  CONSTRAINT fk_doc_updater FOREIGN KEY (updated_by) REFERENCES users(id)     ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE document_versions (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  document_id BIGINT UNSIGNED NOT NULL,
  revision    INT NOT NULL,
  body        LONGTEXT NULL,
  author_id   BIGINT UNSIGNED NULL,
  note        VARCHAR(300) NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_docver (document_id, revision),
  CONSTRAINT fk_docver_doc    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
  CONSTRAINT fk_docver_author FOREIGN KEY (author_id)   REFERENCES users(id)     ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Collaborative editing, at the honesty level this app can actually deliver:
-- presence plus a per-section soft claim, not character-level merge. Two people
-- editing the same document see each other and see which section is claimed; a
-- conflicting save is refused with the other revision offered, never silently
-- merged. Claiming what we do not do is worse than doing less.
CREATE TABLE document_presence (
  document_id BIGINT UNSIGNED NOT NULL,
  user_id     BIGINT UNSIGNED NOT NULL,
  section     VARCHAR(120) NULL,
  base_revision INT NULL,
  last_seen   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (document_id, user_id),
  CONSTRAINT fk_pres_doc  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
  CONSTRAINT fk_pres_user FOREIGN KEY (user_id)     REFERENCES users(id)     ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE meetings (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  project_id     BIGINT UNSIGNED NULL,
  title          VARCHAR(250) NOT NULL,
  scheduled_on   DATE NOT NULL,
  start_time     TIME NULL,
  duration_min   INT NOT NULL DEFAULT 60,
  location       VARCHAR(190) NULL,
  -- An open agenda accepts items from anyone with a maintainer role. Once the
  -- meeting opens the agenda is frozen and edits go to the minutes, which is why
  -- this is a state and not a pair of booleans.
  state          ENUM('agenda','open','minutes','closed') NOT NULL DEFAULT 'agenda',
  created_by     BIGINT UNSIGNED NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_meeting_date (scheduled_on),
  CONSTRAINT fk_meeting_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CONSTRAINT fk_meeting_creator FOREIGN KEY (created_by) REFERENCES users(id)    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE meeting_participants (
  meeting_id BIGINT UNSIGNED NOT NULL,
  user_id    BIGINT UNSIGNED NOT NULL,
  invited    TINYINT(1) NOT NULL DEFAULT 1,
  attended   TINYINT(1) NULL,
  PRIMARY KEY (meeting_id, user_id),
  CONSTRAINT fk_mpart_meeting FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
  CONSTRAINT fk_mpart_user    FOREIGN KEY (user_id)    REFERENCES users(id)    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE meeting_agenda_items (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  meeting_id      BIGINT UNSIGNED NOT NULL,
  position        INT NOT NULL DEFAULT 0,
  title           VARCHAR(400) NOT NULL,
  duration_min    INT NULL,
  presenter_id    BIGINT UNSIGNED NULL,
  work_package_id BIGINT UNSIGNED NULL,
  notes           TEXT NULL,
  PRIMARY KEY (id),
  KEY ix_agenda_meeting (meeting_id, position),
  CONSTRAINT fk_agenda_meeting   FOREIGN KEY (meeting_id)      REFERENCES meetings(id)      ON DELETE CASCADE,
  CONSTRAINT fk_agenda_presenter FOREIGN KEY (presenter_id)    REFERENCES users(id)         ON DELETE SET NULL,
  CONSTRAINT fk_agenda_wp        FOREIGN KEY (work_package_id) REFERENCES work_packages(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE meeting_minutes (
  meeting_id  BIGINT UNSIGNED NOT NULL,
  body        MEDIUMTEXT NOT NULL,
  recorded_by BIGINT UNSIGNED NULL,
  recorded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (meeting_id),
  CONSTRAINT fk_min_meeting FOREIGN KEY (meeting_id)  REFERENCES meetings(id) ON DELETE CASCADE,
  CONSTRAINT fk_min_author  FOREIGN KEY (recorded_by) REFERENCES users(id)    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- An action or a carry-forward out of a meeting. carried_to names the next
-- meeting rather than closing the item, because "we did not decide" is an
-- outcome worth keeping and an unclosed action nobody named is how it is lost.
CREATE TABLE meeting_outcomes (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  meeting_id      BIGINT UNSIGNED NOT NULL,
  kind            ENUM('action','carried','decision') NOT NULL DEFAULT 'action',
  text            VARCHAR(500) NOT NULL,
  owner_id        BIGINT UNSIGNED NULL,
  work_package_id BIGINT UNSIGNED NULL,
  carried_to      BIGINT UNSIGNED NULL,
  PRIMARY KEY (id),
  KEY ix_outcome_meeting (meeting_id),
  CONSTRAINT fk_out_meeting FOREIGN KEY (meeting_id)      REFERENCES meetings(id)      ON DELETE CASCADE,
  CONSTRAINT fk_out_owner   FOREIGN KEY (owner_id)        REFERENCES users(id)         ON DELETE SET NULL,
  CONSTRAINT fk_out_wp      FOREIGN KEY (work_package_id) REFERENCES work_packages(id) ON DELETE SET NULL,
  CONSTRAINT fk_out_carried FOREIGN KEY (carried_to)      REFERENCES meetings(id)      ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE news (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  project_id BIGINT UNSIGNED NULL,
  title      VARCHAR(250) NOT NULL,
  summary    VARCHAR(500) NULL,
  body       MEDIUMTEXT NULL,
  author_id  BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_news_project (project_id, created_at),
  CONSTRAINT fk_news_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CONSTRAINT fk_news_author  FOREIGN KEY (author_id)  REFERENCES users(id)    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE forums (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  project_id  BIGINT UNSIGNED NULL,
  name        VARCHAR(190) NOT NULL,
  description VARCHAR(500) NULL,
  position    INT NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  CONSTRAINT fk_forum_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE forum_topics (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  forum_id      BIGINT UNSIGNED NOT NULL,
  subject       VARCHAR(250) NOT NULL,
  author_id     BIGINT UNSIGNED NULL,
  sticky        TINYINT(1) NOT NULL DEFAULT 0,
  locked        TINYINT(1) NOT NULL DEFAULT 0,
  reply_count   INT NOT NULL DEFAULT 0,
  last_reply_at DATETIME NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_topic_forum (forum_id, last_reply_at),
  CONSTRAINT fk_topic_forum  FOREIGN KEY (forum_id)  REFERENCES forums(id) ON DELETE CASCADE,
  CONSTRAINT fk_topic_author FOREIGN KEY (author_id) REFERENCES users(id)  ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE forum_messages (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  topic_id   BIGINT UNSIGNED NOT NULL,
  parent_id  BIGINT UNSIGNED NULL,
  author_id  BIGINT UNSIGNED NULL,
  body       MEDIUMTEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_msg_topic (topic_id, created_at),
  CONSTRAINT fk_msg_topic  FOREIGN KEY (topic_id)  REFERENCES forum_topics(id)  ON DELETE CASCADE,
  CONSTRAINT fk_msg_parent FOREIGN KEY (parent_id) REFERENCES forum_messages(id) ON DELETE CASCADE,
  CONSTRAINT fk_msg_author FOREIGN KEY (author_id) REFERENCES users(id)          ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE attachments (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  container_type ENUM('work_package','document','meeting','news','project','forum_message') NOT NULL,
  container_id   BIGINT UNSIGNED NOT NULL,
  filename       VARCHAR(255) NOT NULL,
  content_type   VARCHAR(120) NOT NULL DEFAULT 'application/octet-stream',
  byte_size      BIGINT UNSIGNED NOT NULL DEFAULT 0,
  -- sha256 of the bytes. Two identical uploads share one file on disk and keep
  -- two rows, so deleting one attachment can never take the other's bytes.
  digest         CHAR(64) NOT NULL,
  storage_path   VARCHAR(500) NOT NULL,
  description    VARCHAR(300) NULL,
  author_id      BIGINT UNSIGNED NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_att_container (container_type, container_id),
  KEY ix_att_digest (digest),
  CONSTRAINT fk_att_author FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================ sharing, notification, activity

-- Sharing a work package outside a project. A share is a capability: it names a
-- token, a permission and an expiry, and it is revoked by setting revoked_at
-- rather than by deletion, so "who could see this in September" stays answerable.
CREATE TABLE work_package_shares (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  work_package_id BIGINT UNSIGNED NOT NULL,
  token           CHAR(48) NOT NULL,
  email           VARCHAR(190) NULL,      -- who it was sent to, if anyone
  user_id         BIGINT UNSIGNED NULL,   -- set once an invitee has an account
  permission      ENUM('view','comment','edit') NOT NULL DEFAULT 'view',
  -- Internal comments are never included in a share, at any permission. This
  -- column exists so that a future "include internal" toggle has to be an
  -- explicit decision rather than an oversight in a query.
  includes_internal TINYINT(1) NOT NULL DEFAULT 0,
  expires_at      DATETIME NULL,
  created_by      BIGINT UNSIGNED NOT NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at      DATETIME NULL,
  last_viewed_at  DATETIME NULL,
  view_count      INT NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_share_token (token),
  KEY ix_share_wp (work_package_id),
  CONSTRAINT fk_share_wp      FOREIGN KEY (work_package_id) REFERENCES work_packages(id) ON DELETE CASCADE,
  CONSTRAINT fk_share_user    FOREIGN KEY (user_id)         REFERENCES users(id)         ON DELETE SET NULL,
  CONSTRAINT fk_share_creator FOREIGN KEY (created_by)      REFERENCES users(id)         ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE notifications (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id         BIGINT UNSIGNED NOT NULL,
  kind            ENUM('mention','assigned','watching','date_alert','internal','shared','gate','comment','automation') NOT NULL,
  actor_id        BIGINT UNSIGNED NULL,
  actor_label     VARCHAR(120) NULL,     -- for a non-user actor: 'github', 'MCP · seedfall'
  project_id      BIGINT UNSIGNED NULL,
  work_package_id BIGINT UNSIGNED NULL,
  title           VARCHAR(300) NOT NULL,
  detail          VARCHAR(600) NULL,
  read_at         DATETIME NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_notif_user (user_id, read_at, created_at),
  CONSTRAINT fk_notif_user  FOREIGN KEY (user_id)         REFERENCES users(id)         ON DELETE CASCADE,
  CONSTRAINT fk_notif_actor FOREIGN KEY (actor_id)        REFERENCES users(id)         ON DELETE SET NULL,
  CONSTRAINT fk_notif_proj  FOREIGN KEY (project_id)      REFERENCES projects(id)      ON DELETE CASCADE,
  CONSTRAINT fk_notif_wp    FOREIGN KEY (work_package_id) REFERENCES work_packages(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The audit trail. Every write path in the app appends here, including the
-- automations and the MCP write tool, so an automated change is never
-- indistinguishable from a human one — that is the whole reason actor_label
-- exists beside actor_id.
--
-- Nothing is deleted from this table and nothing is capped. The SeedFall tracker
-- capped its log at 400 entries, and the cost showed up the first time nine
-- routine entries pushed a real decision out of the window.
CREATE TABLE activities (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  project_id      BIGINT UNSIGNED NULL,
  work_package_id BIGINT UNSIGNED NULL,
  actor_id        BIGINT UNSIGNED NULL,
  actor_label     VARCHAR(120) NULL,
  kind            ENUM('status','comment','gate','repo','wiki','file','mention','ai','automation','sprint','member','share','version','baseline','meeting','project') NOT NULL,
  verb            VARCHAR(120) NOT NULL,
  target_label    VARCHAR(190) NULL,
  detail          VARCHAR(800) NULL,
  from_value      VARCHAR(190) NULL,
  to_value        VARCHAR(190) NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_act_created (created_at),
  KEY ix_act_project (project_id, created_at),
  KEY ix_act_wp (work_package_id, created_at),
  CONSTRAINT fk_act_project FOREIGN KEY (project_id)      REFERENCES projects(id)      ON DELETE SET NULL,
  CONSTRAINT fk_act_wp      FOREIGN KEY (work_package_id) REFERENCES work_packages(id) ON DELETE SET NULL,
  CONSTRAINT fk_act_actor   FOREIGN KEY (actor_id)        REFERENCES users(id)         ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Email to task. The raw message is kept whether or not it became a work
-- package, with the reason it did not — an intake that silently drops mail is
-- an intake nobody trusts twice.
CREATE TABLE email_intake (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  message_id      VARCHAR(255) NULL,
  from_email      VARCHAR(190) NOT NULL,
  to_email        VARCHAR(190) NOT NULL,
  subject         VARCHAR(500) NULL,
  body            MEDIUMTEXT NULL,
  received_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  state           ENUM('pending','created','commented','rejected') NOT NULL DEFAULT 'pending',
  reason          VARCHAR(300) NULL,
  project_id      BIGINT UNSIGNED NULL,
  work_package_id BIGINT UNSIGNED NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_intake_message (message_id),
  KEY ix_intake_state (state, received_at),
  CONSTRAINT fk_intake_project FOREIGN KEY (project_id)      REFERENCES projects(id)      ON DELETE SET NULL,
  CONSTRAINT fk_intake_wp      FOREIGN KEY (work_package_id) REFERENCES work_packages(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE calendar_subscriptions (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  token      CHAR(48) NOT NULL,
  user_id    BIGINT UNSIGNED NOT NULL,
  project_id BIGINT UNSIGNED NULL,      -- NULL: everything the user can see
  name       VARCHAR(160) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at DATETIME NULL,
  last_fetched_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_calsub_token (token),
  CONSTRAINT fk_calsub_user    FOREIGN KEY (user_id)    REFERENCES users(id)    ON DELETE CASCADE,
  CONSTRAINT fk_calsub_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================== repositories and integrations

CREATE TABLE repositories (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  project_id     BIGINT UNSIGNED NOT NULL,
  scm            ENUM('git','svn','github','gitlab') NOT NULL,
  name           VARCHAR(190) NOT NULL,
  url            VARCHAR(500) NOT NULL,
  default_branch VARCHAR(120) NULL,
  -- Never the token itself. This is the name of the environment variable the
  -- server reads it from, so a credential cannot arrive in a database dump.
  token_env      VARCHAR(120) NULL,
  state          ENUM('connected','off','error') NOT NULL DEFAULT 'off',
  detail         VARCHAR(300) NULL,
  last_synced_at DATETIME NULL,
  PRIMARY KEY (id),
  KEY ix_repo_project (project_id),
  CONSTRAINT fk_repo_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE repository_revisions (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  repository_id BIGINT UNSIGNED NOT NULL,
  identifier    VARCHAR(64) NOT NULL,        -- sha, or an svn revision number
  author        VARCHAR(190) NULL,
  message       TEXT NULL,
  committed_at  DATETIME NULL,
  insertions    INT NULL,
  deletions     INT NULL,
  url           VARCHAR(500) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_rev (repository_id, identifier),
  CONSTRAINT fk_rev_repo FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE revision_work_packages (
  revision_id     BIGINT UNSIGNED NOT NULL,
  work_package_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (revision_id, work_package_id),
  CONSTRAINT fk_rwp_rev FOREIGN KEY (revision_id)     REFERENCES repository_revisions(id) ON DELETE CASCADE,
  CONSTRAINT fk_rwp_wp  FOREIGN KEY (work_package_id) REFERENCES work_packages(id)        ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE integrations (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  kind        ENUM('github','gitlab','git','svn','xwiki','ical','email','mcp','webhook') NOT NULL,
  name        VARCHAR(160) NOT NULL,
  target      VARCHAR(400) NULL,
  state       ENUM('connected','off','error') NOT NULL DEFAULT 'off',
  detail      VARCHAR(300) NULL,
  config      JSON NULL,
  token_env   VARCHAR(120) NULL,          -- again: the variable name, never the value
  project_id  BIGINT UNSIGNED NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_integration_kind (kind),
  CONSTRAINT fk_integration_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================= workflow and customisation

CREATE TABLE custom_fields (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name            VARCHAR(120) NOT NULL,
  field_format    ENUM('text','long_text','int','decimal','date','bool','list','user','version') NOT NULL,
  customized_type ENUM('work_package','project','user','version','sprint') NOT NULL DEFAULT 'work_package',
  possible_values JSON NULL,
  default_value   VARCHAR(255) NULL,
  -- The help text is the field's documentation and appears as a hint wherever the
  -- attribute is shown. It is on the field rather than in a separate glossary
  -- because documentation kept anywhere else is documentation nobody opens.
  help_text       VARCHAR(600) NULL,
  is_required     TINYINT(1) NOT NULL DEFAULT 0,
  is_for_all      TINYINT(1) NOT NULL DEFAULT 1,
  is_filterable   TINYINT(1) NOT NULL DEFAULT 1,
  value_regexp    VARCHAR(255) NULL,
  min_value       INT NULL,
  max_value       INT NULL,
  position        INT NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_cf_name (customized_type, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE custom_field_projects (
  custom_field_id BIGINT UNSIGNED NOT NULL,
  project_id      BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (custom_field_id, project_id),
  CONSTRAINT fk_cfp_field   FOREIGN KEY (custom_field_id) REFERENCES custom_fields(id) ON DELETE CASCADE,
  CONSTRAINT fk_cfp_project FOREIGN KEY (project_id)      REFERENCES projects(id)      ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE custom_field_types (
  custom_field_id BIGINT UNSIGNED NOT NULL,
  type_id         BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (custom_field_id, type_id),
  CONSTRAINT fk_cft_field FOREIGN KEY (custom_field_id) REFERENCES custom_fields(id)      ON DELETE CASCADE,
  CONSTRAINT fk_cft_type  FOREIGN KEY (type_id)         REFERENCES work_package_types(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE custom_values (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  custom_field_id BIGINT UNSIGNED NOT NULL,
  customized_type ENUM('work_package','project','user','version','sprint') NOT NULL,
  customized_id   BIGINT UNSIGNED NOT NULL,
  value           TEXT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_cv (custom_field_id, customized_type, customized_id),
  KEY ix_cv_owner (customized_type, customized_id),
  CONSTRAINT fk_cv_field FOREIGN KEY (custom_field_id) REFERENCES custom_fields(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Form configuration is per work package type. A MILESTONE form drops the
-- estimate section entirely, which is why a milestone cannot accidentally carry
-- hours — the field is not on the form rather than being validated away later.
CREATE TABLE form_configurations (
  id      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  type_id BIGINT UNSIGNED NOT NULL,
  name    VARCHAR(120) NOT NULL DEFAULT 'default',
  PRIMARY KEY (id),
  UNIQUE KEY uq_form_type (type_id, name),
  CONSTRAINT fk_form_type FOREIGN KEY (type_id) REFERENCES work_package_types(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE form_sections (
  id       BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  form_id  BIGINT UNSIGNED NOT NULL,
  name     VARCHAR(120) NOT NULL,
  position INT NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY ix_fsec_form (form_id, position),
  CONSTRAINT fk_fsec_form FOREIGN KEY (form_id) REFERENCES form_configurations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE form_fields (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  section_id BIGINT UNSIGNED NOT NULL,
  attribute  VARCHAR(120) NOT NULL,     -- 'subject', 'assignee_id', 'custom.Domain'
  label      VARCHAR(160) NULL,
  position   INT NOT NULL DEFAULT 0,
  required   TINYINT(1) NOT NULL DEFAULT 0,
  read_only  TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ffield (section_id, attribute),
  CONSTRAINT fk_ffield_section FOREIGN KEY (section_id) REFERENCES form_sections(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE attribute_help_texts (
  id        BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  entity    ENUM('work_package','project','user','version','sprint','meeting') NOT NULL,
  attribute VARCHAR(120) NOT NULL,
  help      VARCHAR(600) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_help (entity, attribute)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Custom actions. They run on the server and write to the activity feed like a
-- person would, tagged with the automation as the actor.
CREATE TABLE automations (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name           VARCHAR(190) NOT NULL,
  trigger_kind   ENUM('gate_signed','status_changed','overdue','sprint_closed','repo_changed','wp_created','comment_added') NOT NULL,
  trigger_config JSON NULL,
  action_kind    ENUM('close_phase_work','close_parent','reingest','raise_priority','notify','move_sprint','set_status','add_comment','set_version') NOT NULL,
  action_config  JSON NULL,
  scope          ENUM('all','listed') NOT NULL DEFAULT 'all',
  enabled        TINYINT(1) NOT NULL DEFAULT 1,
  -- Why an automation is off is worth more than the fact that it is. The
  -- overdue escalation is off because it fired on the manuscript, where a date
  -- is a hope rather than a commitment; without that sentence somebody turns it
  -- back on in six months.
  disabled_note  VARCHAR(400) NULL,
  run_count      INT NOT NULL DEFAULT 0,
  last_run_at    DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_automation_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE automation_projects (
  automation_id BIGINT UNSIGNED NOT NULL,
  project_id    BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (automation_id, project_id),
  CONSTRAINT fk_ap_automation FOREIGN KEY (automation_id) REFERENCES automations(id) ON DELETE CASCADE,
  CONSTRAINT fk_ap_project    FOREIGN KEY (project_id)    REFERENCES projects(id)    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE automation_runs (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  automation_id   BIGINT UNSIGNED NOT NULL,
  work_package_id BIGINT UNSIGNED NULL,
  project_id      BIGINT UNSIGNED NULL,
  outcome         ENUM('applied','skipped','failed') NOT NULL,
  detail          VARCHAR(600) NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_arun_automation (automation_id, created_at),
  CONSTRAINT fk_arun_automation FOREIGN KEY (automation_id)   REFERENCES automations(id)   ON DELETE CASCADE,
  CONSTRAINT fk_arun_wp         FOREIGN KEY (work_package_id) REFERENCES work_packages(id) ON DELETE SET NULL,
  CONSTRAINT fk_arun_project    FOREIGN KEY (project_id)      REFERENCES projects(id)      ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The automated project initiation workflow: a request, its answers, and who
-- decided. A project created without one of these rows was created by an
-- administrator directly, and that difference is visible rather than assumed.
CREATE TABLE project_initiation_requests (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name         VARCHAR(190) NOT NULL,
  requested_by BIGINT UNSIGNED NOT NULL,
  template_id  BIGINT UNSIGNED NULL,
  program_id   BIGINT UNSIGNED NULL,
  answers      JSON NOT NULL,
  state        ENUM('submitted','approved','rejected','created') NOT NULL DEFAULT 'submitted',
  decided_by   BIGINT UNSIGNED NULL,
  decided_at   DATETIME NULL,
  decision_note VARCHAR(500) NULL,
  project_id   BIGINT UNSIGNED NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_pir_state (state, created_at),
  CONSTRAINT fk_pir_requester FOREIGN KEY (requested_by) REFERENCES users(id)             ON DELETE RESTRICT,
  CONSTRAINT fk_pir_template  FOREIGN KEY (template_id)  REFERENCES project_templates(id) ON DELETE SET NULL,
  CONSTRAINT fk_pir_program   FOREIGN KEY (program_id)   REFERENCES programs(id)          ON DELETE SET NULL,
  CONSTRAINT fk_pir_decider   FOREIGN KEY (decided_by)   REFERENCES users(id)             ON DELETE SET NULL,
  CONSTRAINT fk_pir_project   FOREIGN KEY (project_id)   REFERENCES projects(id)          ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE settings (
  name       VARCHAR(120) NOT NULL,
  value      TEXT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ================================================================== MCP surface

-- The tool registry the Repositories & MCP page lists. A tool the server does
-- not implement still gets a row, with its status, because "not started" is the
-- answer somebody needs and an absent row reads as "does not exist".
CREATE TABLE mcp_tools (
  id       BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name     VARCHAR(120) NOT NULL,
  mode     ENUM('read','write') NOT NULL DEFAULT 'read',
  detail   VARCHAR(400) NULL,
  status   ENUM('not_started','speccing','in_build','done') NOT NULL DEFAULT 'not_started',
  enabled  TINYINT(1) NOT NULL DEFAULT 1,
  position INT NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_mcp_tool (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A token, never the secret. token_hash is sha256(secret); the secret is shown
-- once at creation and is not recoverable from this table.
CREATE TABLE mcp_tokens (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name          VARCHAR(160) NOT NULL,
  token_hash    CHAR(64) NOT NULL,
  token_hint    VARCHAR(24) NOT NULL,      -- last four characters, for recognising it in a list
  scope         ENUM('read','write') NOT NULL DEFAULT 'read',
  project_scope JSON NULL,                 -- NULL: every project. Otherwise a list of project ids.
  -- Internal comments are excluded from every MCP read regardless of scope. A
  -- token that could see them would need its own decision, and this column makes
  -- granting one a deliberate act.
  includes_internal TINYINT(1) NOT NULL DEFAULT 0,
  created_by    BIGINT UNSIGNED NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at    DATETIME NULL,
  last_used_at  DATETIME NULL,
  revoked_at    DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_mcp_hash (token_hash),
  CONSTRAINT fk_mcptoken_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The audit format the write tool waits on. Every MCP call lands here — reads
-- included — because "what did the assistant look at" is the question an audit
-- is actually asked, and logging only writes answers a different one.
CREATE TABLE mcp_audit (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  token_id     BIGINT UNSIGNED NULL,
  token_hint   VARCHAR(24) NULL,          -- kept even if the token row is gone
  tool         VARCHAR(120) NOT NULL,
  mode         ENUM('read','write') NOT NULL,
  arguments    JSON NULL,
  outcome      ENUM('ok','denied','error') NOT NULL,
  result_note  VARCHAR(600) NULL,
  row_count    INT NULL,
  project_ids  JSON NULL,
  duration_ms  INT NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_audit_created (created_at),
  KEY ix_audit_tool (tool, created_at),
  CONSTRAINT fk_audit_token FOREIGN KEY (token_id) REFERENCES mcp_tokens(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A generated status summary. Kept as a row with its author and its timestamp so
-- the My page widget can say WRITTEN 41M AGO · MCP and a reader can tell
-- generated prose from a person's.
CREATE TABLE generated_summaries (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  scope        ENUM('portfolio','project','user') NOT NULL,
  project_id   BIGINT UNSIGNED NULL,
  user_id      BIGINT UNSIGNED NULL,
  body         MEDIUMTEXT NOT NULL,
  source       VARCHAR(120) NOT NULL DEFAULT 'mcp',
  token_id     BIGINT UNSIGNED NULL,
  generated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  superseded_at DATETIME NULL,
  PRIMARY KEY (id),
  KEY ix_summary_scope (scope, project_id, user_id, generated_at),
  CONSTRAINT fk_sum_project FOREIGN KEY (project_id) REFERENCES projects(id)   ON DELETE CASCADE,
  CONSTRAINT fk_sum_user    FOREIGN KEY (user_id)    REFERENCES users(id)      ON DELETE CASCADE,
  CONSTRAINT fk_sum_token   FOREIGN KEY (token_id)   REFERENCES mcp_tokens(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Export requests. A row per export so a large PDF can be built out of band and
-- collected, rather than held open on the request that asked for it.
CREATE TABLE exports (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  kind         ENUM('csv','xlsx','pdf','ical') NOT NULL,
  scope        VARCHAR(60) NOT NULL,      -- 'work_packages', 'plan', 'roadmap'
  query        JSON NULL,
  requested_by BIGINT UNSIGNED NOT NULL,
  state        ENUM('queued','ready','failed') NOT NULL DEFAULT 'queued',
  storage_path VARCHAR(500) NULL,
  byte_size    BIGINT UNSIGNED NULL,
  row_count    INT NULL,
  error        VARCHAR(500) NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME NULL,
  PRIMARY KEY (id),
  KEY ix_export_user (requested_by, created_at),
  CONSTRAINT fk_export_user FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE users
  ADD CONSTRAINT fk_users_theme FOREIGN KEY (theme_id) REFERENCES themes(id) ON DELETE SET NULL;
ALTER TABLE projects
  ADD CONSTRAINT fk_project_workweek FOREIGN KEY (work_week_id) REFERENCES work_weeks(id) ON DELETE SET NULL;

SET FOREIGN_KEY_CHECKS = 1;
