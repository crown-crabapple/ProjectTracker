/*
 * The application: state, routing, and the render loop.
 *
 * ROUTING IS THE URL. Every piece of view state that a person might want to come
 * back to — the route, the project, the filter text, the board mode, the wiki
 * document, the open drawer — lives in the hash, and the app renders from it.
 * Nothing is held in a variable that the URL does not also carry.
 *
 * That is a deliberate constraint rather than a stylistic one. It is what makes
 * a filtered work package list shareable, what makes the browser's back button
 * work through a drawer, and what makes a bug reproducible from a screenshot:
 * the address bar is the whole state.
 *
 *   #/work?project=1&status=in_build&q=rollup&wp=112
 */

(function (global) {
  'use strict';

  const { h, fill } = global.dom;

  const VIEWS = {
    my: global.viewMy,
    portfolio: global.viewPortfolio,
    overview: global.viewOverview,
    work: global.viewWork,
    gantt: global.viewGantt,
    boards: global.viewBoards,
    backlogs: global.viewBacklogs,
    roadmap: global.viewRoadmap,
    calendar: global.viewCalendar,
    planner: global.viewPlanner,
    activity: global.viewActivity,
    wiki: global.viewWiki,
    meetings: global.viewMeetings,
    deck: global.viewDeck,
    connect: global.viewConnect,
    admin: global.viewAdmin,
  };

  /** Which URL parameters each route reads. Anything else is dropped on a
   *  route change, so a stale filter cannot follow you to a different screen. */
  const PARAMS = {
    my: [],
    portfolio: ['favourites'],
    overview: ['project'],
    work: ['project', 'q', 'status', 'type', 'priority', 'version', 'sprint', 'sort', 'overdue', 'unassigned', 'open'],
    gantt: ['project', 'baseline'],
    boards: ['project', 'type'],
    backlogs: ['project'],
    roadmap: [],
    calendar: ['project', 'month'],
    planner: ['weeks', 'from'],
    activity: [],
    wiki: ['project', 'doc'],
    meetings: ['project', 'meeting'],
    deck: ['project', 'repo', 'kind'],
    connect: [],
    admin: ['tab'],
  };

  const app = {
    boot: null,
    state: { route: 'my', project: null, q: '', wp: null, params: {} },
    /** Guards against an out-of-order render when two navigations overlap. */
    renderToken: 0,

    // ------------------------------------------------------------------ startup

    async start() {
      try {
        const session = await global.api.get('/api/session');
        if (!session.user) return this.showSignIn();
        await this.loadBoot();
      } catch (e) {
        if (e.status === 401) return this.showSignIn();
        return this.fatal(e.message);
      }
      window.addEventListener('hashchange', () => this.readHash().render());
      this.readHash();
      if (!location.hash) {
        this.state.route = this.boot.user.start_screen || 'my';
      }
      document.getElementById('boot').hidden = true;
      document.getElementById('shell').hidden = false;
      this.render();
    },

    async loadBoot() {
      this.boot = await global.api.get('/api/bootstrap');
      this.applyTheme();
      if (!this.state.project && this.boot.projects.length) {
        // A favourite first, then the first by code. Opening on whichever
        // project sorts first alphabetically is arbitrary, and the favourite
        // star is the person already having told us which one they care about.
        const favourite = this.boot.projects.find((p) => p.favourite);
        this.state.project = (favourite || this.boot.projects[0]).id;
      }
    },

    /**
     * Inject the theme's tokens as a :root block.
     *
     * The stylesheet already carries the shipped values, so a database with no
     * theme row renders correctly; this only overrides. A theme is therefore a
     * data change rather than a deploy.
     */
    applyTheme() {
      const theme = this.boot.theme;
      if (!theme || !theme.tokens) return;
      const root = document.documentElement;
      for (const [name, value] of Object.entries(theme.tokens)) {
        // Only custom properties. A theme row that named 'display' could
        // otherwise rewrite the layout.
        if (/^--[a-z0-9-]+$/i.test(name)) root.style.setProperty(name, String(value));
      }
    },

    showSignIn() {
      document.getElementById('boot').hidden = true;
      document.getElementById('signin').hidden = false;
      const form = document.getElementById('signin-form');
      const error = document.getElementById('signin-error');
      form.onsubmit = async (e) => {
        e.preventDefault();
        error.hidden = true;
        const data = new FormData(form);
        try {
          await global.api.post('/api/session', {
            login: data.get('login'), password: data.get('password'),
          });
          document.getElementById('signin').hidden = true;
          document.getElementById('boot').hidden = false;
          await this.loadBoot();
          document.getElementById('boot').hidden = true;
          document.getElementById('shell').hidden = false;
          window.addEventListener('hashchange', () => this.readHash().render());
          this.readHash();
          this.render();
        } catch (err) {
          error.textContent = err.message;
          error.hidden = false;
        }
      };
    },

    async signOut() {
      await global.api.del('/api/session').catch(() => {});
      location.hash = '';
      location.reload();
    },

    fatal(message) {
      document.getElementById('boot').hidden = true;
      const shell = document.getElementById('shell');
      shell.hidden = false;
      fill(document.getElementById('view'), h('div.page', [
        h('div.panel', [
          h('div.panel-head', [h('h2', { text: 'Cannot start' })]),
          h('div.panel-body', [
            h('p', { text: message }),
            h('p.note', { text: 'Check that the server is running and that the database is migrated and seeded.' }),
          ]),
        ]),
      ]));
    },

    // ------------------------------------------------------------------ routing

    readHash() {
      const raw = location.hash.replace(/^#\/?/, '');
      const [path, search] = raw.split('?');
      const params = new URLSearchParams(search || '');
      const route = VIEWS[path] ? path : (path ? 'my' : this.state.route);
      this.state.route = route;
      this.state.params = Object.fromEntries(params);
      this.state.q = params.get('q') || '';
      this.state.wp = params.get('wp') ? Number(params.get('wp')) : null;
      if (params.get('project')) this.state.project = Number(params.get('project'));
      return this;
    },

    /** Write the hash. `replace` avoids stacking a history entry per keystroke. */
    writeHash({ replace = false } = {}) {
      const allowed = PARAMS[this.state.route] || [];
      const params = {};
      for (const k of allowed) {
        const v = this.state.params[k];
        if (v !== undefined && v !== '' && v !== null) params[k] = v;
      }
      if (allowed.includes('project') && this.state.project) params.project = this.state.project;
      if (allowed.includes('q') && this.state.q) params.q = this.state.q;
      if (this.state.wp) params.wp = this.state.wp;
      const next = `#/${this.state.route}${global.api.qs(params)}`;
      if (next === location.hash) return false;
      if (replace) history.replaceState(null, '', next);
      else location.hash = next;
      return true;
    },

    go(route, params) {
      this.state.route = route;
      this.state.params = params ? { ...params } : {};
      this.state.wp = null;
      if (!(PARAMS[route] || []).includes('q')) this.state.q = '';
      document.getElementById('shell').classList.remove('rail-open');
      if (!this.writeHash()) this.render();
    },

    setParam(key, value, { replace = false } = {}) {
      if (value === null || value === undefined || value === '') delete this.state.params[key];
      else this.state.params[key] = String(value);
      if (!this.writeHash({ replace })) this.render();
    },

    setProject(id) {
      this.state.project = Number(id);
      this.state.params.project = String(id);
      this.state.wp = null;
      if (!this.writeHash()) this.render();
    },

    /** Debounced, and history-replacing: typing should not fill the back stack. */
    setQuery(value) {
      this.state.q = value;
      clearTimeout(this._qTimer);
      this._qTimer = setTimeout(() => {
        if (this.state.route === 'work') this.state.params.q = value;
        else { this.state.route = 'work'; this.state.params = { project: this.state.project, q: value }; }
        if (!this.writeHash({ replace: true })) this.render();
        else this.render();
      }, 220);
    },

    openWp(id) {
      this.state.wp = Number(id);
      this.writeHash();
      global.drawer.open(this, Number(id));
    },

    closeWp() {
      this.state.wp = null;
      this.writeHash({ replace: true });
      global.drawer.close();
    },

    currentProject() {
      if (!this.boot) return null;
      return this.boot.projects.find((p) => Number(p.id) === Number(this.state.project)) || null;
    },

    // ------------------------------------------------------------------- render

    async render() {
      if (!this.boot) return;
      const token = ++this.renderToken;
      global.shell.renderRail(this);
      global.shell.renderTopbar(this);

      const view = document.getElementById('view');
      const renderer = VIEWS[this.state.route];
      if (!renderer) return this.fatal(`no view for "${this.state.route}"`);

      // A skeleton rather than a spinner: the frame is already correct, and a
      // spinner over a correct frame reads as slower than it is.
      if (!view.firstChild) fill(view, h('div.page', h('div.empty', { text: 'loading' })));

      try {
        const tree = await renderer(this);
        // A slower earlier render must never overwrite a faster later one.
        if (token !== this.renderToken) return;
        fill(view, tree);
      } catch (e) {
        if (e.superseded) return;
        if (token !== this.renderToken) return;
        if (e.status === 401) return this.showSignIn();
        fill(view, h('div.page', [
          h('div.panel', [
            h('div.panel-head', [h('h2', { text: 'This view could not load' })]),
            h('div.panel-body', [
              h('p', { text: e.message }),
              h('button.btn', { onclick: () => this.render(), text: 'TRY AGAIN' }),
            ]),
          ]),
        ]));
      }

      if (this.state.wp) global.drawer.open(this, this.state.wp);
      else global.drawer.close();
    },

    /** Refetch the shell counts and the current view. Called after every write. */
    async refresh() {
      try { this.boot = await global.api.get('/api/bootstrap'); } catch { /* the view error is enough */ }
      await this.render();
    },

    toast(message, tone) {
      const el = document.getElementById('toast');
      el.className = `toast${tone ? ' ' + tone : ''}`;
      el.textContent = message;
      el.hidden = false;
      clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => { el.hidden = true; }, 4200);
    },

    /**
     * Run a write, show its error, refresh on success. Every mutation in every
     * view goes through this, so no view has to remember to do the three steps.
     */
    async act(fn, successMessage) {
      try {
        const out = await fn();
        if (successMessage) this.toast(successMessage, 'good');
        await this.refresh();
        return out;
      } catch (e) {
        if (!e.superseded) this.toast(e.message, 'bad');
        return null;
      }
    },
  };

  global.app = app;

  document.getElementById('scrim').addEventListener('click', () => app.closeWp());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && app.state.wp) app.closeWp();
  });

  // Started once, whichever of the two paths gets there first. Without the
  // guard, a document that is already 'interactive' when this file runs starts
  // the app twice and fetches everything twice.
  let started = false;
  const startOnce = () => { if (!started) { started = true; app.start(); } };
  document.addEventListener('DOMContentLoaded', startOnce);
  if (document.readyState !== 'loading') startOnce();
}(window));
