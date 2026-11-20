/*
 * Telemetry onboarding prototype.
 *
 * One page app (hash routes) with the real menu: Overview (home), Groups,
 * Policies, Connectors, Destinations, Data flow, Settings. Onboarding is a
 * module on the Overview that walks people through the real pages; once
 * setup is complete the Overview shows tasks, insights, recent changes and
 * destination health instead.
 *
 * Model (agreed in design):
 * - A newly connected device sends nothing except update traffic to the
 *   Canonical Snap Store (the one default connector, scope "All devices").
 * - Groups are queries saved as static (these devices) or dynamic (these and
 *   any device that matches later). Groups do nothing on their own and are
 *   shared with Landscape.
 * - Connectors move data: group + policy + destination. Setting one up is
 *   where data leaves, so that is where the preview lives.
 * - A device in several connectors' groups sends each packet to every
 *   matching destination (fan-out).
 * - No approvals in the MVP: a connector is live as soon as it is created;
 *   other admins are notified and the change is logged.
 *
 * Demo scenarios by URL: ?fleet=zero|hobby|mid|enterprise &landscape=0|1 &joiner=1
 */
(function (TL) {
  'use strict';

  const S = TL.sankey, esc = S.esc;
  const $ = function (id) { return document.getElementById(id); };
  const params = new URLSearchParams(location.search);

  // ---- Scenario --------------------------------------------------------
  // Fleet size needs a reload (data.js builds the devices); everything else is live state set from the jig.
  // ?landscape=0 and ?joiner=1 only seed a fresh state.
  const SCEN = {
    fleet: ['zero', 'hobby', 'mid', 'enterprise'].indexOf(params.get('fleet')) >= 0 ? params.get('fleet') : 'mid'
  };
  const KEY = 'tob.v2.' + SCEN.fleet;
  function J() { return state.jig; }
  const ME = 'Hayden Chambers';
  const ANA = 'Ana Ruiz', TOM = 'Tom Okafor';

  // ---- Devices and derived attributes ---------------------------------
  const ALL = TL.DEVICES.slice();
  const ALL_BY_ID = {}; ALL.forEach(function (d) { ALL_BY_ID[d.id] = d; });
  function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967295; }
  const RAM = { edge: [4, 8, 8, 16], vm: [8, 16, 32, 32], k8s: [16, 32, 64, 64], metal: [32, 64, 128, 256] };
  function ram(d) { const o = RAM[d.attrs.type] || RAM.vm; return o[Math.floor(hash(d.id + 'ram') * o.length)]; }
  const VOL = { edge: [20, 90], vm: [60, 220], k8s: [150, 600], metal: [120, 480] }; // MB/day sent by the device's snaps
  function devVol(d) { const r = VOL[d.attrs.type] || VOL.vm; return r[0] + hash(d.id + 'vol') * (r[1] - r[0]); }
  const STORE_VOL = 8; // MB/day of update traffic with the store, both ways (refresh checks out, snap downloads in)
  function snapsOf(d) { return (d.extras && d.extras.apps) || []; }

  function attrLabel(key, id) {
    const a = TL.ATTRIBUTES[key];
    const v = a && a.values.filter(function (x) { return x.id === id; })[0];
    return v ? v.label : id == null ? 'Not set' : id === 'home' ? 'Home' : String(id);
  }
  function snapLabel(id) { const v = TL.valueOf('publisher', id); return v ? v.label : id; }
  const SNAP_IDS = (function () { const o = {}; ALL.forEach(function (d) { snapsOf(d).forEach(function (s) { o[s] = 1; }); }); return Object.keys(o); })();

  function enumValues(key) {
    const seen = {};
    ALL.forEach(function (d) { const v = d.attrs[key]; if (v != null) seen[v] = 1; });
    return Object.keys(seen).map(function (id) { return { id: id, label: attrLabel(key, id) }; });
  }
  const QATTRS = [
    { id: 'region', label: 'Region' }, { id: 'site', label: 'Site' }, { id: 'type', label: 'Device type' },
    { id: 'environment', label: 'Environment' }, { id: 'release', label: 'Ubuntu release' }, { id: 'juju', label: 'Juju version' },
    { id: 'ram', label: 'RAM (GB)', numeric: true },
    { id: 'landscape', label: 'Managed by Landscape', values: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }] },
    { id: 'snap', label: 'Runs snap', snap: true }
  ].map(function (a) {
    if (!a.values && !a.numeric && !a.snap) a.values = enumValues(a.id);
    if (a.snap) a.values = SNAP_IDS.map(function (s) { return { id: s, label: snapLabel(s) }; });
    return a;
  }).filter(function (a) { return a.numeric || a.values.length; });
  const QA = {}; QATTRS.forEach(function (a) { QA[a.id] = a; });

  function getAttr(d, key) {
    if (key === 'ram') return ram(d);
    if (key === 'landscape') return d.extras && d.extras.landscape ? 'yes' : 'no';
    return d.attrs[key];
  }
  function rowMatches(d, r) {
    if (r.attr === 'snap') { const has = snapsOf(d).indexOf(r.val) >= 0; return r.op === 'isnot' ? !has : has; }
    const v = getAttr(d, r.attr);
    if (r.op === 'gte') return Number(v) >= Number(r.val);
    if (r.op === 'lte') return Number(v) <= Number(r.val);
    if (r.op === 'isnot') return String(v) !== String(r.val);
    return String(v) === String(r.val);
  }
  function queryMatches(d, q) { return q.every(function (r) { return rowMatches(d, r); }); }
  const OPS = { is: 'is', isnot: 'is not', gte: 'at least', lte: 'at most' };
  function queryText(q) {
    if (!q.length) return 'All devices';
    return q.map(function (r) {
      const a = QA[r.attr]; if (!a) return '';
      const val = a.numeric ? r.val + ' GB' : (a.values.filter(function (v) { return v.id === r.val; })[0] || { label: r.val }).label;
      return a.label + ' ' + (a.snap ? (r.op === 'isnot' ? 'excludes' : 'includes') : OPS[r.op]) + ' ' + val;
    }).join(' and ');
  }

  // ---- State -----------------------------------------------------------
  function now() { return new Date().toISOString(); }
  function fresh() {
    const s = {
      v: 1, connected: SCEN.fleet !== 'zero', connectedAt: null, intents: [], primary: null, aboutDone: false, useAll: false,
      groups: [{ id: 'all', name: 'All devices', kind: 'dynamic', system: true, query: [], members: null, by: 'System', at: now() }],
      policies: [],
      destinations: [{ id: 'store', name: 'Canonical Snap Store', type: 'Snap Store', cls: 'canonical', region: 'Global', canonical: true, by: 'System', at: now() }],
      connectors: [{ id: 'store', name: 'Updates', group: 'all', policy: null, dest: 'store', canonical: true, by: 'System', at: now() }],
      changes: [], users: [{ name: ME, email: 'hayden@example.com', role: 'Admin', status: 'active' }],
      flowSeen: false, firstConnector: null, skipAhead: false, introSeen: false, setupNoted: false,
      jig: { landscape: params.get('landscape') !== '0', joiner: false, rejected: true, optedOut: true, degraded: true, open: false }
    };
    if (params.get('joiner') === '1') { setJoiner(s, true); setAna(s, 'group', true); }
    return s;
  }

  // ---- Jig: what other people did before me ---------------------------
  function setJoiner(s, on) {
    s.jig.joiner = on;
    s.users = s.users.filter(function (u) { return u.name !== ANA && u.name !== TOM; });
    s.changes = s.changes.filter(function (c) { return c.who !== ANA; });
    if (!on) { ['connector', 'policy', 'group'].forEach(function (k) { setAna(s, k, false); }); return; }
    s.users.unshift({ name: ANA, email: 'ana@example.com', role: 'Admin', status: 'active' });
    s.users.push({ name: TOM, email: 'tom@example.com', role: 'Approver (external destinations)', status: 'active' });
    s.changes.push({ who: ANA, what: 'invited <strong>' + ME + '</strong> as Admin', at: now() });
    s.changes.push({ who: ANA, what: 'invited <strong>' + TOM + '</strong> as Approver (external destinations)', at: now() });
  }
  function anaHas(s, kind) {
    const list = kind === 'group' ? s.groups : kind === 'policy' ? s.policies : s.connectors;
    return list.some(function (x) { return x.id === 'ana-' + kind; });
  }
  function setAna(s, kind, on) {
    const id = 'ana-' + kind;
    const strip = function (list) { return list.filter(function (x) { return x.id !== id; }); };
    if (!on) {
      if (kind === 'group') { s.groups = strip(s.groups); setAna(s, 'connector', false); }
      if (kind === 'policy') { s.policies = strip(s.policies); setAna(s, 'connector', false); }
      if (kind === 'connector') { s.connectors = strip(s.connectors); s.destinations = s.destinations.filter(function (d) { return d.id !== 'ana-dest'; }); }
      s.changes = s.changes.filter(function (c) { return c.ana !== kind; });
      return;
    }
    if (anaHas(s, kind)) return;
    if (kind === 'group') {
      const val = SCEN.fleet === 'hobby' ? 'ldn' : 'fra';
      s.groups.push({ id: id, name: SCEN.fleet === 'hobby' ? 'Home servers' : 'Frankfurt production', kind: 'dynamic', query: [{ attr: 'region', op: 'is', val: val }], members: null, by: ANA, at: now() });
      s.changes.unshift({ who: ANA, ana: kind, what: 'created group <strong>' + s.groups[s.groups.length - 1].name + '</strong> (dynamic)', at: now() });
    } else if (kind === 'policy') {
      s.policies.push({ id: id, name: 'Monitoring essentials', template: 'monitoring', purpose: 'analytic', rules: { sample: 100, dropDebug: true, metricsOnly: true, redact: false }, by: ANA, at: now() });
      s.changes.unshift({ who: ANA, ana: kind, what: 'created policy <strong>Monitoring essentials</strong>', at: now() });
    } else {
      setAna(s, 'group', true); setAna(s, 'policy', true);
      s.destinations.push({ id: 'ana-dest', name: 'Splunk SIEM', type: 'Splunk', cls: 'internal', region: 'EU', by: ANA, at: now() });
      s.connectors.push({ id: id, name: 'Production to Splunk', group: 'ana-group', snaps: 'all', policy: 'ana-policy', dest: 'ana-dest', by: ANA, at: now() });
      s.changes.unshift({ who: ANA, ana: kind, what: 'activated connector <strong>Production to Splunk</strong> (' + s.groups.filter(function (g) { return g.id === 'ana-group'; })[0].name + ' → Splunk SIEM, Internal)', at: now() });
    }
  }
  let state;
  try { state = JSON.parse(localStorage.getItem(KEY)) || fresh(); } catch (e) { state = fresh(); }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* private mode */ } }
  function log(what) { state.changes.unshift({ who: ME, what: what, at: now() }); }
  function uid(p) { return p + '-' + Math.random().toString(36).slice(2, 8); }

  function devices() { return state.connected ? ALL : []; }
  function groupById(id) { return state.groups.filter(function (g) { return g.id === id; })[0]; }
  function policyById(id) { return state.policies.filter(function (p) { return p.id === id; })[0]; }
  function destById(id) { return state.destinations.filter(function (d) { return d.id === id; })[0]; }
  function groupDevices(g, q) {
    if (!g) return [];
    if (g.kind === 'static' && g.members) { const set = {}; g.members.forEach(function (m) { set[m] = 1; }); return devices().filter(function (d) { return set[d.id]; }); }
    return devices().filter(function (d) { return queryMatches(d, q || g.query); });
  }
  function connectorsUsing(gid) { return state.connectors.filter(function (c) { return c.group === gid; }); }
  function others() { return state.users.filter(function (u) { return u.name !== ME && u.status === 'active' && /Admin/.test(u.role); }); }

  // ---- Policies --------------------------------------------------------
  const TEMPLATES = [
    { id: 'cost', intent: 'cost', name: 'Reduce volume', desc: 'Sample routine events and drop debug logs before they leave.', rules: { sample: 50, dropDebug: true, metricsOnly: false, redact: false }, purpose: 'analytic' },
    { id: 'monitoring', intent: 'monitoring', name: 'Monitoring essentials', desc: 'Keep metrics and errors for your monitoring tool, drop the rest.', rules: { sample: 100, dropDebug: true, metricsOnly: true, redact: false }, purpose: 'analytic' },
    { id: 'compliance', intent: 'compliance', name: 'Redact personal data', desc: 'Remove usernames, IP addresses and hostnames before data leaves.', rules: { sample: 100, dropDebug: false, metricsOnly: false, redact: true }, purpose: 'regulatory' },
    { id: 'debug', intent: 'debug', name: 'Everything (debugging)', desc: 'Send everything unchanged. Best kept to a small group for a short time.', rules: { sample: 100, dropDebug: false, metricsOnly: false, redact: false }, purpose: 'debug' },
    { id: 'custom', intent: null, name: 'Start from scratch', desc: 'Choose each rule yourself.', rules: { sample: 100, dropDebug: false, metricsOnly: false, redact: false }, purpose: 'analytic' }
  ];
  function keepOf(p) {
    if (!p) return 1;
    const r = p.rules;
    return (r.sample / 100) * (r.dropDebug ? 0.72 : 1) * (r.metricsOnly ? 0.38 : 1) * (r.redact ? 0.97 : 1);
  }
  const PURPOSES = { analytic: 'Analytic', debug: 'Debug', regulatory: 'Regulatory' };

  // ---- Destinations ----------------------------------------------------
  const DEST_TYPES = ['Datadog', 'Splunk', 'Elastic', 'S3-compatible storage', 'OpenTelemetry (OTLP)', 'Kafka', 'Other'];
  const CLASSES = { internal: 'Internal', subsidiary: 'Subsidiary', partner: 'Partner', external: 'External', canonical: 'Canonical' };
  const REGIONS = ['EU', 'UK', 'US', 'APAC', 'Global'];
  function leaves(dest) { return dest && (dest.cls === 'external' || dest.cls === 'partner'); }

  // ---- Snaps (publishers) ---------------------------------------------
  // A device's snaps: its applications plus the Canonical snaps it runs.
  function deviceSnaps(d) {
    const out = snapsOf(d).slice();
    if (d.extras && d.extras.landscape) out.push('landscape');
    if (d.attrs.juju && d.attrs.juju !== 'none') out.push('juju');
    if (d.attrs.maas && d.attrs.maas !== 'none') out.push('maas');
    if (d.attrs.microcloud === 'member') out.push('microcloud');
    return out;
  }
  // The device's daily volume split across its snaps (Canonical snaps send less)
  const snapCache = {};
  function snapVols(d) {
    if (snapCache[d.id]) return snapCache[d.id];
    const list = deviceSnaps(d), w = {};
    let sum = 0;
    list.forEach(function (sn) { const v = (TL.valueOf('publisher', sn) || {}).canonical || sn === 'landscape' ? 0.15 : 0.5 + hash(d.id + sn); w[sn] = v; sum += v; });
    const tot = devVol(d), out = {};
    list.forEach(function (sn) { out[sn] = tot * w[sn] / sum; });
    return (snapCache[d.id] = out);
  }
  function connSnaps(c) { return !c.snaps || c.snaps === 'all' ? null : c.snaps; }
  function snapsText(c) { const l = connSnaps(c); return !l ? 'All snaps' : l.length === 1 ? snapLabel(l[0]) : l.length + ' snaps'; }
  function connVolume(group, snaps) {
    let v = 0;
    groupDevices(group).forEach(function (d) { const sv = snapVols(d); Object.keys(sv).forEach(function (sn) { if (!snaps || snaps.indexOf(sn) >= 0) v += sv[sn]; }); });
    return v;
  }

  // ---- Flows -----------------------------------------------------------
  // One fact per (device, snap, connector): kept volume to the destination, the rest to "Dropped by shaping".
  // Update traffic with the store comes from snapd on every device.
  function flows() {
    const facts = [];
    state.connectors.forEach(function (c) {
      const g = groupById(c.group), p = policyById(c.policy), k = keepOf(p), only = connSnaps(c);
      groupDevices(g).forEach(function (d) {
        if (c.canonical) { facts.push({ dev: d.id, grp: c.group, pub: '__snapd', pol: 'updates', dest: c.dest, count: STORE_VOL, kind: 'canonical', conn: c.id }); return; }
        const sv = snapVols(d);
        Object.keys(sv).forEach(function (sn) {
          if (only && only.indexOf(sn) < 0) return;
          const v = sv[sn], base = { dev: d.id, grp: c.group, pub: sn, pol: c.policy || 'none', conn: c.id };
          facts.push(Object.assign({ dest: c.dest, count: v * k, kind: 'customer' }, base));
          if (k < 1) facts.push(Object.assign({ dest: '__dropped', count: v * (1 - k), kind: 'dropped' }, base));
        });
      });
    });
    return facts;
  }
  function totals() {
    // fleet = data leaving devices: update traffic from every device, plus each snap's data once
    // if it is in at least one connector (a device's other snaps send nothing)
    const f = flows(), out = { fleet: 0, delivered: 0, dropped: 0, byDest: {}, byConn: {} }, seen = {};
    devices().forEach(function () { out.fleet += STORE_VOL; });
    f.forEach(function (x) {
      if (x.kind !== 'canonical') { const key = x.dev + '|' + x.pub; if (!seen[key]) { seen[key] = 1; out.fleet += snapVols(ALL_BY_ID[x.dev])[x.pub]; } }
      if (x.kind === 'dropped') out.dropped += x.count; else { out.delivered += x.count; out.byDest[x.dest] = (out.byDest[x.dest] || 0) + x.count; }
      out.byConn[x.conn] = (out.byConn[x.conn] || 0) + (x.kind === 'dropped' ? 0 : x.count);
    });
    return out;
  }
  function mb(v) {
    if (v >= 1e6) return (v / 1e6).toFixed(1) + ' TB';
    if (v >= 1e3) return (v / 1e3).toFixed(v >= 1e4 ? 0 : 1) + ' GB';
    return Math.round(v) + ' MB';
  }
  function n(v) { return Number(v).toLocaleString('en-GB'); }

  // ---- Onboarding ------------------------------------------------------
  const INTENTS = [
    { id: 'cost', label: 'Reduce data volume and storage cost' },
    { id: 'monitoring', label: 'Send data to a monitoring tool' },
    { id: 'compliance', label: 'Meet compliance obligations' },
    { id: 'debug', label: 'Debug devices' },
    { id: 'governance', label: 'Control who can change data flows' }
  ];
  function userGroups() { return state.groups.filter(function (g) { return !g.system; }); }
  function userConnectors() { return state.connectors.filter(function (c) { return !c.canonical; }); }
  const STEPS = [
    { id: 'connect', title: 'Connect your first device', route: null,
      why: 'Telemetry needs at least one device sending to it. Everything else depends on this.',
      done: function () { return state.connected; } },
    { id: 'about', title: 'About you', route: null,
      why: 'Tell us what you want to do first so the next steps start from the right templates.',
      done: function () { return state.aboutDone; } },
    { id: 'group', title: 'Choose which devices', route: 'groups',
      why: 'A group is a saved query, for example every device with at least 32 GB of RAM. It decides which devices a connector applies to, but on its own it sends nothing.',
      done: function () { return userGroups().length > 0 || state.useAll; },
      doneBy: function () { const g = userGroups()[0]; return g && g.by !== ME ? g.by : null; } },
    { id: 'policy', title: 'Shape the data', route: 'policies',
      why: 'A policy decides what leaves and in what form: sampling, dropping debug logs, redacting personal data.',
      done: function () { return state.policies.length > 0; },
      doneBy: function () { const p = state.policies[0]; return p && p.by !== ME ? p.by : null; } },
    { id: 'connector', title: 'Send data somewhere', route: 'connectors',
      why: 'A connector joins a group, a policy and a destination. This is the point where data leaves your devices.',
      done: function () { return userConnectors().length > 0; },
      doneBy: function () { const c = userConnectors()[0]; return c && c.by !== ME ? c.by : null; } },
    { id: 'flow', title: 'See it in Data flow', route: 'flow',
      why: 'Watch your data move from devices, through your policy, to its destination.',
      done: function () { return state.flowSeen; } }
  ];
  function currentStep() { return STEPS.filter(function (s) { return !s.done(); })[0] || null; }
  function setupComplete() { return !currentStep(); }
  function stepNo(id) { return STEPS.map(function (s) { return s.id; }).indexOf(id) + 1; }

  // ---- Router ----------------------------------------------------------
  const NAV = [
    { id: 'overview', label: 'Overview', icon: '⌂' },
    { id: 'groups', label: 'Groups', icon: '▦' },
    { id: 'policies', label: 'Policies', icon: '≡' },
    { id: 'connectors', label: 'Connectors', icon: '⇄' },
    { id: 'destinations', label: 'Destinations', icon: '◎' },
    { id: 'flow', label: 'Data flow', icon: '⇶' }
  ];
  function route() {
    const h = (location.hash || '#/overview').replace(/^#\//, '').split('?')[0].split('/');
    return { page: h[0] || 'overview', sub: h[1] || null };
  }
  function go(path) { location.hash = '#/' + path; }

  function renderNav(page) {
    $('nav-list').innerHTML = NAV.map(function (i) {
      const active = i.id === page;
      return '<li><a class="l-nav__item' + (active ? ' is-active' : '') + '" href="#/' + i.id + '"' + (active ? ' aria-current="page"' : '') + '>' +
        '<span class="l-nav__icon" aria-hidden="true">' + i.icon + '</span>' + i.label + '</a></li>';
    }).join('');
    document.querySelectorAll('.l-nav__list--bottom .l-nav__item').forEach(function (a) {
      const on = a.getAttribute('data-route') === page;
      a.classList.toggle('is-active', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    const cur = NAV.filter(function (i) { return i.id === page; })[0];
    $('topbar-page').textContent = cur ? cur.label : 'Settings';
  }

  function header(crumb, title, sub, actions) {
    return '<header class="p-page-header"><div><div class="p-breadcrumb">Telemetry / <strong>' + esc(crumb) + '</strong></div>' +
      '<h1 class="p-heading">' + esc(title) + '</h1>' + (sub ? '<p class="p-subtitle">' + sub + '</p>' : '') + '</div>' +
      (actions ? '<div class="ob-actions">' + actions + '</div>' : '') + '</header>';
  }

  // Banner on a real page while its onboarding step is open
  function banner(stepId) {
    if (setupComplete()) return '';
    const s = STEPS.filter(function (x) { return x.id === stepId; })[0];
    const cur = currentStep();
    if (!s || !state.connected) return '';
    const by = s.done() && s.doneBy && s.doneBy();
    if (s.done() && !by) return '';
    if (!by && cur.id !== stepId) return '';
    const total = STEPS.length;
    let body;
    if (by) {
      const what = stepId === 'group' ? 'A group already exists' : stepId === 'policy' ? 'A policy already exists' : 'A connector already exists';
      body = '<strong>' + what + ', created by ' + esc(by) + '.</strong> Use it or add your own.';
    } else if (stepId === 'group') {
      body = '<strong>Create your first group.</strong> Build a query, check which devices match, then save it as static or dynamic.' +
        (state.connected ? ' <button type="button" class="p-link" data-act="use-all">Or use All devices</button>' : '');
    } else if (stepId === 'policy') {
      body = '<strong>Create your first policy.</strong> Start from a template' + (state.primary ? ' (we put the ones for “' + esc(INTENTS.filter(function (i) { return i.id === state.primary; })[0].label.toLowerCase()) + '” first)' : '') + ' and check the data before and after.';
    } else if (stepId === 'connector') {
      body = '<strong>Create your first connector.</strong> Pick a group, a policy and a destination. The preview shows exactly what will leave before you activate it.';
    } else return '';
    return '<div class="ob-banner" role="region" aria-label="Onboarding">' +
      '<span class="ob-banner__step">Step ' + stepNo(stepId) + ' of ' + total + '</span>' +
      '<p class="ob-banner__text">' + body + '</p>' +
      '<div class="ob-banner__actions">' + (by ? '<a class="p-button p-button--small" href="#/overview">Continue</a>' : '') +
      '<a class="p-link" href="#/overview">Back to onboarding</a></div></div>';
  }

  // ---- Overview --------------------------------------------------------
  function pageOverview() {
    const done = setupComplete();
    let html = header('Overview', 'Overview', done ? 'What needs your attention across your fleet.' : null);
    if (!done) html += moduleOnboarding();
    else {
      if (!state.setupNoted) html += '<div class="ob-note"><p><strong>Setup complete.</strong> From now on this page shows what needs your attention. Onboarding is no longer listed.</p><button type="button" class="p-link" data-act="dismiss-setup">Dismiss</button></div>';
      html += '<div class="ob-grid">' + moduleTasks() + moduleInsights() + moduleChanges() + moduleDestHealth() + '</div>';
    }
    return html;
  }

  function moduleOnboarding() {
    const cur = currentStep();
    let html = '<section class="p-card ob-module ob-onboarding" aria-labelledby="ob-title">' +
      '<div class="ob-module__head"><h2 class="ob-module__title" id="ob-title">Get started</h2>' +
      '<span class="ob-progress">' + STEPS.filter(function (s) { return s.done(); }).length + ' of ' + STEPS.length + ' done</span></div>';
    if (J().joiner) html += '<p class="ob-intro"><strong>' + ANA + ' invited you and has started setting up.</strong> Steps someone else has done are marked with their name.</p>';
    if (!state.introSeen) html += '<p class="ob-intro">Your devices already get updates through the Canonical Snap Store. Nothing else leaves them until you set up a connector.</p>';
    html += '<ol class="ob-steps">';
    STEPS.forEach(function (s, i) {
      const isDone = s.done(), isCur = cur && cur.id === s.id;
      const by = isDone && s.doneBy && s.doneBy();
      const locked = !state.connected && i > 0;
      const status = isDone ? (by ? 'Done by ' + esc(by) : 'Done') : isCur ? 'Current step' : locked ? 'Needs a connected device' : 'To do';
      html += '<li class="ob-step' + (isDone ? ' is-done' : '') + (isCur ? ' is-current' : '') + (locked ? ' is-locked' : '') + '">' +
        '<span class="ob-step__num" aria-hidden="true">' + (isDone ? '✓' : i + 1) + '</span>' +
        '<div class="ob-step__main"><div class="ob-step__head"><h3 class="ob-step__title">' + esc(s.title) + '</h3><span class="ob-step__status">' + status + '</span></div>';
      if (isCur) {
        html += '<p class="ob-step__why">' + s.why + '</p>';
        if (s.id === 'connect') html += connectBody();
        else if (s.id === 'about') html += aboutBody();
        else html += '<div class="ob-step__cta"><a class="p-button p-button--positive" href="#/' + s.route + (s.id === 'connector' ? '/new' : '') + '">Take me there</a>' +
          (s.id === 'group' ? '<button type="button" class="p-button" data-act="use-all">Use All devices</button>' : '') + '</div>';
      }
      html += '</div></li>';
    });
    html += '</ol>';
    html += '<div class="ob-also"><span>You can also do these at any time:</span> <a class="p-link" href="#/settings">Invite colleagues</a> · <a class="p-link" href="#/destinations/new">Add a destination</a>' +
      (J().landscape ? '' : ' · <a class="p-link" href="#/settings">Link Landscape</a>') + '</div>';
    return html + '</section>';
  }

  let waiting = false;
  function connectBody() {
    if (waiting) return '<div class="ob-waiting" role="status"><span class="ob-spinner" aria-hidden="true"></span>Waiting for your first device…</div>';
    let html = '';
    if (J().landscape) {
      html += '<div class="ob-connect"><p><strong>Landscape knows ' + n(ALL.length) + ' devices.</strong> None of them send to telemetry yet. Point them at telemetry from Landscape in one step.</p>' +
        '<div class="ob-connect__row"><label class="p-field"><span class="p-field__label">Landscape group</span><select class="p-select" id="ls-group"><option>All devices (' + n(ALL.length) + ')</option></select></label>' +
        '<button type="button" class="p-button p-button--positive" data-act="connect">Point devices at telemetry</button></div></div>';
    } else {
      html += '<div class="ob-connect"><p>Run this on a device. Your organisation token is already filled in.</p>' +
        '<pre class="ob-code"><code>sudo snap set system telemetry.endpoint=telemetry.canonical.com \\\n  telemetry.token=tok_7f3a…c91e</code></pre>' +
        '<p class="ob-hint">Placeholder command: the real mechanism is for engineering to confirm.</p>' +
        '<button type="button" class="p-button" data-act="connect">Simulate a device connecting</button></div>';
    }
    html += '<details class="ob-diag"><summary>Devices should already be connected?</summary>' +
      '<ol class="ob-diag__list">' +
      (J().rejected ? '<li><span class="p-badge p-badge--negative">Seen</span> <strong>12 connection attempts rejected in the last hour.</strong> The token belongs to another organisation (acme-labs). Check which token your devices use.</li>' : '') +
      (J().landscape && J().optedOut ? '<li><span class="p-badge">Seen</span> <strong>3 devices in Landscape have opted out of telemetry.</strong> That is their choice, not a fault, and they keep getting updates.</li>' : '') +
      '<li><strong>Network.</strong> A proxy, firewall or allowlist may be blocking telemetry.canonical.com.</li>' +
      '<li><strong>Snap version.</strong> Devices need a recent snapd to send telemetry.</li>' +
      '<li><strong>Certificates or clock.</strong> A device with the wrong time fails the TLS check.</li></ol></details>';
    return html;
  }

  function aboutBody() {
    const sel = state.intents;
    let html = '<fieldset class="ob-intents"><legend class="p-field__label">What do you want to do? Choose any.</legend>';
    INTENTS.forEach(function (i) {
      const on = sel.indexOf(i.id) >= 0;
      html += '<label class="ob-chip' + (on ? ' is-on' : '') + '"><input type="checkbox" value="' + i.id + '" data-act="intent"' + (on ? ' checked' : '') + '> ' + esc(i.label) + '</label>';
    });
    html += '</fieldset>';
    if (sel.length > 1) {
      html += '<fieldset class="ob-intents"><legend class="p-field__label">Which comes first?</legend>';
      sel.forEach(function (id) {
        const i = INTENTS.filter(function (x) { return x.id === id; })[0];
        html += '<label class="ob-radio"><input type="radio" name="primary" value="' + id + '" data-act="primary"' + (state.primary === id ? ' checked' : '') + '> ' + esc(i.label) + '</label>';
      });
      html += '</fieldset>';
    }
    if (sel.indexOf('governance') >= 0) html += '<p class="ob-hint">Approvals for data flows come in a later release. For now every change is logged and other admins are notified.</p>';
    html += '<div class="ob-step__cta"><button type="button" class="p-button p-button--positive" data-act="about-save"' + (sel.length ? '' : ' disabled') + '>Continue</button>' +
      '<button type="button" class="p-link" data-act="about-skip">Skip</button></div>';
    return html;
  }

  function insightsList() {
    const t = totals(), out = [];
    if (!state.skipAhead) return out;
    // Uses the Data flow filters: Show me sets View (Device health), Group devices by (Site) and traces the destination
    const sick = {}, toDest = {};
    flows().forEach(function (f) {
      if (f.kind !== 'customer') return;
      const a = latestAttrs(f.dev);
      if (a.healthScore < 60) { sick[f.dev] = a.site; toDest[f.dest] = (toDest[f.dest] || 0) + f.count; }
    });
    const sickIds = Object.keys(sick);
    if (sickIds.length) {
      const dest = Object.keys(toDest).sort(function (a, b) { return toDest[b] - toDest[a]; })[0];
      const bySite = {}; sickIds.forEach(function (id) { bySite[sick[id]] = (bySite[sick[id]] || 0) + 1; });
      const site = Object.keys(bySite).sort(function (a, b) { return bySite[b] - bySite[a]; })[0];
      out.push({ id: 'health', who: 'SRE', title: n(sickIds.length) + ' device' + (sickIds.length > 1 ? 's' : '') + ' with health below 60 send ' + mb(toDest[dest] * 7) + ' a week to ' + destById(dest).name,
        body: (sickIds.length === 1 ? 'It' : bySite[site] === sickIds.length ? 'All of them' : bySite[site] + ' of them') + (site === 'unassigned' ? (bySite[site] === 1 ? ' has' : ' have') + ' no site assigned' : (bySite[site] === 1 ? ' is' : ' are') + ' at ' + esc(attrLabel('site', site))) + '. Their data may be noise from failing hardware rather than signal.',
        show: 'flow?show=health', flow: { view: 'health', dev: 'site', dest: 'none', select: 'ob_dest:' + dest } });
    }
    const shaped = state.connectors.filter(function (c) { return !c.canonical && keepOf(policyById(c.policy)) < 1; });
    if (shaped.length) out.push({ who: 'Platform', title: 'Shaping keeps ' + mb(t.dropped * 7) + ' a week out of your destinations', body: 'Across ' + shaped.length + ' connector' + (shaped.length > 1 ? 's' : '') + '. Your destinations bill by volume.', show: 'flow' });
    const dyn = state.connectors.filter(function (c) { const g = groupById(c.group); return !c.canonical && g && g.kind === 'dynamic' && !g.system; })[0];
    if (dyn) { const g = groupById(dyn.group); out.push({ who: 'Compliance', title: '3 devices joined “' + g.name + '” this week', body: 'It is a dynamic group, so their data now goes to ' + esc(destById(dyn.dest).name) + ' too.', show: 'groups/' + g.id }); }
    const scoped = {}; userConnectors().forEach(function (c) { groupDevices(groupById(c.group)).forEach(function (d) { scoped[d.id] = 1; }); });
    const unscoped = devices().filter(function (d) { return !scoped[d.id]; }).length;
    if (unscoped) out.push({ who: 'Platform', title: n(unscoped) + ' device' + (unscoped > 1 ? 's' : '') + ' only send update traffic', body: 'They are not in any connector’s group, so nothing but store check-ins leaves them.', show: 'flow' });
    const fan = {}; userConnectors().forEach(function (c) { groupDevices(groupById(c.group)).forEach(function (d) { fan[d.id] = (fan[d.id] || 0) + 1; }); });
    const multi = Object.keys(fan).filter(function (k) { return fan[k] > 1; }).length;
    if (multi) out.push({ who: 'Platform', title: n(multi) + ' devices send to more than one destination', body: 'Each packet is delivered to every matching destination and billed by each.', show: 'flow' });
    return out;
  }
  function moduleInsights() {
    const list = insightsList();
    let body;
    if (!state.skipAhead) body = '<p class="ob-empty">Your first insights appear after about 24 hours of data.</p><button type="button" class="p-link ob-demo" data-act="skip-ahead">Demo: skip ahead 7 days</button>';
    else if (!list.length) body = '<p class="ob-empty">Nothing unusual this week.</p>';
    else body = '<ul class="ob-list">' + list.map(function (i) {
      return '<li class="ob-insight"><span class="p-badge">' + i.who + '</span><div><strong>' + esc(i.title) + '</strong><p>' + i.body + '</p></div><a class="p-link" href="#/' + i.show + '">Show me</a></li>';
    }).join('') + '</ul>';
    return '<section class="p-card ob-module"><div class="ob-module__head"><h2 class="ob-module__title">Insights</h2>' + (list.length ? '<span class="ob-progress">' + list.length + '</span>' : '') + '</div>' + body + '</section>';
  }
  function tasksList() {
    const out = [];
    state.destinations.forEach(function (d) { if (isDegraded(d)) out.push({ sev: 'negative', title: esc(d.name) + ' is rate-limiting deliveries', body: '3% of deliveries are retried. Check its plan limits.', href: '#/destinations' }); });
    state.users.filter(function (u) { return u.status === 'invited'; }).forEach(function (u) { out.push({ sev: 'caution', title: esc(u.email) + ' hasn’t accepted the invitation', body: 'Invited as ' + esc(u.role) + '.', href: '#/settings' }); });
    return out;
  }
  function moduleTasks() {
    const list = tasksList();
    return '<section class="p-card ob-module"><div class="ob-module__head"><h2 class="ob-module__title">Tasks</h2>' + (list.length ? '<span class="ob-progress">' + list.length + '</span>' : '') + '</div>' +
      (list.length ? '<ul class="ob-list">' + list.map(function (t) {
        return '<li class="ob-task"><span class="ob-dot ob-dot--' + t.sev + '" aria-hidden="true"></span><div><strong>' + t.title + '</strong><p>' + t.body + '</p></div><a class="p-link" href="' + t.href + '">Open</a></li>';
      }).join('') + '</ul>' : '<p class="ob-empty">Nothing needs you right now.</p>') +
      '<p class="ob-hint">Approvals and access requests will appear here once governance is available.</p></section>';
  }
  function ago(iso) {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    return s < 60 ? 'just now' : s < 3600 ? Math.round(s / 60) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' d ago';
  }
  function moduleChanges() {
    const list = state.changes.slice(0, 6);
    return '<section class="p-card ob-module"><div class="ob-module__head"><h2 class="ob-module__title">Recent changes</h2></div>' +
      (list.length ? '<ul class="ob-list ob-changes">' + list.map(function (c) {
        return '<li><span class="l-nav__avatar ob-avatar" aria-hidden="true">' + initials(c.who) + '</span><p><strong>' + esc(c.who) + '</strong> ' + c.what + ' <span class="ob-time">' + ago(c.at) + '</span></p></li>';
      }).join('') + '</ul>' : '<p class="ob-empty">No changes yet.</p>') + '</section>';
  }
  function initials(name) { return name.split(' ').map(function (p) { return p[0]; }).join('').slice(0, 2).toUpperCase(); }
  // Jig: the first of your destinations is rate-limiting, so the Tasks module has something to show
  function isDegraded(d) { return J().degraded && !d.canonical && d === state.destinations.filter(function (x) { return !x.canonical; })[0]; }
  function healthBadge(d) {
    if (d.canonical) return '<span class="p-badge p-badge--positive">Healthy</span>';
    return isDegraded(d) ? '<span class="p-badge p-badge--caution">Degraded</span>' : '<span class="p-badge p-badge--positive">Healthy</span>';
  }
  function moduleDestHealth() {
    return '<section class="p-card ob-module"><div class="ob-module__head"><h2 class="ob-module__title">Destination health</h2><a class="p-link" href="#/destinations">All destinations</a></div>' +
      '<ul class="ob-list">' + state.destinations.map(function (d) {
        return '<li class="ob-dest"><span>' + (d.canonical ? '<span class="ob-tag" aria-hidden="true"></span>' : '') + esc(d.name) + '</span>' + healthBadge(d) + '</li>';
      }).join('') + '</ul></section>';
  }

  // ---- Groups ----------------------------------------------------------
  let gdraft = null;
  function pageGroups(sub) {
    if (sub) return pageGroupForm(sub);
    const shared = J().landscape ? ' Groups are shared with Landscape: editing one in either place updates both.' : '';
    let html = header('Groups', 'Groups', 'Saved queries that decide which devices a connector applies to. A group sends nothing on its own.' + shared,
      state.connected ? '<a class="p-button p-button--positive" href="#/groups/new">Create group</a>' : '');
    html += banner('group');
    if (!state.connected) return html + emptyNoDevices();
    html += '<div class="p-card ob-table-wrap"><table class="ob-table"><thead><tr><th>Name</th><th>Type</th><th>Query</th><th class="num">Devices</th><th>Used by</th><th>Created by</th></tr></thead><tbody>';
    state.groups.forEach(function (g) {
      const used = connectorsUsing(g.id);
      html += '<tr><td><a href="#/groups/' + g.id + '">' + esc(g.name) + '</a>' + (g.system ? ' <span class="p-badge">Default</span>' : '') + '</td>' +
        '<td>' + (g.kind === 'static' ? 'Static' : 'Dynamic') + '</td><td class="ob-muted">' + esc(g.kind === 'static' ? 'Fixed list (from: ' + queryText(g.query) + ')' : queryText(g.query)) + '</td>' +
        '<td class="num">' + n(groupDevices(g).length) + '</td><td>' + (used.length ? used.length + ' connector' + (used.length > 1 ? 's' : '') : '<span class="ob-muted">Not used</span>') + '</td><td>' + esc(g.by) + '</td></tr>';
    });
    return html + '</tbody></table></div>';
  }
  function emptyNoDevices() {
    return '<div class="p-card ob-emptycard"><h2>No devices connected yet</h2><p>Connect at least one device first. Groups, policies and connectors all need devices to work with.</p><a class="p-button p-button--positive" href="#/overview">Connect a device</a></div>';
  }
  function pageGroupForm(id) {
    const g = id === 'new' ? null : groupById(id);
    if (id !== 'new' && !g) return header('Groups', 'Group not found', null);
    if (!gdraft || gdraft.id !== id) {
      gdraft = g ? { id: id, name: g.name, kind: g.kind, query: JSON.parse(JSON.stringify(g.query)), orig: g }
        : { id: 'new', name: '', kind: 'dynamic', query: [{ attr: 'ram', op: 'gte', val: '32' }] };
    }
    const ro = g && g.system;
    let html = header('Groups', g ? g.name : 'Create group', g ? null : 'Build a query, check which devices match, then save it.');
    html += banner('group');
    if (!state.connected) return html + emptyNoDevices();
    html += '<div class="ob-form-layout"><form class="p-card ob-form" id="group-form" novalidate>';
    if (ro) html += '<p class="ob-hint">This is the default group. It always contains every connected device and can’t be changed.</p>';
    else {
      html += '<label class="ob-label" for="g-name">Name</label><input class="ob-input" id="g-name" value="' + esc(gdraft.name) + '" placeholder="For example: Large servers" autocomplete="off"><p class="ob-error" id="g-name-err" hidden>Give the group a name.</p>';
      html += '<div class="ob-label">Devices where</div><div id="q-rows">' + queryRows() + '</div>' +
        '<button type="button" class="p-link" data-act="q-add">+ Add condition</button>';
      html += '<fieldset class="ob-kind"><legend class="ob-label">Membership</legend>' +
        '<label class="ob-radio-card' + (gdraft.kind === 'dynamic' ? ' is-on' : '') + '"><input type="radio" name="kind" value="dynamic"' + (gdraft.kind === 'dynamic' ? ' checked' : '') + '> <span><strong>Dynamic</strong>These devices and any device that matches later are added automatically.</span></label>' +
        '<label class="ob-radio-card' + (gdraft.kind === 'static' ? ' is-on' : '') + '"><input type="radio" name="kind" value="static"' + (gdraft.kind === 'static' ? ' checked' : '') + '> <span><strong>Static</strong>Exactly these devices. New devices are never added, and members stay even if they stop matching.</span></label></fieldset>';
      if (J().landscape) html += '<p class="ob-hint">This group is shared with Landscape. Editing it in either place updates both.</p>';
      html += '<div class="ob-form__actions"><a class="p-button" href="#/groups">Cancel</a><button type="submit" class="p-button p-button--positive">' + (g ? 'Save changes' : 'Save group') + '</button></div>';
    }
    html += '</form><aside class="p-card ob-preview" id="g-preview" aria-live="polite">' + groupPreview() + '</aside></div>';
    return html;
  }
  function queryRows() {
    return gdraft.query.map(function (r, i) {
      const a = QA[r.attr];
      const ops = a.numeric ? ['gte', 'lte'] : ['is', 'isnot'];
      let val;
      if (a.numeric) val = '<input class="ob-input ob-input--num" type="number" min="1" data-q="val" data-i="' + i + '" value="' + esc(r.val) + '" aria-label="Value in GB">';
      else val = '<select class="p-select" data-q="val" data-i="' + i + '" aria-label="Value">' + a.values.map(function (v) { return '<option value="' + esc(v.id) + '"' + (String(v.id) === String(r.val) ? ' selected' : '') + '>' + esc(v.label) + '</option>'; }).join('') + '</select>';
      return '<div class="ob-qrow"><select class="p-select" data-q="attr" data-i="' + i + '" aria-label="Attribute">' +
        QATTRS.map(function (x) { return '<option value="' + x.id + '"' + (x.id === r.attr ? ' selected' : '') + '>' + esc(x.label) + '</option>'; }).join('') + '</select>' +
        '<select class="p-select" data-q="op" data-i="' + i + '" aria-label="Operator">' + ops.map(function (o) { return '<option value="' + o + '"' + (o === r.op ? ' selected' : '') + '>' + (a.snap ? (o === 'isnot' ? 'excludes' : 'includes') : OPS[o]) + '</option>'; }).join('') + '</select>' +
        val + '<button type="button" class="p-icon-button" data-act="q-del" data-i="' + i + '" aria-label="Remove condition"' + (gdraft.query.length < 2 ? ' disabled' : '') + '>✕</button></div>';
    }).join('');
  }
  function groupPreview() {
    const g = gdraft.orig;
    const list = g && g.system ? devices() : devices().filter(function (d) { return queryMatches(d, gdraft.query); });
    let html = '<h2 class="ob-preview__title">Matches ' + n(list.length) + ' device' + (list.length === 1 ? '' : 's') + '</h2>';
    if (!g || !g.system) html += '<p class="ob-muted">' + (gdraft.kind === 'dynamic' ? 'Plus any device that matches later.' : 'Saved as this exact list.') + '</p>';
    html += '<ul class="ob-devlist">' + list.slice(0, 8).map(function (d) {
      return '<li><span>' + esc(d.id) + '</span><span class="ob-muted">' + esc(attrLabel('type', d.attrs.type)) + ' · ' + ram(d) + ' GB</span></li>';
    }).join('') + '</ul>' + (list.length > 8 ? '<p class="ob-muted">and ' + n(list.length - 8) + ' more</p>' : '') +
      (!list.length ? '<p class="ob-muted">No connected device matches. A dynamic group will pick devices up when they do.</p>' : '');
    if (g) {
      const used = connectorsUsing(g.id), ext = used.filter(function (c) { return leaves(destById(c.dest)); });
      const before = groupDevices(g).length;
      html += '<div class="ob-impact"><h3>Used by ' + used.length + ' connector' + (used.length === 1 ? '' : 's') + (ext.length ? ', ' + ext.length + ' external' : '') + '</h3>' +
        (used.length ? '<ul>' + used.map(function (c) { return '<li>' + esc(c.name) + ' → ' + esc(destById(c.dest).name) + '</li>'; }).join('') + '</ul>' : '') +
        (!g.system && used.length && before !== list.length ? '<p><strong>Saving changes the devices in scope from ' + n(before) + ' to ' + n(list.length) + '.</strong> That changes what these connectors send.</p>' : '') + '</div>';
    } else html += '<p class="ob-hint">A group doesn’t send data anywhere. Data only moves when a connector uses it.</p>';
    return html;
  }
  function saveGroup() {
    const name = gdraft.name.trim();
    if (!name) { $('g-name-err').hidden = false; $('g-name').focus(); return; }
    const members = gdraft.kind === 'static' ? devices().filter(function (d) { return queryMatches(d, gdraft.query); }).map(function (d) { return d.id; }) : null;
    if (gdraft.orig) {
      const g = gdraft.orig; g.name = name; g.kind = gdraft.kind; g.query = gdraft.query; g.members = members;
      log('edited group <strong>' + esc(name) + '</strong>');
    } else {
      state.groups.push({ id: uid('g'), name: name, kind: gdraft.kind, query: gdraft.query, members: members, by: ME, at: now() });
      log('created group <strong>' + esc(name) + '</strong> (' + gdraft.kind + ')');
    }
    gdraft = null; save(); toast('Group saved');
    go(setupComplete() ? 'groups' : 'overview');
  }

  // ---- Policies --------------------------------------------------------
  let pdraft = null;
  function pagePolicies(sub) {
    if (sub) return pagePolicyForm(sub);
    let html = header('Policies', 'Policies', 'Rules that shape data before it reaches a destination.', state.connected ? '<a class="p-button p-button--positive" href="#/policies/new">Create policy</a>' : '');
    html += banner('policy');
    if (!state.connected) return html + emptyNoDevices();
    if (!state.policies.length) return html + '<div class="p-card ob-emptycard"><h2>No policies yet</h2><p>Without a policy a connector sends data unchanged.</p><a class="p-button p-button--positive" href="#/policies/new">Create policy</a></div>';
    html += '<div class="p-card ob-table-wrap"><table class="ob-table"><thead><tr><th>Name</th><th>Purpose</th><th>Effect</th><th>Used by</th><th>Created by</th></tr></thead><tbody>';
    state.policies.forEach(function (p) {
      const used = state.connectors.filter(function (c) { return c.policy === p.id; }).length;
      html += '<tr><td><a href="#/policies/' + p.id + '">' + esc(p.name) + '</a></td><td>' + PURPOSES[p.purpose] + '</td><td>Keeps about ' + Math.round(keepOf(p) * 100) + '% of volume</td>' +
        '<td>' + (used ? used + ' connector' + (used > 1 ? 's' : '') : '<span class="ob-muted">Not used</span>') + '</td><td>' + esc(p.by) + '</td></tr>';
    });
    return html + '</tbody></table></div>';
  }
  function sortedTemplates() {
    const prim = state.primary || state.intents[0];
    const pref = prim === 'governance' ? 'compliance' : prim;
    return TEMPLATES.slice().sort(function (a, b) {
      const sa = a.intent === pref ? 0 : state.intents.indexOf(a.intent) >= 0 ? 1 : a.id === 'custom' ? 3 : 2;
      const sb = b.intent === pref ? 0 : state.intents.indexOf(b.intent) >= 0 ? 1 : b.id === 'custom' ? 3 : 2;
      return sa - sb;
    });
  }
  function pagePolicyForm(id) {
    const p = id === 'new' ? null : policyById(id);
    if (id !== 'new' && !p) return header('Policies', 'Policy not found', null);
    if (!pdraft || pdraft.id !== id) pdraft = p ? { id: id, name: p.name, template: p.template, purpose: p.purpose, rules: Object.assign({}, p.rules), orig: p } : { id: 'new', template: null };
    let html = header('Policies', p ? p.name : 'Create policy', p ? null : 'Start from a template, then adjust the rules.');
    html += banner('policy');
    if (!state.connected) return html + emptyNoDevices();
    if (!pdraft.template) {
      const prim = state.primary || state.intents[0];
      html += '<div class="ob-templates">' + sortedTemplates().map(function (t, i) {
        const rec = i === 0 && t.intent && (t.intent === prim || (prim === 'governance' && t.intent === 'compliance'));
        return '<button type="button" class="p-card ob-template" data-act="tpl" data-id="' + t.id + '">' + (rec ? '<span class="p-badge p-badge--positive">Matches what you told us</span>' : '') +
          '<strong>' + esc(t.name) + '</strong><span>' + esc(t.desc) + '</span></button>';
      }).join('') + '</div>';
      return html;
    }
    const r = pdraft.rules;
    html += '<div class="ob-form-layout"><form class="p-card ob-form" id="policy-form" novalidate>' +
      '<label class="ob-label" for="p-name">Name</label><input class="ob-input" id="p-name" value="' + esc(pdraft.name) + '" autocomplete="off"><p class="ob-error" id="p-name-err" hidden>Give the policy a name.</p>' +
      '<label class="ob-label" for="p-purpose">Purpose</label><select class="p-select" id="p-purpose">' + Object.keys(PURPOSES).map(function (k) { return '<option value="' + k + '"' + (k === pdraft.purpose ? ' selected' : '') + '>' + PURPOSES[k] + '</option>'; }).join('') + '</select>' +
      '<p class="ob-hint">Purpose is recorded with the policy. Later it decides who has to approve changes.</p>' +
      '<div class="ob-label">Rules</div>' +
      '<label class="ob-range"><span>Sample routine events: keep <strong id="p-sample-v">' + r.sample + '%</strong></span><input type="range" min="5" max="100" step="5" id="p-sample" value="' + r.sample + '"></label>' +
      '<label class="ob-check"><input type="checkbox" id="p-dropDebug"' + (r.dropDebug ? ' checked' : '') + '> Drop debug logs</label>' +
      '<label class="ob-check"><input type="checkbox" id="p-metricsOnly"' + (r.metricsOnly ? ' checked' : '') + '> Keep metrics and errors only</label>' +
      '<label class="ob-check"><input type="checkbox" id="p-redact"' + (r.redact ? ' checked' : '') + '> Redact personal data (usernames, IP addresses, hostnames)</label>' +
      '<div class="ob-form__actions">' + (p ? '' : '<button type="button" class="p-button" data-act="tpl-back">Change template</button>') + '<a class="p-button" href="#/policies">Cancel</a><button type="submit" class="p-button p-button--positive">' + (p ? 'Save changes' : 'Save policy') + '</button></div>' +
      '</form><aside class="p-card ob-preview" id="p-preview" aria-live="polite">' + policyPreview() + '</aside></div>';
    return html;
  }
  function samplePayload(after) {
    const r = pdraft.rules;
    const ev = [
      { kind: 'metric', line: '{ "snap": "order-service", "type": "metric", "cpu": 0.42, "mem_mb": 812, "host": "nyc-dc-01", "user": "svc-orders", "ip": "10.4.2.17" }' },
      { kind: 'debug', line: '{ "snap": "order-service", "type": "debug", "msg": "cache warm 118 keys", "host": "nyc-dc-01" }' },
      { kind: 'error', line: '{ "snap": "order-service", "type": "error", "code": "E_TIMEOUT", "host": "nyc-dc-01", "ip": "10.4.2.17" }' },
      { kind: 'event', line: '{ "snap": "order-service", "type": "event", "name": "order.created", "user": "a.martin", "host": "nyc-dc-01" }' }
    ];
    return ev.filter(function (e) {
      if (!after) return true;
      if (r.dropDebug && e.kind === 'debug') return false;
      if (r.metricsOnly && (e.kind === 'event' || e.kind === 'debug')) return false;
      return true;
    }).map(function (e) {
      let l = e.line;
      if (after && r.redact) l = l.replace(/"host": "[^"]+"/, '"host": "[redacted]"').replace(/"user": "[^"]+"/, '"user": "[redacted]"').replace(/"ip": "[^"]+"/, '"ip": "[redacted]"');
      if (after && r.sample < 100 && e.kind === 'event') l += '   ← ' + r.sample + '% sampled';
      return l;
    }).join('\n');
  }
  function policyPreview() {
    const k = keepOf(pdraft);
    return '<h2 class="ob-preview__title">Keeps about ' + Math.round(k * 100) + '% of volume</h2>' +
      '<p class="ob-muted">Example from order-service on nyc-dc-01.</p>' +
      '<div class="ob-label">Before</div><pre class="ob-code ob-code--small"><code>' + esc(samplePayload(false)) + '</code></pre>' +
      '<div class="ob-label">After</div><pre class="ob-code ob-code--small"><code>' + esc(samplePayload(true) || '(nothing is sent)') + '</code></pre>';
  }
  function savePolicy() {
    const name = (pdraft.name || '').trim();
    if (!name) { $('p-name-err').hidden = false; $('p-name').focus(); return; }
    if (pdraft.orig) { Object.assign(pdraft.orig, { name: name, purpose: pdraft.purpose, rules: pdraft.rules }); log('edited policy <strong>' + esc(name) + '</strong>'); }
    else { state.policies.push({ id: uid('p'), name: name, template: pdraft.template, purpose: pdraft.purpose, rules: pdraft.rules, by: ME, at: now() }); log('created policy <strong>' + esc(name) + '</strong>'); }
    pdraft = null; save(); toast('Policy saved');
    go(setupComplete() ? 'policies' : 'overview');
  }

  // ---- Destinations form (shared by the page and the connector) -------
  function destFields(dd, prefix) {
    return '<label class="ob-label" for="' + prefix + 'type">Type</label><select class="p-select" id="' + prefix + 'type">' + DEST_TYPES.map(function (t) { return '<option' + (t === dd.type ? ' selected' : '') + '>' + t + '</option>'; }).join('') + '</select>' +
      '<label class="ob-label" for="' + prefix + 'name">Name</label><input class="ob-input" id="' + prefix + 'name" value="' + esc(dd.name || '') + '" placeholder="For example: Datadog EU production" autocomplete="off"><p class="ob-error" id="' + prefix + 'name-err" hidden>Give the destination a name.</p>' +
      '<label class="ob-label" for="' + prefix + 'endpoint">Endpoint</label><input class="ob-input" id="' + prefix + 'endpoint" value="' + esc(dd.endpoint || '') + '" placeholder="https://" autocomplete="off">' +
      '<fieldset class="ob-cls"><legend class="ob-label">Who receives this data?</legend>' + ['internal', 'subsidiary', 'partner', 'external'].map(function (c) {
        return '<label class="ob-radio"><input type="radio" name="' + prefix + 'cls" value="' + c + '"' + (dd.cls === c ? ' checked' : '') + '> ' + CLASSES[c] + '</label>';
      }).join('') + '</fieldset><p class="ob-hint">Recorded with the destination for audit. Later it decides which changes need approval.</p>' +
      '<label class="ob-label" for="' + prefix + 'region">Region</label><select class="p-select" id="' + prefix + 'region">' + REGIONS.map(function (r) { return '<option' + (r === dd.region ? ' selected' : '') + '>' + r + '</option>'; }).join('') + '</select>';
  }
  function readDest(prefix, dd) {
    dd.type = $(prefix + 'type').value; dd.name = $(prefix + 'name').value; dd.endpoint = $(prefix + 'endpoint').value; dd.region = $(prefix + 'region').value;
    const c = document.querySelector('input[name="' + prefix + 'cls"]:checked'); dd.cls = c ? c.value : dd.cls;
  }
  function newDest(dd) {
    const d = { id: uid('d'), name: dd.name.trim(), type: dd.type, endpoint: dd.endpoint, cls: dd.cls, region: dd.region, by: ME, at: now() };
    state.destinations.push(d); log('added destination <strong>' + esc(d.name) + '</strong> (' + CLASSES[d.cls] + ')');
    return d;
  }

  function pageDestinations(sub) {
    if (sub === 'new') {
      if (!ddraft) ddraft = { type: 'Datadog', name: '', endpoint: '', cls: 'external', region: 'EU' };
      return header('Destinations', 'Add destination', 'Add it now and use it in a connector later. Nothing is sent until a connector uses it.') +
        '<form class="p-card ob-form ob-form--narrow" id="dest-form" novalidate>' + destFields(ddraft, 'd-') +
        '<div class="ob-form__actions"><a class="p-button" href="#/destinations">Cancel</a><button type="submit" class="p-button p-button--positive">Add destination</button></div></form>';
    }
    const t = totals();
    let html = header('Destinations', 'Destinations', 'Where your fleet’s data goes. One glance for audit, without the detail of Data flow.', '<a class="p-button p-button--positive" href="#/destinations/new">Add destination</a>');
    html += '<div class="p-card ob-table-wrap"><table class="ob-table"><thead><tr><th>Name</th><th>Type</th><th>Receiver</th><th>Region</th><th class="num">Share of data leaving devices <span class="ob-info" title="A device can send to several destinations, so shares can add up to more than 100%.">ⓘ</span></th><th class="num">Volume / day</th><th>Connectors</th><th class="num">Devices in scope</th><th>Health</th></tr></thead><tbody>';
    state.destinations.forEach(function (d) {
      const conns = state.connectors.filter(function (c) { return c.dest === d.id; });
      const scope = {}; conns.forEach(function (c) { groupDevices(groupById(c.group)).forEach(function (x) { scope[x.id] = 1; }); });
      const vol = t.byDest[d.id] || 0;
      html += '<tr><td>' + (d.canonical ? '<span class="ob-tag" aria-hidden="true"></span>' : '') + esc(d.name) + (d.canonical ? ' <span class="p-badge">Two-way</span>' : '') + '</td><td>' + esc(d.type) + '</td>' +
        '<td>' + CLASSES[d.cls] + '</td><td>' + esc(d.region) + '</td><td class="num">' + (t.fleet ? S.pct(vol, t.fleet) + '%' : '–') + '</td><td class="num">' + (vol ? mb(vol) : '–') + '</td>' +
        '<td>' + (conns.length ? conns.map(function (c) { return esc(c.name); }).join(', ') : '<span class="ob-muted">None</span>') + '</td><td class="num">' + n(Object.keys(scope).length) + '</td><td>' + healthBadge(d) + '</td></tr>';
    });
    html += '</tbody></table></div><p class="ob-hint">Share of data leaving devices: a device can send to several destinations, so the shares can add up to more than 100%. The Canonical Snap Store carries update traffic both ways.</p>';
    return html;
  }
  let ddraft = null;

  // ---- Connectors ------------------------------------------------------
  let cdraft = null;
  function pageConnectors(sub) {
    if (sub === 'new') return pageConnectorForm();
    let html = header('Connectors', 'Connectors', 'A connector sends data from a group’s snaps, shaped by a policy, to a destination.', state.connected ? '<a class="p-button p-button--positive" href="#/connectors/new">Create connector</a>' : '');
    html += banner('connector');
    const t = totals();
    html += '<div class="p-card ob-table-wrap"><table class="ob-table"><thead><tr><th>Name</th><th>Group</th><th>Snaps</th><th>Policy</th><th>Destination</th><th class="num">Volume / day</th><th>Status</th><th>Created by</th></tr></thead><tbody>';
    state.connectors.forEach(function (c) {
      const g = groupById(c.group), p = policyById(c.policy), d = destById(c.dest);
      html += '<tr><td>' + (c.canonical ? '<span class="ob-tag" aria-hidden="true"></span>' : '') + esc(c.name) + (c.canonical ? ' <span class="p-badge">Default</span>' : '') + '</td>' +
        '<td>' + esc(g.name) + ' <span class="ob-muted">(' + n(groupDevices(g).length) + ')</span></td><td>' + (c.canonical ? '<span class="ob-muted">snapd (updates)</span>' : esc(snapsText(c))) + '</td><td>' + (p ? esc(p.name) : '<span class="ob-muted">' + (c.canonical ? 'Update traffic' : 'No shaping') + '</span>') + '</td>' +
        '<td>' + esc(d.name) + ' <span class="ob-muted">· ' + CLASSES[d.cls] + '</span></td><td class="num">' + (t.byConn[c.id] ? mb(t.byConn[c.id]) : '–') + '</td>' +
        '<td><span class="p-badge p-badge--positive">Active</span></td><td>' + (c.canonical ? '<span class="ob-muted" title="Can be replaced with another store, not removed">🔒 System</span>' : esc(c.by)) + '</td></tr>';
    });
    html += '</tbody></table></div><p class="ob-hint">The Updates connector keeps devices getting security updates. It can be replaced with your own store, not removed.</p>';
    return html;
  }
  function pageConnectorForm() {
    let html = header('Connectors', 'Create connector', 'Choose which devices and snaps, how the data is shaped and where it goes.');
    html += banner('connector');
    if (!state.connected) return html + emptyNoDevices();
    if (!cdraft) {
      const ug = userGroups(), lastDest = state.destinations.filter(function (d) { return !d.canonical; }).slice(-1)[0];
      cdraft = { name: '', snapsMode: 'all', snaps: [], group: (ug.slice(-1)[0] || groupById('all')).id, policy: state.policies.length ? state.policies.slice(-1)[0].id : '', dest: lastDest ? lastDest.id : '__new',
        nd: { type: 'Datadog', name: '', endpoint: '', cls: 'external', region: 'EU' } };
    }
    html += '<div class="ob-form-layout"><form class="p-card ob-form" id="conn-form" novalidate>' +
      '<label class="ob-label" for="c-name">Name</label><input class="ob-input" id="c-name" value="' + esc(cdraft.name) + '" placeholder="For example: Large servers to Datadog" autocomplete="off"><p class="ob-error" id="c-name-err" hidden>Give the connector a name.</p>' +
      '<h2 class="ob-section">1. Which devices</h2><select class="p-select" id="c-group" aria-label="Group">' + state.groups.map(function (g) { return '<option value="' + g.id + '"' + (g.id === cdraft.group ? ' selected' : '') + '>' + esc(g.name) + ' (' + n(groupDevices(g).length) + ')</option>'; }).join('') + '</select> <a class="p-link" href="#/groups/new">Create a group</a>' +
      '<h2 class="ob-section">2. Which snaps</h2><div id="c-snaps">' + snapPicker() + '</div>' +
      '<h2 class="ob-section">3. How the data is shaped</h2><select class="p-select" id="c-policy" aria-label="Policy"><option value="">No shaping (send unchanged)</option>' + state.policies.map(function (p) { return '<option value="' + p.id + '"' + (p.id === cdraft.policy ? ' selected' : '') + '>' + esc(p.name) + '</option>'; }).join('') + '</select> <a class="p-link" href="#/policies/new">Create a policy</a>' +
      '<h2 class="ob-section">4. Where it goes</h2><select class="p-select" id="c-dest" aria-label="Destination">' + state.destinations.filter(function (d) { return !d.canonical; }).map(function (d) { return '<option value="' + d.id + '"' + (d.id === cdraft.dest ? ' selected' : '') + '>' + esc(d.name) + '</option>'; }).join('') + '<option value="__new"' + (cdraft.dest === '__new' ? ' selected' : '') + '>New destination…</option></select>' +
      '<div id="c-newdest" class="ob-subform"' + (cdraft.dest === '__new' ? '' : ' hidden') + '>' + destFields(cdraft.nd, 'nd-') + '</div>' +
      '<div class="ob-form__actions"><a class="p-button" href="#/connectors">Cancel</a><button type="submit" class="p-button p-button--positive">Activate connector</button></div>' +
      '</form><aside class="p-card ob-preview" id="c-preview" aria-live="polite">' + connPreview() + '</aside></div>';
    return html;
  }
  // Snaps on the chosen group's devices, with how many devices run each
  function groupSnaps(g) {
    const count = {};
    groupDevices(g).forEach(function (d) { deviceSnaps(d).forEach(function (sn) { count[sn] = (count[sn] || 0) + 1; }); });
    return Object.keys(count).sort(function (a, b) { return count[b] - count[a]; }).map(function (sn) { return { id: sn, label: snapLabel(sn), n: count[sn], canonical: !!(TL.valueOf('publisher', sn) || {}).canonical || sn === 'landscape' }; });
  }
  function snapPicker() {
    const list = groupSnaps(groupById(cdraft.group));
    let html = '<label class="ob-radio"><input type="radio" name="c-snapsmode" value="all"' + (cdraft.snapsMode === 'all' ? ' checked' : '') + '> All snaps, including ones installed later</label>' +
      '<label class="ob-radio"><input type="radio" name="c-snapsmode" value="some"' + (cdraft.snapsMode === 'some' ? ' checked' : '') + '> Only these snaps</label>';
    if (cdraft.snapsMode === 'some') {
      html += '<fieldset class="ob-snaps"><legend class="ob-label">Snaps on devices in this group</legend>' + list.map(function (sn) {
        return '<label class="ob-check"><input type="checkbox" name="c-snap" value="' + esc(sn.id) + '"' + (cdraft.snaps.indexOf(sn.id) >= 0 ? ' checked' : '') + '> ' + esc(sn.label) + ' <span class="ob-muted">' + (sn.canonical ? 'Canonical · ' : '') + n(sn.n) + ' device' + (sn.n === 1 ? '' : 's') + '</span></label>';
      }).join('') + '</fieldset><p class="ob-error" id="c-snaps-err" hidden>Choose at least one snap.</p>';
    }
    return html;
  }
  function connPreview() {
    const g = groupById(cdraft.group), p = policyById(cdraft.policy);
    const only = cdraft.snapsMode === 'some' ? cdraft.snaps : null;
    const list = groupDevices(g), vol = connVolume(g, only), k = keepOf(p);
    const d = cdraft.dest === '__new' ? cdraft.nd : destById(cdraft.dest);
    const dname = d && d.name ? d.name : 'this destination';
    let html = '<h2 class="ob-preview__title">What will leave</h2>' +
      '<dl class="ob-dl"><dt>Devices now</dt><dd>' + n(list.length) + '</dd>' +
      '<dt>Snaps</dt><dd>' + (only ? (only.length ? only.map(snapLabel).map(esc).join(', ') : 'None chosen yet') : 'All, including snaps installed later') + '</dd>' +
      '<dt>Later</dt><dd>' + (g.kind === 'dynamic' ? 'Any device that joins “' + esc(g.name) + '” is added automatically' : 'Only these devices (static group)') + '</dd>' +
      '<dt>Volume / day</dt><dd>' + mb(vol) + (k < 1 ? ' → <strong>' + mb(vol * k) + '</strong> after ' + esc(p.name) : ' unchanged') + '</dd>' +
      '<dt>Receiver</dt><dd>' + esc(dname) + (d && d.cls ? ' · ' + CLASSES[d.cls] : '') + (d && d.region ? ' · ' + esc(d.region) : '') + '</dd></dl>';
    if (leaves(d)) html += '<div class="ob-warn"><strong>This data leaves your organisation.</strong> ' + (g.kind === 'dynamic' ? 'Because the group is dynamic, new matching devices will start sending without anyone acting.' : '') + '</div>';
    const fan = list.filter(function (x) { return userConnectors().some(function (c) { return groupDevices(groupById(c.group)).some(function (y) { return y.id === x.id; }); }); }).length;
    if (fan) html += '<p class="ob-hint">' + n(fan) + ' of these devices already send to another destination. Each packet will go to both.</p>';
    const o = others();
    html += '<p class="ob-hint">' + (o.length ? o.map(function (u) { return esc(u.name); }).join(' and ') + ' will be notified when you activate it.' : 'Activating is recorded in Recent changes.') + '</p>';
    return html;
  }
  function activateConnector() {
    const name = cdraft.name.trim();
    if (!name) { $('c-name-err').hidden = false; $('c-name').focus(); return; }
    if (cdraft.snapsMode === 'some' && !cdraft.snaps.length) { $('c-snaps-err').hidden = false; return; }
    let dest = destById(cdraft.dest);
    if (cdraft.dest === '__new') {
      readDest('nd-', cdraft.nd);
      if (!cdraft.nd.name.trim()) { $('nd-name-err').hidden = false; $('nd-name').focus(); return; }
      dest = newDest(cdraft.nd);
    }
    const c = { id: uid('c'), name: name, group: cdraft.group, snaps: cdraft.snapsMode === 'some' ? cdraft.snaps.slice() : 'all', policy: cdraft.policy || null, dest: dest.id, by: ME, at: now() };
    state.connectors.push(c);
    log('activated connector <strong>' + esc(name) + '</strong> (' + esc(groupById(c.group).name) + ', ' + esc(snapsText(c)).toLowerCase() + ' → ' + esc(dest.name) + ', ' + CLASSES[dest.cls] + ')');
    const first = !state.firstConnector;
    if (first) state.firstConnector = c.id;
    cdraft = null; save();
    const o = others();
    toast('Connector active.' + (o.length && leaves(dest) ? ' ' + o.map(function (u) { return u.name; }).join(' and ') + ' notified.' : ''));
    go(first ? 'flow?first=1' : 'connectors');
  }

  // ---- Data flow -------------------------------------------------------
  let flowFocus = null;
  function applyInsight(id) {
    const i = insightsList().filter(function (x) { return x.id === id; })[0];
    if (!i || !i.flow) return;
    flowView = i.flow.view; devGroupBy = i.flow.dev; destGroupBy = i.flow.dest;
    const k = i.flow.select.indexOf(':'); flowFocus = { dim: i.flow.select.slice(0, k), val: i.flow.select.slice(k + 1) };
  }
  function pageFlow() {
    const shown = /show=([a-z]+)/.exec(location.hash);
    if (shown) { applyInsight(shown[1]); history.replaceState(null, '', '#/flow'); }
    let html = header('Data flow', 'Data flow', 'How data moves from each device’s snaps, through policies, to each destination.');
    if (!state.connected) return html + emptyNoDevices();
    const first = /first=1/.test(location.hash) && state.firstConnector;
    if (first) html += '<div class="ob-banner ob-banner--success" role="status"><span class="ob-banner__step">Done</span><p class="ob-banner__text"><strong>Your first data is on its way.</strong> The highlighted path is the connector you just created. The Canonical Snap Store is orange.</p><div class="ob-banner__actions"><a class="p-button p-button--small p-button--positive" href="#/overview">Go to Overview</a></div></div>';
    const t = totals(), list = insightsList();
    html += '<div class="p-kpis ob-kpis"><div class="p-kpi"><div class="p-kpi__label">Devices connected</div><div class="p-kpi__value">' + n(devices().length) + '</div></div>' +
      '<div class="p-kpi"><div class="p-kpi__label">Leaving devices / day</div><div class="p-kpi__value">' + mb(t.fleet) + '</div><div class="p-kpi__sub">Includes update traffic with the Canonical Snap Store</div></div>' +
      '<div class="p-kpi"><div class="p-kpi__label">Delivered / day</div><div class="p-kpi__value">' + mb(t.delivered) + '</div><div class="p-kpi__sub">Can be higher than data leaving devices when a device sends to several destinations</div></div>' +
      '<div class="p-kpi"><div class="p-kpi__label">Dropped by shaping / day</div><div class="p-kpi__value">' + mb(t.dropped) + '</div></div></div>';
    if (list.length) html += '<details class="p-card ob-flowinsights"><summary>' + list.length + ' insight' + (list.length > 1 ? 's' : '') + ' available</summary><ul class="ob-list">' + list.map(function (i) { return '<li class="ob-insight"><span class="p-badge">' + i.who + '</span><div><strong>' + esc(i.title) + '</strong><p>' + i.body + '</p></div>' + (i.flow ? '<button type="button" class="p-link" data-act="show-insight" data-id="' + i.id + '">Show me</button>' : '') + '</li>'; }).join('') + '</ul></details>';
    const opt = function (list, cur) { return list.map(function (o) { return '<option value="' + o.id + '"' + (o.id === cur ? ' selected' : '') + '>' + o.label + '</option>'; }).join(''); };
    html += '<div class="p-toolbar ob-flowbar">' +
      '<div class="p-field"><label class="p-field__label" for="flow-view">View</label><select id="flow-view" class="p-select">' + viewOptions() + '</select></div>' +
      '<div class="p-field"><label class="p-field__label" for="flow-devgroup">Group devices by</label><select id="flow-devgroup" class="p-select">' + opt(DEV_GROUPS, devGroupBy) + '</select></div>' +
      '<div class="p-field"><label class="p-field__label" for="flow-destgroup">Group destinations by</label><select id="flow-destgroup" class="p-select">' + opt(DEST_GROUPS, destGroupBy) + '</select></div></div>' +
      '<p class="ob-question" id="flow-question">' + esc(currentView().question) + '</p>' +
      '<p class="ob-ladder" id="flow-ladder" hidden></p>';
    html += '<div class="p-card insights__chart"><div class="chart-wrap"><div class="ob-legend" id="flow-legend"></div><svg id="flow-svg" class="sankey" role="img" aria-label="Sankey diagram of data flow"></svg></div>' +
      '<div class="ob-key" id="flow-key"></div></div>' +
      '<p class="ob-hint"><a class="p-link" href="insights/index.html?fleet=' + (SCEN.fleet === 'zero' ? 'mid' : SCEN.fleet) + '">Open the full Insights prototype</a> to see Data flow for a mature setup (demo data: views, group-by, comments and timeline).</p>';
    if (state.firstConnector && !state.flowSeen) { state.flowSeen = true; save(); }
    return html;
  }
  // Column 1 is every device by default. Like the Insights prototype: up to 15 devices are all shown,
  // 16 to 30 get a nudge to group, and above 30 the top 20 by volume are shown plus "Others".
  // Both ends of the Sankey can be grouped. Flows are monochrome; click a node to trace its path.
  const DEV_GROUPS = [{ id: 'none', label: 'None (each device)' }, { id: 'group', label: 'Group' }, { id: 'site', label: 'Site' }, { id: 'region', label: 'Region' }, { id: 'type', label: 'Device type' }, { id: 'release', label: 'Ubuntu release' }];
  const DEST_GROUPS = [{ id: 'none', label: 'None (each destination)' }, { id: 'cls', label: 'Receiver' }, { id: 'type', label: 'Type' }, { id: 'region', label: 'Region' }];
  let devGroupBy = 'none', destGroupBy = 'none';
  // View, as in Insights: starts on Neutral (monochrome). Another view colours each device, and its flows
  // end to end, by one attribute from the latest month. The Canonical store keeps its orange bar.
  const NEUTRAL = '#4C6E87', ORANGE = '#E95420', NO_COLOUR = '#C9C9C9';
  const LAST_MONTH = TL.MONTHS.length - 1;
  const HOBBY_HIDDEN = ['sovereignty', 'confidential', 'jaas', 'maas'];
  let flowView = 'neutral';
  function views() { return TL.VIEWS.filter(function (v) { return !(SCEN.fleet === 'hobby' && HOBBY_HIDDEN.indexOf(v.id) >= 0); }); }
  function currentView() { return TL.viewById(flowView) || TL.VIEWS[0]; }
  function viewOptions() {
    let html = '', open = null;
    views().forEach(function (v) {
      if (v.group !== open) { if (open) html += '</optgroup>'; if (v.group) html += '<optgroup label="' + esc(v.group) + '">'; open = v.group || null; }
      html += '<option value="' + v.id + '"' + (v.id === flowView ? ' selected' : '') + '>' + esc(v.label) + '</option>';
    });
    return html + (open ? '</optgroup>' : '');
  }
  const attrCache = {};
  function latestAttrs(id) { return attrCache[id] || (attrCache[id] = TL.deviceAt(id, LAST_MONTH).attrs); }
  function colourValue(f) {
    const v = currentView(); if (v.attr === 'neutral') return 'all';
    const val = latestAttrs(f.dev)[v.attr]; return val == null ? 'none' : String(val);
  }
  function colourPalette(facts) {
    const v = currentView();
    if (v.attr === 'neutral') return [{ id: 'all', color: NEUTRAL, label: 'Data' }];
    const seen = {}; facts.forEach(function (f) { seen[colourValue(f)] = 1; });
    return (TL.ATTRIBUTES[v.attr] || { values: [] }).values.filter(function (x) { return seen[x.id]; })
      .map(function (x) { return { id: x.id, color: x.color || NO_COLOUR, label: x.label }; })
      .concat(seen.none && !(TL.ATTRIBUTES[v.attr] || { values: [] }).values.some(function (x) { return x.id === 'none'; }) ? [{ id: 'none', color: NO_COLOUR, label: 'Not set' }] : []);
  }
  function drawFlow() {
    const svg = $('flow-svg'); if (!svg) return;
    const facts = flows();
    const first = /first=1/.test(location.hash) ? state.firstConnector : null;
    const grouped = devGroupBy !== 'none';
    // rank devices by volume for the top 20
    // rank by data from snaps first (what connectors send), then by update traffic
    const devTot = {}, devCust = {};
    facts.forEach(function (f) { devTot[f.dev] = (devTot[f.dev] || 0) + f.count; if (f.kind !== 'canonical') devCust[f.dev] = (devCust[f.dev] || 0) + f.count; });
    const ranked = Object.keys(devTot).sort(function (a, b) { return (devCust[b] || 0) - (devCust[a] || 0) || devTot[b] - devTot[a]; });
    const top = ranked.length > 30 ? ranked.slice(0, 20) : ranked, inTop = {};
    top.forEach(function (id) { inTop[id] = 1; });
    const others = ranked.length - top.length;
    const srcOf = function (f) {
      if (devGroupBy === 'group') return 'g:' + f.grp;
      if (grouped) { const v = ALL_BY_ID[f.dev].attrs[devGroupBy]; return 'a:' + (v == null ? 'none' : v); }
      return inTop[f.dev] ? 'd:' + f.dev : '__others';
    };
    const destOf = function (f) {
      if (destGroupBy === 'none' || f.dest === '__dropped') return f.dest;
      const d = destById(f.dest); return 'x:' + (destGroupBy === 'cls' ? d.cls : d[destGroupBy] || 'none');
    };
    const ids = { src: [], pub: [], pol: [], dest: [] }, seen = { src: {}, pub: {}, pol: {}, dest: {} };
    const add = function (k, v) { if (!seen[k][v]) { seen[k][v] = 1; ids[k].push(v); } };
    if (!grouped) top.forEach(function (id) { add('src', 'd:' + id); });
    facts.forEach(function (f) { add('src', srcOf(f)); add('pub', f.pub); add('pol', f.pol); add('dest', destOf(f)); });
    const rank = function (x, last) { return last.indexOf(x) >= 0 ? 1 + last.indexOf(x) : 0; };
    ids.pub.sort(function (a, b) { return rank(a, ['__snapd']) - rank(b, ['__snapd']) || snapLabel(a).localeCompare(snapLabel(b)); });
    ids.pol.sort(function (a, b) { return rank(a, ['none', 'updates']) - rank(b, ['none', 'updates']); });
    // Canonical destinations first, drops last
    const destRank = function (x) { return x === 'store' || x === 'x:canonical' ? 0 : x === '__dropped' ? 2 : 1; };
    ids.dest.sort(function (a, b) { return destRank(a) - destRank(b); });
    function dim(label, list, lab) { const values = list.map(function (id) { return { id: id, label: lab(id) }; }); const index = {}; values.forEach(function (v, i) { index[v.id] = i; }); return { label: label, values: values, index: index }; }
    const devLabel = (DEV_GROUPS.filter(function (o) { return o.id === devGroupBy; })[0] || {}).label;
    TL.DIMENSIONS.ob_src = dim(grouped ? devLabel : 'Device', ids.src, function (id) {
      if (id === '__others') return 'Others (' + n(others) + ' devices)';
      if (id[0] === 'd') return id.slice(2);
      if (id[0] === 'g') return groupById(id.slice(2)).name;
      return id.slice(2) === 'none' ? 'Not set' : attrLabel(devGroupBy, id.slice(2));
    });
    TL.DIMENSIONS.ob_pub = dim('Publisher (snap)', ids.pub, function (id) { return id === '__snapd' ? 'snapd (updates)' : snapLabel(id); });
    TL.DIMENSIONS.ob_pol = dim('Policy', ids.pol, function (id) { return id === 'updates' ? 'Update traffic' : id === 'none' ? 'No shaping' : policyById(id).name; });
    const destLabel = { none: 'Destination', cls: 'Receiver', type: 'Destination type', region: 'Destination region' }[destGroupBy];
    TL.DIMENSIONS.ob_dest = dim(destLabel, ids.dest, function (id) {
      if (id === '__dropped') return 'Dropped by shaping';
      if (id.slice(0, 2) !== 'x:') return destById(id).name;
      const v = id.slice(2);
      return destGroupBy === 'cls' ? (CLASSES[v] || v) : v === 'none' ? 'Not set' : v;
    });
    const tot = facts.reduce(function (sum, f) { return sum + f.count; }, 0), gb = tot > 5000;
    const mapped = facts.map(function (f) { return { ob_src: srcOf(f), ob_pub: f.pub, ob_pol: f.pol, ob_dest: destOf(f), count: gb ? f.count / 1000 : f.count, kind: f.kind, colour: colourValue(f), conn: f.conn }; });
    const stages = ['ob_src', 'ob_pub', 'ob_pol', 'ob_dest'];
    const focus = first ? function (f) { return f.conn === first || f.kind === 'canonical'; } : flowFocus ? function (f) { return f[flowFocus.dim] === flowFocus.val; } : null;
    const agg = S.aggregate(mapped, stages, { segAttr: 'colour', focus: focus });
    // One band per colour: a link carrying your data and dropped data becomes two bands,
    // so every node's bar reads update traffic, then your data, then dropped, on both sides.
    const split = {};
    Object.keys(agg.links).forEach(function (key) {
      const l = agg.links[key];
      Object.keys(l.seg).forEach(function (kind) {
        const v = l.seg[kind]; if (v <= 1e-9) return;
        const seg = {}, segF = {}; seg[kind] = v; if (l.segF[kind]) segF[kind] = l.segF[kind];
        split[key + '#' + kind] = Object.assign({}, l, { key: key + '#' + kind, value: v, b: l.b * v / l.value, f: l.segF[kind] || 0, seg: seg, segF: segF });
      });
    });
    agg.links = split;
    const width = Math.max(900, svg.parentNode.clientWidth - 8);
    const rows = Math.max(ids.src.length, ids.pub.length);
    const L = S.layout(agg, stages, width, Math.max(280, Math.min(760, 40 + rows * 28)), { marginRight: 200, minNode0: grouped ? 1 : 6 });
    // Line the colours up: at every node, links are stacked by kind (update traffic, your data, dropped)
    // before position, and the node bar is coloured link by link, so each band meets its own colour.
    const PAL = colourPalette(facts);
    const kindRank = function (l) { for (let i = 0; i < PAL.length; i++) if ((l.seg[PAL[i].id] || 0) > 1e-9) return i; return PAL.length; };
    L.nodes.forEach(function (nd) {
      nd.outs.sort(function (a, b) { return kindRank(a) - kindRank(b) || a.t.y - b.t.y; });
      nd.ins.sort(function (a, b) { return kindRank(a) - kindRank(b) || a.s.y - b.s.y; });
      let off = 0; nd.outs.forEach(function (l) { l.sy = nd.y + off; off += l.w; });
      off = 0; nd.ins.forEach(function (l) { l.ty = nd.y + off; off += l.w; });
    });
    S.render(svg, L, { palette: PAL, focusId: focus ? 'x' : null, unit: gb ? ' GB/day' : ' MB/day' });
    const byId = {}; L.nodes.forEach(function (nd) { byId[nd.id] = nd; });
    svg.querySelectorAll('.sk-node').forEach(function (g) {
      const nd = byId[g.getAttribute('data-node')]; if (!nd) return;
      const outs = nd.outs.length > 0, links = outs ? nd.outs : nd.ins, bar = g.querySelector('.sk-node__bar');
      g.querySelectorAll('.sk-node__seg').forEach(function (r) { r.remove(); });
      let after = bar;
      links.forEach(function (l) {
        const segs = focus ? l.segF : l.seg;
        let y = outs ? l.sy : l.ty;
        PAL.forEach(function (pp) {
          const h = (l.seg[pp.id] || 0) / l.value * l.w, shown = (segs[pp.id] || 0) / l.value * l.w;
          if (shown > 0.3) {
            const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            r.setAttribute('class', 'sk-node__seg'); r.setAttribute('style', 'fill:' + pp.color);
            r.setAttribute('x', nd.x); r.setAttribute('y', y); r.setAttribute('width', nd.w); r.setAttribute('height', shown);
            after.after(r); after = r;
          }
          y += h;
        });
      });
    });
    // The Canonical destination keeps an orange bar
    ['ob_dest:store', 'ob_dest:x:canonical'].forEach(function (id) {
      const g = svg.querySelector('.sk-node[data-node="' + id + '"]'); if (!g) return;
      g.querySelectorAll('.sk-node__seg').forEach(function (r) { r.style.fill = ORANGE; });
      const bar = g.querySelector('.sk-node__bar'); if (bar) bar.style.fill = ORANGE;
    });
    $('flow-key').innerHTML = PAL.map(function (pp) { return '<span><i class="ob-key__sw" style="background:' + pp.color + '"></i>' + esc(pp.label) + '</span>'; }).join('') +
      '<span><i class="ob-key__sw" style="background:' + ORANGE + '"></i>Canonical destination</span><span>Click a node to trace its path</span>';
    const cols = stages.map(function (st, i) { const node = L.nodes.filter(function (x) { return x.col === i; })[0]; return node ? '<span style="left:' + node.x + 'px">' + TL.DIMENSIONS[st].label + '</span>' : ''; });
    $('flow-legend').innerHTML = cols.join('');
    const note = $('flow-ladder');
    if (note) {
      note.hidden = grouped || ranked.length <= 15;
      note.innerHTML = ranked.length > 30 ? 'Showing the 20 devices sending the most. The other ' + n(others) + ' are in Others. <button type="button" class="p-link" data-act="flow-group">Group devices by site</button>'
        : 'As your fleet grows, group devices to keep this view readable. <button type="button" class="p-link" data-act="flow-group">Group devices by site</button>';
    }
    svg.querySelectorAll('.sk-node').forEach(function (g) {
      g.addEventListener('click', function () {
        const id = g.getAttribute('data-node'), i = id.indexOf(':');
        const f = { dim: id.slice(0, i), val: id.slice(i + 1) };
        flowFocus = flowFocus && flowFocus.dim === f.dim && flowFocus.val === f.val ? null : f;
        if (/first=1/.test(location.hash)) history.replaceState(null, '', '#/flow');
        drawFlow();
      });
    });
  }

  // ---- Settings --------------------------------------------------------
  function pageSettings() {
    let html = header('Settings', 'Settings', null);
    html += '<section class="p-card ob-module"><div class="ob-module__head"><h2 class="ob-module__title">People</h2></div><table class="ob-table"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th></tr></thead><tbody>' +
      state.users.map(function (u) { return '<tr><td>' + esc(u.name || '–') + '</td><td>' + esc(u.email) + '</td><td>' + esc(u.role) + '</td><td>' + (u.status === 'invited' ? '<span class="p-badge p-badge--caution">Invited</span>' : 'Active') + '</td></tr>'; }).join('') +
      '</tbody></table><form class="ob-invite" id="invite-form" novalidate><label class="ob-label" for="inv-email">Invite by email</label><div class="ob-invite__row"><input class="ob-input" id="inv-email" type="email" placeholder="name@example.com" autocomplete="off">' +
      '<select class="p-select" id="inv-role" aria-label="Role"><option>Admin</option><option>Operator</option><option>Viewer</option></select><button type="submit" class="p-button p-button--positive">Invite</button></div><p class="ob-error" id="inv-err" hidden>Enter a valid email address.</p></form></section>';
    html += '<section class="p-card ob-module"><div class="ob-module__head"><h2 class="ob-module__title">Landscape</h2></div><p>' + (J().landscape ? 'Linked to <strong>landscape.example.com</strong>. Groups are shared between Landscape and telemetry.' : 'Not linked. Linking Landscape lets you connect devices from Landscape in one step and share groups.') + '</p></section>';
    html += '<p class="ob-hint">Demo controls are in the jig drawer on the right.</p>';
    return html;
  }


  // ---- Jig drawer (prototype controls) ---------------------------------
  const ORDER = ['connect', 'about', 'group', 'policy', 'connector', 'flow'];
  function complete(step) {
    if (step === 'connect') { state.connected = true; state.connectedAt = now(); log(J().landscape ? 'pointed <strong>' + n(ALL.length) + ' devices</strong> at telemetry from Landscape' : 'connected the first device'); }
    else if (step === 'about') { state.intents = ['cost', 'monitoring']; state.primary = 'monitoring'; state.aboutDone = true; }
    else if (step === 'group' && !userGroups().length) { state.groups.push({ id: 'g-large', name: 'Large servers', kind: 'dynamic', query: [{ attr: 'ram', op: 'gte', val: '32' }], members: null, by: ME, at: now() }); log('created group <strong>Large servers</strong> (dynamic)'); }
    else if (step === 'policy' && !state.policies.length) state.policies.push({ id: 'p-reduce', name: 'Reduce volume', template: 'cost', purpose: 'analytic', rules: { sample: 50, dropDebug: true, metricsOnly: false, redact: false }, by: ME, at: now() }), log('created policy <strong>Reduce volume</strong>');
    else if (step === 'connector' && !userConnectors().length) {
      state.destinations.push({ id: 'd-datadog', name: 'Datadog EU', type: 'Datadog', cls: 'external', region: 'EU', endpoint: '', by: ME, at: now() });
      const g = userGroups()[0] || groupById('all');
      state.connectors.push({ id: 'c-first', name: g.name + ' to Datadog', group: g.id, snaps: 'all', policy: state.policies[0].id, dest: 'd-datadog', by: ME, at: now() });
      state.firstConnector = 'c-first';
      log('activated connector <strong>' + esc(g.name) + ' to Datadog</strong> (' + esc(g.name) + ' → Datadog EU, External)');
    } else if (step === 'flow') state.flowSeen = true;
  }
  function fillTo(stepId) {
    const jig = state.jig, wasJoiner = jig.joiner, ana = { group: anaHas(state, 'group'), policy: anaHas(state, 'policy'), connector: anaHas(state, 'connector') };
    state = fresh(); state.jig = jig; setJoiner(state, false);
    if (wasJoiner) { setJoiner(state, true); ['group', 'policy', 'connector'].forEach(function (k) { if (ana[k]) setAna(state, k, true); }); }
    const upto = stepId === 'done' ? ORDER.length : ORDER.indexOf(stepId);
    for (let i = 0; i < upto; i++) complete(ORDER[i]);
    if (stepId === 'done') state.setupNoted = true;
  }
  function renderJig() {
    const el = $('jig'); if (!el) return;
    const cur = currentStep(), j = J();
    const chk = function (id, on, label, hint, disabled) {
      return '<label class="ob-jig__check' + (disabled ? ' is-disabled' : '') + '"><input type="checkbox" data-jig="' + id + '"' + (on ? ' checked' : '') + (disabled ? ' disabled' : '') + '><span>' + label + (hint ? '<small>' + hint + '</small>' : '') + '</span></label>';
    };
    const pending = state.users.some(function (u) { return u.status === 'invited'; });
    el.innerHTML = '<div class="ob-jig__head"><h2 class="ob-jig__title">Jig</h2><button type="button" class="p-icon-button" data-jig="close" aria-label="Close jig">✕</button></div>' +
      '<p class="ob-jig__now">' + (cur ? 'Now on step ' + stepNo(cur.id) + ' of ' + STEPS.length + ': ' + esc(cur.title) : 'Setup complete') + '</p>' +
      '<section class="ob-jig__sec"><h3>Scenario</h3>' +
        '<label class="ob-jig__field"><span>Fleet size</span><select class="p-select" data-jig="fleet">' +
        [['zero', 'No devices yet'], ['hobby', 'Home lab (6)'], ['mid', 'Mid-size (38)'], ['enterprise', 'Enterprise (5,000)']].map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === SCEN.fleet ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></label>' +
        chk('landscape', j.landscape, 'Landscape linked', 'Connect devices from Landscape, shared groups') + '</section>' +
      '<section class="ob-jig__sec"><h3>Devices</h3>' +
        chk('connected', state.connected, 'Devices connected', SCEN.fleet === 'zero' ? 'The empty fleet gets the mid-size devices' : null) +
        chk('rejected', j.rejected, 'Server sees rejected attempts', 'Shown in the connection diagnostics') +
        chk('optedOut', j.optedOut, 'Some devices opted out', 'Shown in diagnostics when Landscape is linked', !j.landscape) + '</section>' +
      '<section class="ob-jig__sec"><h3>Who came before me</h3>' +
        chk('joiner', j.joiner, 'Invited by ' + ANA, 'She is an admin; ' + TOM + ' approves external destinations') +
        chk('ana-group', anaHas(state, 'group'), ANA + ' created a group', null, !j.joiner) +
        chk('ana-policy', anaHas(state, 'policy'), ANA + ' created a policy', null, !j.joiner) +
        chk('ana-connector', anaHas(state, 'connector'), ANA + ' created a connector', 'To an internal Splunk', !j.joiner) +
        chk('pending', pending, 'An invitation is unanswered', 'Adds a task after setup') + '</section>' +
      '<section class="ob-jig__sec"><h3>My progress</h3>' +
        '<label class="ob-jig__field"><span>Start at</span><select class="p-select" data-jig="jump-to">' +
        STEPS.map(function (st, i) { return '<option value="' + st.id + '"' + (cur && cur.id === st.id ? ' selected' : '') + '>Step ' + (i + 1) + ': ' + esc(st.title) + '</option>'; }).join('') +
        '<option value="done"' + (!cur ? ' selected' : '') + '>Setup complete</option></select></label>' +
        '<button type="button" class="p-button p-button--small" data-jig="jump">Go</button>' +
        '<p class="ob-jig__hint">Fills in everything before that step as if you did it. Keeps the settings above.</p></section>' +
      '<section class="ob-jig__sec"><h3>After setup</h3>' +
        chk('skipAhead', state.skipAhead, '7 days of data', 'Insights need about 24 hours of data') +
        chk('degraded', j.degraded, 'Your first destination is degraded', 'Adds a task and a Degraded badge') + '</section>' +
      '<div class="ob-jig__foot"><button type="button" class="p-link p-link--negative" data-jig="reset">Reset everything</button></div>';
  }
  function setJigOpen(open) {
    state.jig.open = open; save();
    try { localStorage.setItem('tob.jigOpen', open ? '1' : ''); } catch (e) { /* private mode */ }
    document.body.classList.toggle('jig-open', open);
    $('jig').inert = !open;
    $('jig-tab').setAttribute('aria-expanded', String(open));
    if (open) renderJig();
  }
  function jigChange(el) {
    const k = el.getAttribute('data-jig'), on = el.checked;
    if (k === 'fleet') { location.href = location.pathname + '?fleet=' + el.value + location.hash; return; }
    if (k === 'landscape' || k === 'rejected' || k === 'optedOut' || k === 'degraded') state.jig[k] = on;
    else if (k === 'connected') { state.connected = on; waiting = false; }
    else if (k === 'joiner') setJoiner(state, on);
    else if (/^ana-/.test(k)) setAna(state, k.slice(4), on);
    else if (k === 'pending') {
      state.users = state.users.filter(function (u) { return u.status !== 'invited'; });
      if (on) state.users.push({ name: '', email: 'sam@example.com', role: 'Operator', status: 'invited' });
    } else if (k === 'skipAhead') state.skipAhead = on;
    else return;
    save(); render();
  }

  // ---- Toast -----------------------------------------------------------
  let toastT = null;
  function toast(msg) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(function () { t.hidden = true; }, 4000); }

  // ---- Render ----------------------------------------------------------
  function render() {
    const r = route();
    if (r.page !== 'groups') gdraft = null;
    if (r.page !== 'policies') pdraft = null;
    if (r.page !== 'connectors') cdraft = null;
    if (r.page !== 'destinations') ddraft = null;
    if (r.page !== 'flow') flowFocus = null;
    renderNav(r.page);
    const pages = { overview: pageOverview, groups: pageGroups, policies: pagePolicies, connectors: pageConnectors, destinations: pageDestinations, flow: pageFlow, settings: pageSettings };
    const fn = pages[r.page] || pageOverview;
    $('main').innerHTML = fn(r.sub);
    if (r.page === 'flow') drawFlow();
    document.title = ($('topbar-page').textContent || 'Overview') + ' · Telemetry';
    renderJig();
  }

  // ---- Events ----------------------------------------------------------
  const main = $('main');
  main.addEventListener('click', function (e) {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const act = b.getAttribute('data-act');
    if (act === 'use-all') { state.useAll = true; log('chose to use <strong>All devices</strong> for the first connector'); save(); go('overview'); render(); }
    else if (act === 'connect') {
      waiting = true; render();
      setTimeout(function () {
        waiting = false; state.connected = true; state.connectedAt = now();
        log(J().landscape ? 'pointed <strong>' + n(ALL.length) + ' devices</strong> at telemetry from Landscape' : 'connected the first device');
        save(); toast(J().landscape ? n(ALL.length) + ' devices connected' : 'First device connected'); render();
      }, 2200);
    }
    else if (act === 'about-save') { state.aboutDone = true; if (!state.primary || state.intents.indexOf(state.primary) < 0) state.primary = state.intents[0]; save(); render(); }
    else if (act === 'about-skip') { state.aboutDone = true; save(); render(); }
    else if (act === 'dismiss-setup') { state.setupNoted = true; save(); render(); }
    else if (act === 'skip-ahead') { state.skipAhead = !state.skipAhead; save(); render(); }
    else if (act === 'reset') { localStorage.removeItem(KEY); state = fresh(); render(); toast('Scenario reset'); }
    else if (act === 'q-add') { gdraft.query.push({ attr: 'region', op: 'is', val: QA.region ? QA.region.values[0].id : '' }); $('q-rows').innerHTML = queryRows(); $('g-preview').innerHTML = groupPreview(); }
    else if (act === 'q-del') { gdraft.query.splice(+b.getAttribute('data-i'), 1); $('q-rows').innerHTML = queryRows(); $('g-preview').innerHTML = groupPreview(); }
    else if (act === 'tpl') {
      const t = TEMPLATES.filter(function (x) { return x.id === b.getAttribute('data-id'); })[0];
      pdraft = { id: 'new', template: t.id, name: t.id === 'custom' ? '' : t.name, purpose: t.purpose, rules: Object.assign({}, t.rules) }; render();
    }
    else if (act === 'tpl-back') { pdraft.template = null; render(); }
    else if (act === 'show-insight') { applyInsight(b.getAttribute('data-id')); render(); document.querySelector('.insights__chart').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    else if (act === 'flow-group') { devGroupBy = 'site'; $('flow-devgroup').value = 'site'; drawFlow(); }
  });
  main.addEventListener('change', function (e) {
    const el = e.target;
    if (el.getAttribute('data-act') === 'intent') {
      const v = el.value, i = state.intents.indexOf(v);
      if (el.checked && i < 0) state.intents.push(v); else if (!el.checked && i >= 0) state.intents.splice(i, 1);
      save(); render(); const again = main.querySelector('input[value="' + v + '"][data-act="intent"]'); if (again) again.focus();
    } else if (el.getAttribute('data-act') === 'primary') { state.primary = el.value; save(); }
    else if (el.hasAttribute('data-q')) {
      const i = +el.getAttribute('data-i'), k = el.getAttribute('data-q'), row = gdraft.query[i];
      row[k] = el.value;
      if (k === 'attr') { const a = QA[el.value]; row.op = a.numeric ? 'gte' : 'is'; row.val = a.numeric ? '32' : a.values[0].id; $('q-rows').innerHTML = queryRows(); }
      $('g-preview').innerHTML = groupPreview();
    } else if (el.name === 'kind') { gdraft.kind = el.value; main.querySelectorAll('.ob-radio-card').forEach(function (c) { c.classList.toggle('is-on', c.querySelector('input').checked); }); $('g-preview').innerHTML = groupPreview(); }
    else if (el.id === 'flow-devgroup') { devGroupBy = el.value; flowFocus = null; drawFlow(); }
    else if (el.id === 'flow-destgroup') { destGroupBy = el.value; flowFocus = null; drawFlow(); }
    else if (el.id === 'flow-view') { flowView = el.value; $('flow-question').textContent = currentView().question; drawFlow(); }
    else if (el.id === 'p-purpose') pdraft.purpose = el.value;
    else if (el.id && /^p-(dropDebug|metricsOnly|redact)$/.test(el.id)) { pdraft.rules[el.id.slice(2)] = el.checked; $('p-preview').innerHTML = policyPreview(); }
    else if (el.id === 'c-group' || el.id === 'c-policy' || el.id === 'c-dest') {
      cdraft[el.id.slice(2)] = el.value;
      if (el.id === 'c-dest') $('c-newdest').hidden = el.value !== '__new';
      if (el.id === 'c-group') { const avail = groupSnaps(groupById(el.value)).map(function (x) { return x.id; }); cdraft.snaps = cdraft.snaps.filter(function (x) { return avail.indexOf(x) >= 0; }); $('c-snaps').innerHTML = snapPicker(); }
      $('c-preview').innerHTML = connPreview();
    } else if (el.name === 'c-snapsmode') { cdraft.snapsMode = el.value; $('c-snaps').innerHTML = snapPicker(); $('c-preview').innerHTML = connPreview(); }
    else if (el.name === 'c-snap') {
      const i = cdraft.snaps.indexOf(el.value);
      if (el.checked && i < 0) cdraft.snaps.push(el.value); else if (!el.checked && i >= 0) cdraft.snaps.splice(i, 1);
      const err = $('c-snaps-err'); if (err) err.hidden = true;
      $('c-preview').innerHTML = connPreview();
    } else if (cdraft && /^nd-/.test(el.id || el.name || '')) { readDest('nd-', cdraft.nd); $('c-preview').innerHTML = connPreview(); }
  });
  main.addEventListener('input', function (e) {
    const el = e.target;
    if (el.id === 'g-name') { gdraft.name = el.value; $('g-name-err').hidden = true; }
    else if (el.id === 'p-name') { pdraft.name = el.value; $('p-name-err').hidden = true; }
    else if (el.id === 'p-sample') { pdraft.rules.sample = +el.value; $('p-sample-v').textContent = el.value + '%'; $('p-preview').innerHTML = policyPreview(); }
    else if (el.id === 'c-name') { cdraft.name = el.value; $('c-name-err').hidden = true; }
    else if (el.id === 'nd-name') { cdraft.nd.name = el.value; $('nd-name-err').hidden = true; $('c-preview').innerHTML = connPreview(); }
    else if (el.id === 'd-name') { $('d-name-err').hidden = true; }
    else if (el.id === 'inv-email') { $('inv-err').hidden = true; }
    else if (el.hasAttribute('data-q') && el.type === 'number') { gdraft.query[+el.getAttribute('data-i')].val = el.value; $('g-preview').innerHTML = groupPreview(); }
  });
  main.addEventListener('submit', function (e) {
    e.preventDefault();
    const id = e.target.id;
    if (id === 'group-form') saveGroup();
    else if (id === 'policy-form') savePolicy();
    else if (id === 'conn-form') activateConnector();
    else if (id === 'dest-form') {
      readDest('d-', ddraft);
      if (!ddraft.name.trim()) { $('d-name-err').hidden = false; $('d-name').focus(); return; }
      newDest(ddraft); ddraft = null; save(); toast('Destination added'); go('destinations');
    } else if (id === 'invite-form') {
      const em = $('inv-email').value.trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) { $('inv-err').hidden = false; $('inv-email').focus(); return; }
      state.users.push({ name: '', email: em, role: $('inv-role').value, status: 'invited' });
      log('invited <strong>' + esc(em) + '</strong> as ' + esc($('inv-role').value)); save(); toast('Invitation sent'); render();
    } else if (id === 'demo-form') {
      const q = new URLSearchParams();
      q.set('fleet', $('demo-fleet').value); if (!$('demo-ls').checked) q.set('landscape', '0'); if ($('demo-joiner').checked) q.set('joiner', '1');
      location.href = location.pathname + '?' + q.toString() + '#/overview';
    }
  });

  // Jig events
  $('jig-tab').addEventListener('click', function () { setJigOpen(!state.jig.open); });
  $('jig').addEventListener('change', function (e) { if (e.target.hasAttribute('data-jig') && e.target.getAttribute('data-jig') !== 'jump-to') jigChange(e.target); });
  $('jig').addEventListener('click', function (e) {
    const b = e.target.closest('button[data-jig]'); if (!b) return;
    const k = b.getAttribute('data-jig');
    if (k === 'close') { setJigOpen(false); $('jig-tab').focus(); }
    else if (k === 'reset') { const open = state.jig.open; localStorage.removeItem(KEY); state = fresh(); state.jig.open = open; save(); render(); toast('Everything reset'); }
    else if (k === 'jump') { fillTo($('jig').querySelector('[data-jig="jump-to"]').value); waiting = false; save(); go('overview'); render(); toast('Jumped'); }
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && state.jig.open && $('jig').contains(document.activeElement)) { setJigOpen(false); $('jig-tab').focus(); } });

  // Mobile navigation
  const navToggle = $('nav-toggle'), navOverlay = $('nav-overlay');
  function setNav(open) {
    document.body.classList.toggle('nav-open', open);
    navToggle.setAttribute('aria-expanded', String(open));
    navOverlay.hidden = !open;
  }
  navToggle.addEventListener('click', function () { setNav(!document.body.classList.contains('nav-open')); });
  navOverlay.addEventListener('click', function () { setNav(false); });
  document.querySelector('.l-nav').addEventListener('click', function (e) { if (e.target.closest('a')) setNav(false); });

  window.addEventListener('hashchange', function () { render(); main.focus({ preventScroll: true }); window.scrollTo(0, 0); });
  let rz = null;
  window.addEventListener('resize', function () { clearTimeout(rz); rz = setTimeout(function () { if (route().page === 'flow') drawFlow(); }, 150); });
  if (!location.hash) history.replaceState(null, '', '#/overview');
  setJigOpen((function () { try { return !!localStorage.getItem('tob.jigOpen'); } catch (e) { return false; } })());
  render();
})(window.TL);
