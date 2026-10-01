/**
 * Pill + settings panel. Pure: document, window, timers, and GM storage are
 * injected so tests can drive it with a fake DOM.
 *
 * Open, it is a small dark Meet-styled chip; folded, it is just the turtle
 * (mascot.js), drawn straight on the page with no background. The turtle shows
 * the status: asleep when not in a call, pencil in its mouth while capturing,
 * flipped on a problem. Everything is drawn at UI.scale (80%).
 *
 * DOM is built with createElement/textContent only: Meet enforces Trusted
 * Types, so innerHTML would throw.
 *
 * Layout rule: nothing rendered may sit in the bottom 120 px of the viewport
 * (Meet's toolbar lives there). The pill starts top right and can be dragged
 * anywhere above that reserve; the spot is saved as PILL_POS. The drawer under
 * it (settings, recovery) is capped by layoutFor().
 */
import { createMascot, poseFor } from './mascot.js';


export const UI = {
  top: 12,
  right: 12,
  pillHeight: 36,
  mascotHeight: 30,
  /** The whole widget is drawn at this size (transform, anchored top right). */
  scale: 0.8,
  gap: 8,
  bottomReserve: 120,
  collapseBelow: 900,
  minDrawer: 48,
  zIndex: 2147483000,
  dragThreshold: 4,
};

export const COLORS = {
  chip: 'rgba(38,50,62,.95)',
  chipBorder: 'rgba(255,255,255,.12)',
  chipBorderOn: 'rgba(77,208,180,.55)',
  chipText: '#e3eef5',
  muted: '#b0bec5',
  alert: '#81d4fa',
  teal: '#26a69a',
  ink: '#1d2b36',
  cardBorder: '#80cbc4',
};

/**
 * Where things go for a given viewport. Pure so the bottom-120 px rule can be
 * tested at any size.
 */
export function layoutFor({ width, height, expanded = false, folded = false, top = UI.top }) {
  // Narrow windows start folded; wide ones fold only when the user folded them.
  // `expanded` is a temporary unfold (a narrow-window click, or a new error).
  const collapsed = (width < UI.collapseBelow || folded) && !expanded;
  const pillBottom = top + UI.pillHeight;
  const limit = height - UI.bottomReserve;
  const drawerTop = pillBottom + UI.gap;
  const drawerMaxHeight = Math.max(0, limit - drawerTop);
  return {
    collapsed,
    hidden: pillBottom > limit,
    drawerTop,
    drawerMaxHeight,
    drawerHidden: drawerMaxHeight < UI.minDrawer,
    maxWidth: Math.max(0, width - 2 * UI.right),
  };
}

/**
 * Keep a dragged pill on screen and out of the bottom reserve. `right` and
 * `top` are the pill's distance from the viewport's right and top edges.
 */
export function clampPosition({ top = UI.top, right = UI.right } = {}, { width, height, pillWidth = UI.pillHeight }) {
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const maxTop = Math.max(0, height - UI.bottomReserve - UI.pillHeight);
  const maxRight = Math.max(0, width - pillWidth);
  return {
    top: Math.round(Math.min(Math.max(0, num(top, UI.top)), maxTop)),
    right: Math.round(Math.min(Math.max(0, num(right, UI.right)), maxRight)),
  };
}

