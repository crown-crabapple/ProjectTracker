/*
 * The shell: the navigation rail and the top bar.
 *
 * These are the only two regions that survive a route change, so they are
 * rendered once from /api/bootstrap and then patched — the current-item marker
 * and the counts — rather than rebuilt. Rebuilding them was the first version
 * and it lost the rail's scroll position on every navigation.
 */

(function (global) {
  'use strict';

  const { h, fill, pct } = global.dom;

  /**
   * The rail's structure. `scoped: true` means the item is about one project and
   * the URL carries the project; the others are portfolio-wide. That flag is
   * what decides whether the breadcrumb shows a project code, so it lives here
   * rather than being restated per view.
   */
  const NAV = [
    { group: 'Portfolio', items: [
      { route: 'my', label: 'My page', count: 'my' },
      { route: 'portfolio', label: 'Projects & programs', count: 'projects' },
      { route: 'activity', label: 'Activity & inbox', count: 'inbox', alert: true },
    ] },
    { group: 'Project', project: true, items: [
      { route: 'overview', label: 'Overview', scoped: true },
      { route: 'work', label: 'Work packages', scoped: true, count: 'wp' },
      { route: 'gantt', label: 'Gantt', scoped: true },
      { route: 'boards', label: 'Boards', scoped: true },
      { route: 'backlogs', label: 'Backlogs & sprints', scoped: true },
      { route: 'roadmap', label: 'Roadmap' },
      { route: 'calendar', label: 'Calendar', scoped: true },
      { route: 'planner', label: 'Team planner' },
    ] },
    { group: 'Knowledge', items: [
      { route: 'wiki', label: 'Wiki & documents', scoped: true },
      { route: 'meetings', label: 'Meetings', scoped: true },
    ] },
    { group: 'Setup', admin: true, items: [
      { route: 'connect', label: 'Repositories & MCP' },
      { route: 'admin', label: 'Administration' },
    ] },
  ];

  const CRUMBS = {
    my: 'MY PAGE',
    portfolio: 'PORTFOLIO / PROJECTS & PROGRAMS',
    overview: 'OVERVIEW',
    work: 'WORK PACKAGES',
    gantt: 'GANTT',
    boards: 'BOARDS',
    backlogs: 'BACKLOGS & SPRINTS',
    roadmap: 'ROADMAP',
    calendar: 'CALENDAR',
    planner: 'TEAM PLANNER',
    activity: 'ACTIVITY & INBOX',
    wiki: 'WIKI & DOCUMENTS',
    meetings: 'MEETINGS',
    connect: 'REPOSITORIES & MCP',
    admin: 'ADMINISTRATION',
  };

  const SCOPED = new Set(Object.keys(CRUMBS).filter((r) => (
    ['overview', 'work', 'gantt', 'boards', 'backlogs', 'calendar', 'wiki', 'meetings'].includes(r)
  )));

  const HEALTH = {
    green: { label: 'HEALTHY', colour: 'var(--ok)' },
    amber: { label: 'IN BUILD', colour: 'var(--accent)' },
    rust: { label: 'GATE BLOCKED', colour: 'var(--blocked)' },
    off: { label: 'NOT STARTED', colour: 'var(--ink-6)' },
  };

  function renderRail(app) {
    const boot = app.boot;
    const rail = document.getElementById('rail');
    const project = app.currentProject();

    fill(rail, [
      h('div.rail-brand', [
        h('b', { text: boot.portfolioName.toUpperCase() }),
        h('span', { text: 'PROJECT TRACKER' }),
      ]),

      ...NAV.map((section) => {
        if (section.admin && !boot.user.is_admin) return null;
        return h('div.rail-group', [
          h('div.rail-head', { text: section.group }),
          section.project ? projectPicker(app) : null,
          ...section.items.map((item) => railItem(app, item, project)),
        ]);
      }).filter(Boolean),

      h('div.rail-user', [
        global.dom.avatar({ initials: boot.user.initials, colour: boot.user.colour, name: boot.user.name }),
        h('div.who', [
          h('b', { text: boot.user.name }),
          h('span', { text: boot.user.is_admin ? 'administrator' : boot.user.kind }),
        ]),
        h('button', { onclick: () => app.signOut(), title: 'Sign out', text: 'OUT' }),
      ]),
    ]);
  }

  function projectPicker(app) {
    const select = h('select', {
      'aria-label': 'Project',
      onchange: (e) => app.setProject(Number(e.target.value)),
    }, app.boot.projects.map((p) => h('option', {
      value: p.id,
      selected: Number(p.id) === Number(app.state.project) ? true : null,
      text: `${p.code} — ${p.name}`,
    })));
    if (!app.boot.projects.length) {
      return h('div.empty', { text: 'no projects you can see' });
    }
    return select;
  }

  function railItem(app, item, project) {
    const current = app.state.route === item.route;
    const counts = { ...app.boot.counts, wp: project ? project.wp_total : 0 };
    return h('button.rail-item' + (current ? '.is-current' : ''), {
      onclick: () => app.go(item.route),
      'aria-current': current ? 'page' : null,
    }, [
      h('i'),
      h('span.label', { text: item.label }),
      item.count && counts[item.count]
        ? h('span.count' + (item.alert ? '.is-alert' : ''), { text: counts[item.count] })
        : null,
    ]);
  }

  function renderTopbar(app) {
    const bar = document.getElementById('topbar');
    const boot = app.boot;
    const project = app.currentProject();
    const scoped = SCOPED.has(app.state.route) && project;
    const crumb = `${boot.portfolioName.toUpperCase()} / ${scoped ? project.code + ' / ' : ''}${CRUMBS[app.state.route] || ''}`;
    const health = project ? (HEALTH[project.health] || HEALTH.off) : null;

    fill(bar, [
      h('button.btn.small.rail-toggle', {
        style: { display: 'none' },
        onclick: () => document.getElementById('shell').classList.toggle('rail-open'),
        'aria-label': 'Show navigation',
        text: 'MENU',
      }),
      h('div.crumb', { text: crumb }),
      h('div.spacer'),
      searchBox(app),
      boot.counts.alerts
        ? h('div.chip.is-alert', {
          role: 'button', tabindex: '0',
          onclick: () => app.go('activity'),
          onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') app.go('activity'); },
        }, [h('span.dot'), `${boot.counts.alerts} DATE ALERT${boot.counts.alerts === 1 ? '' : 'S'}`])
        : null,
      health
        ? h('div.chip.optional', [
          h('span.dot', { style: { background: health.colour } }),
          project.health_note ? project.health_note.toUpperCase() : health.label,
        ])
        : null,
    ]);
  }

  /**
   * The filter box. It sets the query string and lets the current view re-read
   * it, rather than calling into the view directly: that way the URL is the
   * single source of truth for what is on screen and a filtered list can be
   * bookmarked and shared.
   */
  function searchBox(app) {
    const input = h('input', {
      value: app.state.q || '',
      placeholder: 'filter work packages',
      'aria-label': 'Filter',
      oninput: (e) => app.setQuery(e.target.value),
    });
    return h('div.searchbox', [h('span.dot'), input]);
  }

  global.shell = { renderRail, renderTopbar, NAV, CRUMBS, SCOPED, HEALTH };
}(window));
