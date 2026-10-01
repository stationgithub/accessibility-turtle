/**
 * Pill + settings panel. Pure: document, window, timers, and GM storage are
 * injected so tests can drive it with a fake DOM.
 *
 * DOM is built with createElement/textContent only: Meet enforces Trusted
 * Types, so innerHTML would throw.
 *
 * Layout rule: nothing rendered may sit in the bottom 120 px of the viewport
 * (Meet's toolbar lives there). The pill is pinned top right at a fixed height;
 * the drawer under it (settings, recovery) is capped by layoutFor().
 */

export const UI = {
  top: 12,
  right: 12,
  pillHeight: 32,
  gap: 8,
  bottomReserve: 120,
  collapseBelow: 900,
  minDrawer: 48,
  zIndex: 2147483000,
};

const COLORS = {
  pill: '#f28b25',
  pillText: '#202124',
  dotRing: '#202124',
  grey: '#9aa0a6',
  orange: '#ff9800',
  red: '#ea4335',
};

/**
 * Where things go for a given viewport. Pure so the bottom-120 px rule can be
 * tested at any size.
 */
export function layoutFor({ width, height, expanded = false }) {
  const collapsed = width < UI.collapseBelow && !expanded;
  const pillBottom = UI.top + UI.pillHeight;
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
  if (errorText) return { color: 'red', label: errorText };
  switch (state) {
    case 'capturing':
      return { color: 'orange', label: 'Capturing captions' };
    case 'warning':
      return { color: 'red', label: 'Captions not found. Turn on captions (c).' };
    case 'waiting':
      return { color: 'grey', label: 'Looking for captions…' };
    default:
      return { color: 'grey', label: 'Not in a call' };
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
  let settingsOpen = false;
  let saving = false;
  let saveNote = '';
  const recoveries = [];

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
      height: '24px',
      cursor: 'pointer',
      background: '#ffffff',
      color: COLORS.pillText,
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
  });

  const pill = el('div', 'pill', {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    boxSizing: 'border-box',
    height: `${UI.pillHeight}px`,
    padding: '0 4px',
    borderRadius: `${UI.pillHeight / 2}px`,
    background: COLORS.pill,
    color: COLORS.pillText,
    boxShadow: '0 1px 3px rgba(0,0,0,.3)',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    pointerEvents: 'auto',
  });

  const dot = el('button', 'dot', {
    flex: '0 0 auto',
    width: '24px',
    height: '24px',
    padding: '0',
    border: 'none',
    borderRadius: '50%',
    background: COLORS.dotRing,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
  });
  const dotInner = el('span', 'dot-inner', {
    width: '10px',
    height: '10px',
    borderRadius: '50%',
    background: COLORS.grey,
  });
  dot.appendChild(dotInner);

  const details = el('div', 'details', {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    minWidth: '0',
  });
  const message = el('span', 'message', { overflow: 'hidden', textOverflow: 'ellipsis', minWidth: '0' });
  const elapsed = el('span', 'elapsed', { fontVariantNumeric: 'tabular-nums' }, '0:00');
  const lines = el('span', 'lines', {}, '0 lines');
  const save = button('save', 'Save');
  const gear = button('settings-toggle', '⚙', { padding: '0', width: '24px', background: 'transparent' });
  gear.setAttribute('aria-label', 'Meet Caption Capture settings');
  gear.setAttribute('title', 'Settings');
  details.appendChild(message);
  details.appendChild(elapsed);
  details.appendChild(lines);
  details.appendChild(save);
  details.appendChild(gear);

  pill.appendChild(dot);
  pill.appendChild(details);

  const card = (role) =>
    el('div', role, {
      boxSizing: 'border-box',
      background: '#ffffff',
      color: COLORS.pillText,
      border: `2px solid ${COLORS.pill}`,
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
  panel.appendChild(nameLabel);
  panel.appendChild(nameInput);
  panel.appendChild(nameNote);

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
    const layout = layoutFor({ width: window.innerWidth, height: window.innerHeight, expanded });
    const view = statusView(status, errorText || stickyError);

    root.style.display = layout.hidden ? 'none' : 'flex';
    pill.style.maxWidth = `${layout.maxWidth}px`;
    details.style.display = layout.collapsed ? 'none' : 'flex';

    dotInner.style.background = COLORS[view.color];
    dot.setAttribute('data-color', view.color);
    dot.setAttribute('aria-label', `Meet Caption Capture: ${view.label}`);
    dot.setAttribute('title', view.label);

    const alert = view.color === 'red';
    message.textContent = alert ? view.label : '';
    message.style.display = alert ? 'inline' : 'none';
    message.style.color = alert ? '#8b0000' : 'inherit';
    elapsed.textContent = formatElapsed(status.elapsedMs);
    lines.textContent = `${status.lines || 0} ${status.lines === 1 ? 'line' : 'lines'}`;

    const inCall = status.state !== 'idle';
    save.disabled = saving || !inCall;
    save.textContent = saving ? 'Saving…' : saveNote || 'Save';
    save.style.opacity = save.disabled ? '0.6' : '1';

    const showRecovery = recoveries.length > 0;
    const showPanel = settingsOpen && !layout.collapsed;
    recovery.style.display = showRecovery ? 'block' : 'none';
    panel.style.display = showPanel ? 'block' : 'none';
    drawer.style.maxHeight = `${layout.drawerMaxHeight}px`;
    drawer.style.maxWidth = `${layout.maxWidth}px`;
    drawer.style.display = !layout.drawerHidden && (showRecovery || showPanel) ? 'flex' : 'none';
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

  dot.addEventListener('click', () => {
    if (window.innerWidth < UI.collapseBelow) expanded = !expanded;
    render();
  });

  gear.addEventListener('click', () => {
    settingsOpen = !settingsOpen;
    render();
  });

  save.addEventListener('click', async () => {
    if (saving) return;
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
    window.removeEventListener('resize', onResize);
    if (root.parentNode) root.parentNode.removeChild(root);
  }

  render();

  return { update, showError, clearError, offerRecovery, destroy, render, root };
}
