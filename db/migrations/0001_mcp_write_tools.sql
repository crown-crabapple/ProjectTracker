-- 0001 — the MCP write tools
--
-- `mcp_tools` is what tools/list filters against: a tool whose row is disabled is
-- not offered, and a tool that is listed and refuses is worse than one that was
-- never offered. A database seeded before the write tools existed has five rows,
-- so the seven new tools would be filtered out of every listing and be
-- unreachable — which looks exactly like a bug in the server.
--
-- INSERT IGNORE, and every tool rather than only the new ones. The filter treats
-- an EMPTY table as "no opinion, offer everything", so half-populating it on a
-- database that had no rows would silently hide the four read tools. Listing all
-- twelve makes the outcome the same whichever state the table was in.
--
-- The write rows are `in_build` rather than `done` for the reason
-- docs/decisions/0005 gives about summary.write: the tools work, and the policy
-- around them — who may issue a write token, and for how long — is a decision
-- for whoever deploys this.

INSERT IGNORE INTO mcp_tools (name, mode, detail, status, position, enabled) VALUES
  ('portfolio.status',     'read',  'Weighted progress, gates, health per project',                 'done',      0, 1),
  ('work_packages.query',  'read',  'Filter by project, status, version, sprint, assignee',         'done',      1, 1),
  ('wiki.read',            'read',  'Fetch a document by number, with the revision to save against','done',      2, 1),
  ('activity.recent',      'read',  'The audit trail, newest first, internal comments excluded',    'done',      3, 1),
  ('project.create',       'write', 'Create a project, optionally from a template blueprint',       'in_build',  4, 1),
  ('work_package.create',  'write', 'Create a work package',                                        'in_build',  5, 1),
  ('work_package.update',  'write', 'Change one, through the status workflow',                      'in_build',  6, 1),
  ('version.create',       'write', 'Create a version',                                             'in_build',  7, 1),
  ('wiki.create',          'write', 'Create a wiki page',                                           'in_build',  8, 1),
  ('wiki.update',          'write', 'Replace a page body, refusing a stale base revision',          'in_build',  9, 1),
  ('comment.add',          'write', 'Comment on a work package or a wiki page, never internally',   'in_build', 10, 1),
  ('summary.write',        'write', 'Post a generated status summary to My page',                   'in_build', 11, 1);
