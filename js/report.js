/** DOM rendering: progress checklist, report card, errors. No framework. */

import { formatBytes } from './grade.js';

const $ = (sel) => document.querySelector(sel);

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  node.append(...children.filter((c) => c != null));
  return node;
}

export function createProgress(stepNames) {
  const container = $('#progress');
  container.replaceChildren();
  container.hidden = false;
  const items = new Map();
  for (const name of stepNames) {
    const li = el('li', { class: 'step pending' }, el('span', { class: 'marker', text: '·' }), el('span', { class: 'label', text: name }));
    items.set(name, li);
    container.append(li);
  }
  const set = (name, state, note) => {
    const li = items.get(name);
    if (!li) return;
    li.className = `step ${state}`;
    li.querySelector('.marker').textContent = state === 'active' ? '…' : state === 'done' ? '✓' : state === 'fail' ? '✗' : '·';
    if (note != null) li.querySelector('.label').textContent = `${name} — ${note}`;
  };
  return {
    start: (name, note) => set(name, 'active', note),
    note: (name, note) => set(name, 'active', note),
    done: (name, note) => set(name, 'done', note),
    fail: (name, note) => set(name, 'fail', note),
    skip: (name) => set(name, 'skipped'),
    hide: () => { container.hidden = true; },
  };
}

const GRADE_BLURB = {
  A: 're-derived in this browser',
  B: 'verifiable',
  C: 'partially verifiable',
  F: 'not verifiable',
  'N/A': 'nothing to grade',
};

export function renderReport({ repo, commit, grade, verdict, bullets, next, pinReport, manifestResult }) {
  const out = $('#report');
  out.replaceChildren();

  const card = el('div', { class: `card grade-${grade === 'N/A' ? 'na' : grade.toLowerCase()}` });
  card.append(
    el('div', { class: 'letter', text: grade }),
    el('div', { class: 'card-text' },
      el('div', { class: 'blurb', text: GRADE_BLURB[grade] ?? '' }),
      el('div', { class: 'verdict', text: verdict })),
  );
  out.append(card);

  const evidence = el('ul', { class: 'evidence' });
  for (const b of bullets) {
    const li = el('li', { class: `sev-${b.severity}` }, el('span', { class: 'sev-mark', text: b.severity === 'good' ? '✓' : b.severity === 'bad' ? '✗' : b.severity === 'warn' ? '!' : '·' }), el('span', { text: b.text }));
    if (b.paths?.length) {
      li.append(el('div', { class: 'paths', text: b.paths.join('  ') }));
    }
    evidence.append(li);
  }
  out.append(el('h2', { text: 'evidence' }), evidence);

  const rows = [...(manifestResult?.rows ?? []), ...(pinReport?.rows ?? [])];
  if (rows.length > 0) {
    const table = el('table', { class: 'pins' },
      el('thead', {}, el('tr', {},
        el('th', { text: 'input' }), el('th', { text: 'pinned to' }), el('th', { text: 'status' }), el('th', { text: 'detail' }))));
    const tbody = el('tbody');
    for (const r of rows) {
      const pin = r.pin ?? {};
      const name = r.name ?? r.path ?? pin.path ?? pin.url ?? '—';
      const pinned = pin.commit ? `${pin.repo ?? ''}@${pin.commit.slice(0, 12)}` : (r.path ? 'this repo' : '—');
      tbody.append(el('tr', { class: `status-${r.status}` },
        el('td', { text: String(name).slice(0, 60) }),
        el('td', { text: pinned }),
        el('td', { text: r.status }),
        el('td', { text: r.detail ?? '' })));
    }
    table.append(tbody);
    out.append(el('h2', { text: 'verification' }), el('div', { class: 'table-wrap' }, table));
  }

  if (next?.length) {
    const list = el('ul', { class: 'next' });
    for (const n of next) list.append(el('li', { text: n }));
    out.append(el('h2', { text: `how to raise this grade` }), list);
  }

  if (commit) {
    const permalink = `${location.origin}${location.pathname}?repo=${encodeURIComponent(repo)}`;
    out.append(el('p', { class: 'footer-note' },
      el('span', { text: `analyzed ${repo} at commit ${commit.slice(0, 12)} · ` }),
      el('a', { href: permalink, text: 'permalink' })));
  }
  out.hidden = false;
}

export function renderError(error) {
  const out = $('#report');
  out.replaceChildren(el('div', { class: 'error' },
    el('strong', { text: error.name === 'RateLimitError' ? 'rate limited' : 'error' }),
    el('p', { text: error.message })));
  out.hidden = false;
}

export function renderSelftest(results) {
  const out = $('#report');
  out.replaceChildren(el('h2', { text: 'selftest' }));
  const list = el('ul', { class: 'evidence' });
  for (const r of results) {
    list.append(el('li', { class: r.pass ? 'sev-good' : 'sev-bad' },
      el('span', { class: 'sev-mark', text: r.pass ? '✓' : '✗' }),
      el('span', { text: `${r.name}${r.pass ? '' : ` — ${r.detail}`}` })));
  }
  out.append(list);
  out.hidden = false;
}
