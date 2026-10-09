// Quest book (C283): a parchment book that opens over the stage (the map and nest views), with the chapter and its
// quest list on the left page and one quest per right page; ‹ › or ← → turn pages (a leaf rotating around the spine,
// none with Reduced motion), Esc closes. The book keeps one fixed size whatever the page; long pages scroll inside.
// Below about 640 px of stage width it shows one page. The HUD quest chip shows the tracked quest and opens the book.
// Quests and the tracked id come from ui/quests.js. Owner: WP9. Contract: ARCHITECTURE §14.6, §18 C283.

import { h, append, setText, show, toggleClass, clear, setAttr } from './dom.js';
import { questBook, nextStep, loadTracked, saveTracked } from './quests.js';
import { isShown } from './reveal.js';

/** Page turn duration (ms). */
export const TURN_MS = 560;
/** Below this spread width the book shows one page. */
export const ONE_PAGE_PX = 600;

/** Reduced motion: the game setting (#app data-reduced-motion) or the browser preference. */
function reduced(el) {
  try {
    if (el && typeof el.closest === 'function' && el.closest('[data-reduced-motion="true"]')) return true;
    const w = typeof window !== 'undefined' ? window : null;
    return !!(w && typeof w.matchMedia === 'function' && w.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch {
    return true;
  }
}

/** Listeners told when the tracked quest changes (book, chip and panel stay in step). */
const trackListeners = new Set();

/**
 * Track a quest (null or the tracked id again: stop tracking).
 * @param {string|null} id
 */
export function toggleTrack(id) {
  const cur = loadTracked();
  saveTracked(id && cur !== id ? id : null);
  for (const fn of Array.from(trackListeners)) { try { fn(); } catch { /* ignore */ } }
}

/** The tracked quest of a book, or null. */
export function trackedQuest(book) {
  const id = loadTracked();
  return id && book && Array.isArray(book.quests) ? book.quests.find((x) => x.id === id) || null : null;
}

/**
 * The quest book overlay.
 * @param {HTMLElement} stage the #stage element (the book covers it below the HUD)
 * @param {{ game: Object, openTab?: Function, hudTop?: HTMLElement|null }} ctx
 */
export function createQuestBook(stage, { game, openTab = null, hudTop = null }) {
  let open = false;
  let page = 0;           // index of the quest on the right page
  let turning = null;     // { leaf, under, timer } while a page turns
  let lastBook = { stage: null, quests: [] };
  let sigL = '';
  let sigR = '';

  const left = h('section', { class: 'page page-left', attrs: { 'aria-label': 'Contents' } });
  const right = h('section', { class: 'page page-right', attrs: { 'aria-live': 'polite' } });
  const prev = h('button', { type: 'button', class: 'book-nav prev', text: '‹', attrs: { 'aria-label': 'Previous quest' }, on: { click: () => turn(-1) } });
  const next = h('button', { type: 'button', class: 'book-nav next', text: '›', attrs: { 'aria-label': 'Next quest' }, on: { click: () => turn(1) } });
  const spread = h('div', { class: 'book-spread' }, left, right, prev, next);
  const footL = h('span');
  const close = h('button', { type: 'button', class: 'book-close', text: '×', attrs: { 'aria-label': 'Close the Quest book' }, on: { click: () => api.close() } });
  const book = h('div', { class: 'book', role: 'dialog', attrs: { 'aria-modal': 'false', 'aria-label': 'Quest book' } },
    h('span', { class: 'book-ribbon', attrs: { 'aria-hidden': 'true' } }), close, spread,
    h('div', { class: 'book-foot' }, footL, h('span', { class: 'book-keys', text: '← → turn pages · Esc closes' })));
  const scrim = h('div', { class: 'book-scrim' }, book);
  scrim.hidden = true;
  // a click on the dimmed stage around the book closes it
  scrim.addEventListener('click', (ev) => { if (ev && ev.target === scrim) api.close(); });
  if (stage) stage.appendChild(scrim);

  // ------------------------------------------------------------------ pages
  function renderLeft(bk) {
    const st = bk.stage || {};
    const tracked = loadTracked();
    const sig = JSON.stringify([st.id, page, tracked, bk.quests.map((x) => [x.id, x.title, x.complete, Math.round(x.frac * 100)])]);
    if (sig === sigL) return;
    sigL = sig;
    clear(left);
    const toc = h('ol', { class: 'toc' });
    bk.quests.forEach((qq, i) => {
      const b = h('button', { type: 'button', dataset: { page: String(i) }, on: { click: () => turnTo(i) } },
        h('span', { class: 'toc-mark', text: qq.complete ? '✓' : (i + 1) + '.' }),
        h('span', { class: 'toc-name' }, qq.title, qq.id === tracked ? h('span', { class: 'toc-pin', text: ' ⚑', title: 'Tracked' }) : null),
        h('span', { class: 'toc-pct', text: Math.round(qq.frac * 100) + '%' }));
      if (i === page) b.setAttribute('aria-current', 'page');
      toc.appendChild(h('li', { class: qq.complete ? 'done' : '' }, b));
    });
    left.append(h('h2', { text: st.chapter || '' }), h('div', { class: 'chapter', text: st.name || '' }), h('p', { text: st.blurb || '' }),
      h('div', { class: 'flourish', attrs: { 'aria-hidden': 'true' } }), toc, h('div', { class: 'page-no', text: String(page * 2 + 1) }));
  }

  function renderRight(bk) {
    const qq = bk.quests[page];
    const tracked = loadTracked();
    const sig = JSON.stringify([page, tracked, qq || null]);
    if (sig === sigR) return;
    sigR = sig;
    const keep = right.scrollTop;
    clear(right);
    if (!qq) {
      right.append(h('p', { class: 'qwhy-b', text: 'No quests right now. Keep growing the colony.' }));
      return;
    }
    const isTracked = tracked === qq.id;
    const steps = h('ul', { class: 'isteps' });
    for (const st of qq.steps) {
      steps.appendChild(h('li', { class: st.done ? 'done' : '', attrs: { 'aria-checked': st.done ? 'true' : 'false', role: 'checkbox', 'aria-readonly': 'true' } },
        h('span', { class: 'box', attrs: { 'aria-hidden': 'true' } }),
        h('span', null, h('span', { class: 'itext', text: st.text }), st.note && !st.done ? h('span', { class: 'muted', text: ' ' + st.note }) : null)));
    }
    const fill = h('span');
    fill.style.width = (Math.round(qq.frac * 1000) / 10) + '%';
    const trackBtn = h('button', { type: 'button', class: 'ibtn', attrs: { 'aria-pressed': isTracked ? 'true' : 'false' },
      on: { click: () => { toggleTrack(qq.id); refresh(); } } },
    h('span', { class: 'pin-ico', attrs: { 'aria-hidden': 'true' } }), isTracked ? 'Tracking on the HUD' : 'Track this quest');
    const goBtn = qq.go && openTab ? h('button', { type: 'button', class: 'ibtn', text: qq.go.label + ' ›',
      on: { click: () => { api.close(); openTab(qq.go.tab, qq.go.sub || null); } } }) : null;
    append(right, [
      h('span', { class: 'book-kind k-' + qq.kind, text: qq.kindLabel }),
      qq.complete ? h('span', { class: 'book-done', text: 'Done' }) : null,
      h('div', { class: 'qtitle', text: qq.title }),
      h('p', { class: 'qwhy-b', text: qq.why }),
      h('h3', { text: 'Steps' }), steps,
      h('h3', { text: 'Progress' }),
      h('div', { class: 'ibar', role: 'progressbar', attrs: { 'aria-valuenow': String(Math.round(qq.frac * 100)), 'aria-valuemin': '0', 'aria-valuemax': '100' } }, fill),
      h('div', { class: 'ibar-label', text: qq.progText }),
      h('div', { class: 'ireward' }, h('span', { class: 'seal', text: '★', attrs: { 'aria-hidden': 'true' } }),
        h('span', { class: 'ireward-text' }, h('small', { text: 'Reward' }), qq.reward)),
      h('div', { class: 'iactions' }, trackBtn, goBtn),
      h('div', { class: 'page-no', text: String(page * 2 + 2) })]);
    right.scrollTop = keep;
  }

  /** The book covers the stage below the HUD row (re-measured on refresh: the layout may change while it is open). */
  let lastTop = null;
  function place() {
    if (!hudTop) return;
    const top = Math.max(0, (hudTop.offsetTop || 0) + (hudTop.offsetHeight || 0));
    if (top !== lastTop) {
      lastTop = top;
      scrim.style.top = top ? top + 'px' : '';
    }
  }

  function refresh(force = false) {
    if (!open) return;
    place();
    const s = game && game.s;
    if (!s || !s.run) return;
    lastBook = questBook(s, game.d);
    const n = lastBook.quests.length;
    page = Math.max(0, Math.min(Math.max(0, n - 1), page));
    if (force) { sigL = ''; sigR = ''; }
    if (!turning) {
      renderLeft(lastBook);
      renderRight(lastBook);
    }
    setText(footL, (lastBook.stage.chapter || '') + ' · ' + (lastBook.stage.name || ''));
    prev.disabled = page <= 0 || !!turning;
    next.disabled = page >= n - 1 || !!turning;
  }

  // ------------------------------------------------------------------ page turning (C283)
  /** Stage-relative box of an element inside the spread. */
  const boxOf = (el) => ({ left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight });
  const onePage = () => !(left.offsetWidth > 0);
  /** A positioned copy of a page (its classes, content and scroll position). */
  function copyOf(src, box, cls) {
    const c = src.cloneNode(true);
    c.removeAttribute('aria-live');
    c.removeAttribute('aria-label');
    c.setAttribute('aria-hidden', 'true');
    c.className = src.className + ' ' + cls;
    Object.assign(c.style, { position: 'absolute', left: box.left + 'px', top: box.top + 'px', width: box.width + 'px', height: box.height + 'px', margin: '0' });
    return c;
  }
  function finishTurn() {
    if (!turning) return;
    const t = turning;
    turning = null;
    if (t.timer) clearTimeout(t.timer);
    for (const a of t.anims || []) { try { a.cancel(); } catch { /* ignore */ } }
    for (const el of [t.leaf, t.under]) if (el && el.parentNode) el.parentNode.removeChild(el);
    sigL = '';
    sigR = '';
    refresh();
  }

  function turnTo(target) {
    const n = lastBook.quests.length;
    const to = Math.max(0, Math.min(n - 1, target));
    if (to === page || n === 0) return;
    if (turning) finishTurn();
    const fwd = to > page;
    const canAnimate = typeof right.animate === 'function' && typeof right.cloneNode === 'function' && !reduced(scrim) && right.offsetWidth > 0;
    if (!canAnimate) {
      page = to;
      refresh(true);
      return;
    }
    const single = onePage();
    const rBox = boxOf(right);
    const lBox = boxOf(left);
    const oldRight = copyOf(right, rBox, 'turn-under');
    oldRight.scrollTop = right.scrollTop;
    const oldLeftCopy = single ? null : copyOf(left, lBox, '');
    // the real pages move on to the new quest underneath
    page = to;
    sigL = '';
    sigR = '';
    renderLeft(lastBook);
    renderRight(lastBook);
    const newRight = copyOf(right, rBox, '');
    const newLeftCopy = single ? null : copyOf(left, lBox, '');
    const leaf = h('div', { class: 'leaf' + (single ? ' leaf-single' : ''), attrs: { 'aria-hidden': 'true' } });
    Object.assign(leaf.style, { left: rBox.left + 'px', top: rBox.top + 'px', width: rBox.width + 'px', height: rBox.height + 'px' });
    const face = (pageCopy, back) => {
      Object.assign(pageCopy.style, { left: '0', top: '0', width: '100%', height: '100%' });
      const f = h('div', { class: 'leaf-face ' + (back ? 'back' : 'front') }, pageCopy, h('span', { class: 'leaf-shade' }));
      return f;
    };
    let under = null;
    let frames;
    if (fwd) {
      // forward: the current right page lifts off the spine edge and turns over to the left, showing the next quest
      leaf.appendChild(face(oldRight, false));
      if (!single) leaf.appendChild(face(newLeftCopy, true));
      frames = single ? [{ transform: 'rotateY(0deg)', opacity: 1 }, { transform: 'rotateY(-90deg)', opacity: 0.6 }]
        : [{ transform: 'rotateY(0deg)' }, { transform: 'rotateY(-180deg)' }];
    } else {
      // back: a leaf comes over from the left onto the right page, carrying the earlier quest
      under = oldRight;
      spread.insertBefore(under, prev);
      leaf.appendChild(face(newRight, false));
      if (!single) leaf.appendChild(face(oldLeftCopy, true));
      frames = single ? [{ transform: 'rotateY(-90deg)', opacity: 0.6 }, { transform: 'rotateY(0deg)', opacity: 1 }]
        : [{ transform: 'rotateY(-180deg)' }, { transform: 'rotateY(0deg)' }];
    }
    spread.insertBefore(leaf, prev);
    const dur = single ? Math.round(TURN_MS * 0.7) : TURN_MS;
    const anims = [];
    turning = { leaf, under, anims, timer: null };
    prev.disabled = true;
    next.disabled = true;
    try {
      const a = leaf.animate(frames, { duration: dur, easing: 'cubic-bezier(0.45, 0.05, 0.35, 1)', fill: 'forwards' });
      anims.push(a);
      // the turning leaf darkens as it stands up from the page and lightens as it lies down
      for (const sh of Array.from(leaf.querySelectorAll('.leaf-shade'))) {
        anims.push(sh.animate([{ opacity: 0 }, { opacity: 0.45 }, { opacity: 0 }], { duration: dur, easing: 'ease-in-out', fill: 'forwards' }));
      }
      a.onfinish = finishTurn;
      turning.timer = setTimeout(finishTurn, dur + 200);   // never leave a leaf behind
    } catch {
      finishTurn();
    }
  }

  function turn(dir) {
    turnTo(page + dir);
  }

  // ------------------------------------------------------------------ keyboard (only while the book is open)
  const onKey = (ev) => {
    if (!open || !ev) return;
    const t = ev.target || {};
    const tag = typeof t.tagName === 'string' ? t.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    let used = false;
    if (ev.key === 'Escape') { api.close(); used = true; }
    else if (ev.key === 'ArrowRight') { turn(1); used = true; }
    else if (ev.key === 'ArrowLeft') { turn(-1); used = true; }
    if (used) {
      if (typeof ev.preventDefault === 'function') ev.preventDefault();
      if (typeof ev.stopPropagation === 'function') ev.stopPropagation();
    }
  };
  const win = typeof window !== 'undefined' ? window : null;
  if (win && typeof win.addEventListener === 'function') win.addEventListener('keydown', onKey, true);
  const onTrack = () => { sigL = ''; sigR = ''; refresh(); };
  trackListeners.add(onTrack);

  let returnFocus = null;
  const api = {
    el: scrim,
    /** Open the book (on a quest's page when its id is given, else on the tracked quest, else where it was). */
    open(questId = null) {
      const s = game && game.s;
      if (!s || !s.run) return;
      lastBook = questBook(s, game.d);
      const want = questId || loadTracked();
      const i = want ? lastBook.quests.findIndex((x) => x.id === want) : -1;
      if (i >= 0) page = i;
      if (!open) {
        try { returnFocus = typeof document !== 'undefined' ? document.activeElement : null; } catch { returnFocus = null; }
      }
      open = true;
      show(scrim, true);
      refresh(true);
      try { close.focus(); } catch { /* ignore */ }
    },
    close() {
      if (!open) return;
      if (turning) finishTurn();
      open = false;
      show(scrim, false);
      if (returnFocus && typeof returnFocus.focus === 'function') { try { returnFocus.focus(); } catch { /* ignore */ } }
      returnFocus = null;
    },
    toggle(questId = null) {
      if (open) api.close(); else api.open(questId);
    },
    isOpen: () => open,
    /** 4 Hz refresh while open (pages rebuild only when their content changed). */
    update() {
      if (open) refresh();
    },
    /** Current page index (tests). */
    page: () => page,
    turnTo,
    destroy() {
      if (win && typeof win.removeEventListener === 'function') win.removeEventListener('keydown', onKey, true);
      trackListeners.delete(onTrack);
      if (scrim.parentNode) scrim.parentNode.removeChild(scrim);
    },
  };
  return api;
}

/**
 * The HUD quest chip: the tracked quest, its next step and % done; a click opens the book on it, × stops tracking.
 * Without a tracked quest it reads "Quest book: what to do next" and opens the book. Shown once the Achievements tab
 * is revealed (or a quest is tracked).
 * @param {{ game: Object, book: Object }} ctx
 */
export function createQuestChip({ game, book }) {
  const fill = h('span', { class: 'quest-chip-fill' });
  const text = h('span', { class: 'quest-chip-text' });
  const pct = h('span', { class: 'quest-chip-pct' });
  const x = h('span', { class: 'quest-chip-x', text: '×', role: 'button', tabindex: '0', attrs: { 'aria-label': 'Stop tracking' } });
  const el = h('button', { type: 'button', class: 'quest-chip', dataset: { tip: 'Quest book: suggested next steps. Click to open it.' } },
    fill, h('span', { class: 'pin-ico', attrs: { 'aria-hidden': 'true' } }), text, pct, x);
  el.hidden = true;
  let cur = null;
  const untrack = (ev) => {
    if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation();
    if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
    toggleTrack(null);
  };
  x.addEventListener('click', untrack);
  x.addEventListener('keydown', (ev) => { if (ev && (ev.key === 'Enter' || ev.key === ' ')) untrack(ev); });
  el.addEventListener('click', (ev) => {
    if (ev && ev.target === x) return;
    if (book) book.toggle(cur ? cur.id : null);
  });
  let lastSig = '';
  return {
    el,
    update(s, d) {
      if (!s || !s.run) return;
      const tracked = loadTracked();
      const vis = !!tracked || isShown(s, 'panel_achievements');
      show(el, vis);
      if (!vis) return;
      const bk = questBook(s, d);
      cur = trackedQuest(bk);
      let label;
      let step;
      let frac = 0;
      if (cur) {
        const ns = nextStep(cur);
        label = cur.title;
        step = ns ? 'Step ' + (ns.i + 1) + '/' + cur.steps.length + ': ' + ns.text : 'Complete! Pick the next quest';
        frac = cur.frac;
      } else {
        label = 'Quest book';
        step = (bk.quests.filter((qq) => !qq.complete).length || 'No') + ' suggestions · ' + (bk.stage.name || '');
      }
      const sig = [label, step, Math.round(frac * 100), !!cur].join('|');
      if (sig === lastSig) return;
      lastSig = sig;
      toggleClass(el, 'empty', !cur);
      toggleClass(el, 'complete', !!(cur && cur.complete));
      show(x, !!cur);
      show(pct, !!cur);
      setText(pct, cur ? Math.round(frac * 100) + '%' : '');
      fill.style.width = cur ? (Math.round(frac * 1000) / 10) + '%' : '0%';
      clear(text);
      text.append(h('b', { text: label }), ' ', h('span', { class: 'step', text: '· ' + step }));
      setAttr(el, 'aria-label', (cur ? 'Tracked quest: ' : '') + label + '. ' + step + '. Opens the Quest book.');
    },
  };
}