export function formatElapsed(ms) {
  const total = Math.max(0, Math.floor((ms || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

/** Lifecycle status -> dot colour and a label that says what is going on. */
export function statusView(status, errorText = '') {
  const state = (status && status.state) || 'idle';
  if (errorText) return { color: 'blue', label: errorText };
  switch (state) {
    case 'capturing':
      return { color: 'teal', label: 'Capturing' };
    case 'warning':
      return { color: 'blue', label: 'Captions not found. Turn on captions (c).' };
    case 'waiting':
      return { color: 'slate', label: 'Looking for captions…' };
    default:
      return { color: 'slate', label: 'Not in a call' };
  }
}

export function createUI({
  document,
  window,
  getValue = () => '',
  setValue = () => {},
  onSave = async () => null,
  setTimeout: later = globalThis.setTimeout.bind(globalThis),
} = {}) {
  if (!document) throw new Error('createUI requires document');
  if (!window) throw new Error('createUI requires window');

  let status = { state: 'idle', elapsedMs: 0, lines: 0 };
  let errorText = '';
  /** A condition that outlives calls and saves (e.g. missing Tampermonkey grants). */
  let stickyError = '';
  let expanded = false;
  /** User's choice from clicking the dot on a wide window; survives reloads. */
  let folded = Boolean(getValue('PILL_FOLDED', false));
  let lastColor = '';
  /** Where the user dragged the pill to; null means the default corner. */
  let position = readPosition();
  let drag = null;
  let suppressClick = false;
  let settingsOpen = false;
  let saving = false;
  let saveNote = '';
  const recoveries = [];

  function readPosition() {
    const raw = getValue('PILL_POS', null);
    if (!raw) return null;
    try {
      const p = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return p && Number.isFinite(Number(p.top)) && Number.isFinite(Number(p.right))
        ? { top: Number(p.top), right: Number(p.right) }
        : null;
    } catch {
      return null;
    }
  }

  // ---- elements ----------------------------------------------------------

  function el(tag, role, style = {}, text) {
    const node = document.createElement(tag);
    node.setAttribute('data-mcc', role);
    Object.assign(node.style, style);
    if (text != null) node.textContent = text;
    return node;
  }

  const button = (role, text, style = {}) =>
    el('button', role, {
      font: 'inherit',
      border: 'none',
      borderRadius: '12px',
      padding: '0 10px',
      height: '26px',
      cursor: 'pointer',
      background: '#e0f2f1',
      color: COLORS.ink,
      ...style,
    }, text);

  const root = el('div', 'root', {
    position: 'fixed',
    top: `${UI.top}px`,
    right: `${UI.right}px`,
    zIndex: String(UI.zIndex),
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: `${UI.gap}px`,
    font: '500 13px/1 "Google Sans", Roboto, Arial, sans-serif',
    pointerEvents: 'none',
    transform: `scale(${UI.scale})`,
    transformOrigin: 'top right',
  });

  const pill = el('div', 'pill', {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    boxSizing: 'border-box',
    height: `${UI.pillHeight}px`,
    padding: '0 4px 0 2px',
    borderRadius: `${UI.pillHeight / 2}px`,
    background: COLORS.chip,
    border: `1px solid ${COLORS.chipBorder}`,
    color: COLORS.chipText,
    boxShadow: '0 2px 6px rgba(0,0,0,.4)',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    pointerEvents: 'auto',
    cursor: 'grab',
    touchAction: 'none',
    userSelect: 'none',
  });

  // The turtle is a button: click to fold or unfold, drag to move.
  const dot = el('button', 'dot', {
    flex: '0 0 auto',
    height: `${UI.mascotHeight}px`,
    padding: '0',
    border: 'none',
    background: 'transparent',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
  });
  const mascot = createMascot(document, { height: UI.mascotHeight });
  dot.style.width = `${mascot.width}px`;
  dot.appendChild(mascot.svg);

  const details = el('div', 'details', {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    minWidth: '0',
  });
  const stateLabel = el('span', 'state', {});
  const message = el('span', 'message', { overflow: 'hidden', textOverflow: 'ellipsis', minWidth: '0', color: COLORS.alert });
  const dotSep = () => el('span', 'sep-dot', { color: COLORS.muted }, '·');
  const sepA = dotSep();
  const elapsed = el('span', 'elapsed', { fontVariantNumeric: 'tabular-nums' }, '0:00');
  const sepB = dotSep();
  const lines = el('span', 'lines', {}, '0 lines');
  const rule = el('span', 'rule', { width: '1px', height: '18px', background: 'rgba(255,255,255,.18)' });
  const iconButton = (role, text, label) => {
    const b = button(role, text, {
      padding: '0', width: '26px', background: 'rgba(255,255,255,.08)', color: COLORS.muted,
    });
    b.setAttribute('aria-label', label);
    b.setAttribute('title', label);
    return b;
  };
  const gear = iconButton('settings-toggle', '⚙', 'Meet Caption Capture settings');
  const foldButton = iconButton('fold', '›', 'Fold to the turtle');
  for (const n of [stateLabel, message, sepA, elapsed, sepB, lines, rule, gear, foldButton]) details.appendChild(n);

  pill.appendChild(dot);
  pill.appendChild(details);

  const card = (role) =>
    el('div', role, {
      boxSizing: 'border-box',
      background: '#ffffff',
      color: COLORS.ink,
      border: `2px solid ${COLORS.cardBorder}`,
      borderRadius: '12px',
      padding: '12px',
      boxShadow: '0 1px 3px rgba(0,0,0,.3)',
      lineHeight: '1.4',
      pointerEvents: 'auto',
    });

  const drawer = el('div', 'drawer', {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: `${UI.gap}px`,
    width: '300px',
    overflowY: 'auto',
    pointerEvents: 'none',
  });

  const recovery = card('recovery');
  const panel = card('panel');
  const nameLabel = el('label', 'name-label', { display: 'block', marginBottom: '6px' }, 'Your name (replaces "You")');
  const nameInput = el('input', 'name-input', {
    boxSizing: 'border-box',
    width: '100%',
    font: 'inherit',
    padding: '6px 8px',
    border: '1px solid #9aa0a6',
    borderRadius: '6px',
  });
  nameInput.setAttribute('type', 'text');
  nameInput.setAttribute('autocomplete', 'off');
  nameInput.setAttribute('aria-label', 'Your name (replaces "You")');
  nameInput.value = String(getValue('MY_NAME', '') || '');
  const nameNote = el('div', 'name-note', { marginTop: '6px', color: '#5f6368' });
  const actions = el('div', 'panel-actions', { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '10px' });
  // The transcript saves itself when you leave; this is an extra mid-call copy.
  const save = button('save', 'Save a copy now');
  save.setAttribute('title', 'Download a .partial.md copy now. The full transcript still saves when you leave.');
  const resetPos = button('reset-position', 'Reset position', { background: '#eceff1' });
  resetPos.setAttribute('title', 'Move the pill back to the top right corner');
  actions.appendChild(save);
  actions.appendChild(resetPos);
  panel.appendChild(nameLabel);
  panel.appendChild(nameInput);
  panel.appendChild(nameNote);
  panel.appendChild(actions);

  drawer.appendChild(recovery);
  drawer.appendChild(panel);
  root.appendChild(pill);
  root.appendChild(drawer);

  // ---- rendering ---------------------------------------------------------

  function mount() {
    const parent = document.body || document.documentElement;
    if (parent && !root.isConnected) parent.appendChild(root);
  }

  function render() {
    mount();
    const view = statusView(status, errorText || stickyError);
    // A new problem unfolds the pill once so the message is read; the user
    // can fold it again and it stays folded until the next new problem.
    if (view.color === 'blue' && lastColor !== 'blue') expanded = true;
    lastColor = view.color;
    const collapsedNow = layoutFor({ width: window.innerWidth, height: window.innerHeight, expanded, folded }).collapsed;
    // Show or hide the details first so the pill is measured at its new width.
    details.style.display = collapsedNow ? 'none' : 'flex';
    const pos = currentPosition(collapsedNow);
    const layout = layoutFor({ width: window.innerWidth, height: window.innerHeight, expanded, folded, top: pos.top });
    root.style.top = `${pos.top}px`;
    root.style.right = `${pos.right}px`;

    root.style.display = layout.hidden ? 'none' : 'flex';
    pill.style.maxWidth = `${layout.maxWidth}px`;
    details.style.display = layout.collapsed ? 'none' : 'flex';

    const alert = view.color === 'blue';
    const inCall = status.state !== 'idle';
    mascot.set(poseFor(view.color, status.state));

    // Folded: only the turtle, straight on the page (Meet is mostly white), so
    // no chip, dark z's, and a soft shadow that also lifts it off dark video.
    const bare = layout.collapsed;
    mascot.setTheme(bare ? 'light' : 'dark');
    mascot.svg.style.filter = bare ? 'drop-shadow(0 1px 1.5px rgba(0,0,0,.35))' : 'none';
    pill.style.background = bare ? 'transparent' : COLORS.chip;
    pill.style.boxShadow = bare ? 'none' : '0 2px 6px rgba(0,0,0,.4)';
    pill.style.padding = bare ? '0' : '0 4px 0 2px';
    pill.style.borderColor = bare
      ? 'transparent'
      : status.state === 'capturing' && !alert ? COLORS.chipBorderOn : COLORS.chipBorder;

    dot.setAttribute('data-color', view.color);
    dot.setAttribute('aria-label', `Meet Caption Capture: ${view.label}`);
    dot.setAttribute('title', `${view.label} · click to ${layout.collapsed ? 'open' : 'fold'}, drag to move`);

    const lineCount = status.lines || 0;
    stateLabel.textContent = alert ? '' : view.label;
    stateLabel.style.display = alert ? 'none' : 'inline';
    message.textContent = alert ? view.label : '';
    message.style.display = alert ? 'inline' : 'none';
    elapsed.textContent = formatElapsed(status.elapsedMs);
    lines.textContent = `${lineCount} ${lineCount === 1 ? 'line' : 'lines'}`;
    for (const n of [sepA, elapsed, sepB, lines]) n.style.display = inCall ? 'inline' : 'none';

    save.disabled = saving || !inCall;
    save.textContent = saving ? 'Saving…' : saveNote || 'Save a copy now';
    save.style.opacity = save.disabled ? '0.6' : '1';

    const showRecovery = recoveries.length > 0;
    const showPanel = settingsOpen && !layout.collapsed;
    recovery.style.display = showRecovery ? 'block' : 'none';
    panel.style.display = showPanel ? 'block' : 'none';
    drawer.style.maxHeight = `${layout.drawerMaxHeight}px`;
    drawer.style.maxWidth = `${layout.maxWidth}px`;
    drawer.style.display = !layout.drawerHidden && (showRecovery || showPanel) ? 'flex' : 'none';
  }

  function pillWidth(collapsed) {
    const rect = typeof pill.getBoundingClientRect === 'function' ? pill.getBoundingClientRect() : null;
    if (rect && rect.width) return rect.width;
    return collapsed ? UI.pillHeight : 240;
  }

  function currentPosition(collapsed) {
    return clampPosition(position || { top: UI.top, right: UI.right }, {
      width: window.innerWidth,
      height: window.innerHeight,
      pillWidth: pillWidth(collapsed),
    });
  }

  function renderRecovery() {
    while (recovery.firstChild) recovery.removeChild(recovery.firstChild);
    if (!recoveries.length) return;
    const n = recoveries.length;
    recovery.appendChild(
      el('div', 'recovery-title', { fontWeight: '700', marginBottom: '6px' },
        `Unsaved ${n === 1 ? 'transcript' : 'transcripts'} from an earlier call`),
    );
    for (const item of recoveries) {
      const row = el('div', 'recovery-row', {
        display: 'flex', alignItems: 'center', gap: '6px', marginTop: '6px',
      });
      const d = item.data || {};
      const when = d.startedAt ? new Date(d.startedAt) : null;
      const stamp = when
        ? `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')} ${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`
        : '';
      const name = d.title || d.meetCode || 'meeting';
      const turns = Array.isArray(d.turns) ? d.turns.length : 0;
      row.appendChild(el('span', 'recovery-label', { flex: '1 1 auto', minWidth: '0' },
        `${stamp} ${name}, ${turns} ${turns === 1 ? 'turn' : 'turns'}`.trim()));
      const get = button('recovery-download', 'Download', { background: COLORS.pill });
      const drop = button('recovery-discard', 'Discard', { background: '#e8eaed' });
      get.addEventListener('click', () => resolveRecovery(item, 'recover'));
      drop.addEventListener('click', () => resolveRecovery(item, 'discard'));
      row.appendChild(get);
      row.appendChild(drop);
      recovery.appendChild(row);
    }
  }

  async function resolveRecovery(item, action) {
    try {
      await item.api[action](item.key);
      const i = recoveries.indexOf(item);
      if (i !== -1) recoveries.splice(i, 1);
    } catch (err) {
      showError((err && err.message) || String(err));
    }
    renderRecovery();
    render();
  }

  // ---- events ------------------------------------------------------------

  // Drag the pill by any part of it. A press that moves less than a few pixels
  // stays a click, so the dot, Save and the gear still work.
  pill.addEventListener('pointerdown', (e) => {
    if (e.button != null && e.button !== 0) return;
    const start = position || { top: UI.top, right: UI.right };
    drag = { x: e.clientX, y: e.clientY, top: start.top, right: start.right, moved: false };
    // Track the rest of the drag on the window: the pointer leaves the small
    // pill on the first move, after which the pill gets no more events. Capture
    // phase, so Meet stopping propagation further down cannot cut the drag off.
    window.addEventListener('pointermove', onDragMove, true);
    window.addEventListener('pointerup', endDrag, true);
    window.addEventListener('pointercancel', endDrag, true);
  });

  function onDragMove(e) {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < UI.dragThreshold) return;
    if (!drag.moved) {
      drag.moved = true;
      pill.style.cursor = 'grabbing';
    }
    const collapsed = layoutFor({ width: window.innerWidth, height: window.innerHeight, expanded, folded }).collapsed;
    position = clampPosition({ top: drag.top + dy, right: drag.right - dx }, {
      width: window.innerWidth,
      height: window.innerHeight,
      pillWidth: pillWidth(collapsed),
    });
    render();
  }

  function endDrag() {
    window.removeEventListener('pointermove', onDragMove, true);
    window.removeEventListener('pointerup', endDrag, true);
    window.removeEventListener('pointercancel', endDrag, true);
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    pill.style.cursor = 'grab';
    if (!moved) return;
    suppressClick = true;
    later(() => { suppressClick = false; }, 0);
    setValue('PILL_POS', JSON.stringify(position));
  }

  /** True (once) when the click is the tail of a drag and must be ignored. */
  function draggedJustNow() {
    if (!suppressClick) return false;
    suppressClick = false;
    return true;
  }

  resetPos.addEventListener('click', () => {
    position = null;
    setValue('PILL_POS', '');
    render();
  });

  dot.addEventListener('click', () => {
    if (draggedJustNow()) return;
    toggleFold();
  });

  foldButton.addEventListener('click', () => {
    if (draggedJustNow()) return;
    toggleFold();
  });

  function toggleFold() {
    if (window.innerWidth < UI.collapseBelow) {
      expanded = !expanded;
    } else {
      const wasCollapsed = layoutFor({ width: window.innerWidth, height: window.innerHeight, expanded, folded }).collapsed;
      folded = !wasCollapsed;
      expanded = false;
      setValue('PILL_FOLDED', folded);
      if (folded) settingsOpen = false;
    }
    render();
  }

  gear.addEventListener('click', () => {
    if (draggedJustNow()) return;
    settingsOpen = !settingsOpen;
    render();
  });

  save.addEventListener('click', async () => {
    if (draggedJustNow() || saving) return;
    saving = true;
    saveNote = '';
    render();
    let result = null;
    try {
      result = await onSave();
    } catch (err) {
      showError((err && err.message) || String(err));
    }
    saving = false;
    if (result) {
      errorText = '';
      saveNote = 'Saved';
    } else if (!errorText) {
      saveNote = 'Nothing yet';
    }
    render();
    later(() => {
      saveNote = '';
      render();
    }, 2000);
  });

  function storeName() {
    const value = String(nameInput.value || '').trim();
    setValue('MY_NAME', value);
    nameNote.textContent = value ? `Saved. "You" will be written as ${value}.` : 'Saved. "You" stays "You".';
  }
  nameInput.addEventListener('change', storeName);
  // Keep keystrokes from reaching Meet's shortcuts (c toggles captions).
  for (const type of ['keydown', 'keyup', 'keypress']) {
    nameInput.addEventListener(type, (e) => e.stopPropagation());
  }

  const onResize = () => render();
  window.addEventListener('resize', onResize);

  // ---- API ---------------------------------------------------------------

  function update(next) {
    const joined = status.state === 'idle' && next && next.state && next.state !== 'idle';
    // An error from the previous call must not read as a warning in this one.
    if (joined) errorText = '';
    status = { ...status, ...(next || {}) };
    render();
  }

  function showError(text, { sticky = false } = {}) {
    const msg = String(text || 'Something went wrong');
    if (sticky) stickyError = msg;
    else errorText = msg;
    render();
  }

  function clearError() {
    errorText = '';
    stickyError = '';
    render();
  }

  /** Lifecycle onRecoverable hook: list unsaved sessions with Download / Discard. */
  function offerRecovery(found, api) {
    for (const f of found || []) {
      if (!recoveries.some((r) => r.key === f.key)) recoveries.push({ key: f.key, data: f.data, api });
    }
    renderRecovery();
    render();
  }

  function destroy() {
    endDrag();
    window.removeEventListener('resize', onResize);
    if (root.parentNode) root.parentNode.removeChild(root);
  }

  render();

  return { update, showError, clearError, offerRecovery, destroy, render, root };
}
