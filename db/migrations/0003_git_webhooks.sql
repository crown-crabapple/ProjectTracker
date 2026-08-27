-- 0003 — webhook deliveries
--
-- `0002` gave the tracker a pull: somebody presses a button and the mirror
-- catches up. This is the other direction — the forge tells us the moment a
-- pull request merges — and it needed two things the pull did not.
--
-- A SECRET, AND STILL NOT IN THE DATABASE. Verifying a delivery needs a shared
-- secret, which is a credential, and the rule stands: the repository records the
-- NAME of the environment variable it is read from. An unsigned delivery is
-- never accepted — not "accepted with a warning" — because a webhook endpoint
-- that trusts its body is an endpoint anybody on the internet can use to move
-- somebody's work package.
--
-- SOMEBODY TO ACT AS. A pull runs as the person who started it and can do no
-- more than they can. Nobody starts a webhook, so if a delivery is ever to move
-- a status it needs an authority to borrow, and `hook_actor_id` is where an
-- administrator names one — the same argument as an MCP token's issuer, in
-- docs/decisions/0006. It is NULL by default, and a delivery on a repository
-- with no actor mirrors and links and moves nothing, and says so in the
-- delivery record rather than failing silently.

ALTER TABLE repositories
  -- The NAME of the variable holding the shared secret. GitHub signs the body
  -- with it (X-Hub-Signature-256), Forgejo the same, GitLab sends it back
  -- verbatim in X-Gitlab-Token.
  ADD COLUMN hook_secret_env VARCHAR(120) NULL AFTER token_env,
  -- Whose authority a delivery borrows when a status rule fires. NULL means a
  -- delivery may mirror but may never move a work package.
  ADD COLUMN hook_actor_id   BIGINT UNSIGNED NULL AFTER hook_secret_env,
  ADD COLUMN hook_state      ENUM('never','ok','rejected') NOT NULL DEFAULT 'never' AFTER hook_actor_id,
  ADD COLUMN hook_detail     VARCHAR(300) NULL AFTER hook_state,
  ADD COLUMN hook_last_at    DATETIME NULL AFTER hook_detail,
  -- ON DELETE SET NULL rather than RESTRICT: deleting the person must not fail,
  -- and the consequence — deliveries stop moving statuses — is visible on the
  -- deck rather than silent, because `hook_actor_id` is shown there.
  ADD CONSTRAINT fk_repo_hook_actor FOREIGN KEY (hook_actor_id) REFERENCES users(id) ON DELETE SET NULL;

-- Every delivery, kept — including the ones that were refused, with the reason.
-- `email_intake` keeps its rejections for exactly this reason: an intake that
-- silently drops what it will not accept is an intake nobody trusts twice, and
-- "the forge says it delivered and the tracker shows nothing" is otherwise
-- unanswerable.
CREATE TABLE git_hook_deliveries (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  -- NULL when the URL named a repository that does not exist. The row is still
  -- written: somebody is posting to this server and that is worth seeing.
  repository_id BIGINT UNSIGNED NULL,
  -- The forge's own delivery id, from X-GitHub-Delivery and its cousins. Not
  -- unique: a retry is a fact, and the second row records that it was ignored
  -- rather than replacing the first.
  delivery_id   VARCHAR(190) NULL,
  event         VARCHAR(60) NULL,          -- pull_request, issues, push, ping …
  action        VARCHAR(60) NULL,          -- opened, closed, synchronize …
  state         ENUM('applied','ignored','rejected') NOT NULL DEFAULT 'ignored',
  -- Why, on every state and not only the refusals: 'nothing this delivery
  -- carried was new' and 'the signature did not match' are both answers
  -- somebody will come looking for.
  reason        VARCHAR(400) NULL,
  signature_ok  TINYINT(1) NOT NULL DEFAULT 0,
  items_touched INT NOT NULL DEFAULT 0,
  links_made    INT NOT NULL DEFAULT 0,
  statuses_moved INT NOT NULL DEFAULT 0,
  -- The body as it arrived, truncated, plus its true size. Kept for the same
  -- reason `email_intake.body` is kept — a delivery you cannot re-read is a
  -- delivery you cannot explain — and truncated because a push to a big
  -- repository is megabytes of commit list nobody will read.
  payload       MEDIUMTEXT NULL,
  payload_bytes INT NULL,
  remote_addr   VARCHAR(64) NULL,
  received_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_hook_repo (repository_id, received_at),
  KEY ix_hook_delivery (repository_id, delivery_id),
  CONSTRAINT fk_hook_repo FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
