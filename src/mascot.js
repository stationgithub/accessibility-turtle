/**
 * Accessibility Turtle, the turtle that shows whether captions are being kept. Pure: `document` is injected.
 *
 * Drawn with createElementNS (Meet enforces Trusted Types, so no innerHTML) and
 * animated with SVG SMIL elements, which Meet's CSP does not block the way it
 * can block a <style> tag.
 *
 * Poses:
 *   sleep   not in a call: slate shell, tucked in, z's drifting up and fading
 *   awake   in a call: teal shell, head out, a No. 2 pencil in its mouth
 *   flipped a problem: blue shell on its back, rocking, helpless eyes
 */

export const SVG_NS = 'http://www.w3.org/2000/svg';

/** z colour per background: light z's on the dark chip, dark z's on Meet's white page. */
export const Z_COLORS = { dark: '#cfd8dc', light: '#455a64' };

export const MASCOT_POSES = ['sleep', 'awake', 'flipped'];

/** Status colour from statusView() -> pose. */
export function poseFor(color, state) {
  if (color === 'blue') return 'flipped';
  if (state === 'idle') return 'sleep';
  return 'awake';
}

/** The drawing lives in y 16..60 of a 64-wide canvas; crop to it so it fills the chip. */
export const MASCOT_VIEWBOX = { x: 0, y: 16, w: 66, h: 44 };

export function createMascot(document, { height = 28 } = {}) {
  const width = Math.round((height * MASCOT_VIEWBOX.w) / MASCOT_VIEWBOX.h);
  const node = (tag, attrs = {}, children = []) => {
    const n = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    for (const c of children) n.appendChild(c);
    return n;
  };
  const forever = { repeatCount: 'indefinite' };

  // ---- sleep -------------------------------------------------------------
  // One "z": set its text first, then add the animations (textContent would wipe them).
  const z = (fontSize, begin) => {
    const t = node('text', {
      x: 47, y: 40, 'font-size': fontSize, 'font-weight': 700,
      'font-family': 'Arial, sans-serif', fill: Z_COLORS.dark, opacity: 0, 'data-z': 1,
    });
    t.textContent = 'z';
    t.appendChild(node('animate', {
      attributeName: 'opacity', values: '0;1;0', keyTimes: '0;0.25;1',
      dur: '3s', begin, ...forever,
    }));
    t.appendChild(node('animateTransform', {
      attributeName: 'transform', type: 'translate', values: '0 0;8 -20',
      dur: '3s', begin, ...forever,
    }));
    return t;
  };
  const sleep = node('g', { 'data-pose': 'sleep' }, [
    node('path', { d: 'M10 46a21 19 0 0 1 42 0z', fill: '#90a4ae' }),
    node('path', { d: 'M18 36h26M14 42h34M24 28v18M31 27v19M38 28v18', stroke: '#cfd8dc', 'stroke-width': 1.6 }),
    node('rect', { x: 8, y: 44, width: 46, height: 5, rx: 2.5, fill: '#78909c' }),
    node('ellipse', { cx: 53, cy: 44.5, rx: 3.6, ry: 2.4, fill: '#455a64' }),
    node('path', { d: 'M51.4 44.3q1.6 1.2 3.2 0', stroke: '#cfd8dc', 'stroke-width': 0.9, fill: 'none' }),
    z(14, '0s'),
    z(12, '1s'),
    z(10, '2s'),
  ]);

  // ---- awake -------------------------------------------------------------
  const pencilParts = () => [
    node('rect', { x: 0, y: -3, width: 4, height: 6, rx: 1.5, fill: '#f48fb1' }),
    node('rect', { x: 4, y: -3, width: 3.4, height: 6, fill: '#b0bec5' }),
    node('rect', { x: 7.4, y: -3, width: 12, height: 6, fill: '#fbc02d' }),
    node('path', { d: 'M7.4-1h12M7.4 1h12', stroke: '#f9a825', 'stroke-width': 0.7 }),
    node('path', { d: 'M19.4-3L25 0l-5.6 3z', fill: '#ffe0b2' }),
    node('path', { d: 'M23.2-1L26 0l-2.8 1z', fill: '#263238' }),
  ];
  const pencil = node('g', { 'data-part': 'pencil' }, pencilParts());
  const awake = node('g', { 'data-pose': 'awake' }, [
    node('rect', { x: 13, y: 44, width: 8, height: 6, rx: 3, fill: '#81c784' }),
    node('rect', { x: 32, y: 44, width: 8, height: 6, rx: 3, fill: '#81c784' }),
    node('path', { d: 'M4 46a21 19 0 0 1 42 0z', fill: '#26a69a' }),
    node('path', { d: 'M12 36h28M9 42h34M18 28v18M25 27v19M32 28v18', stroke: '#b2dfdb', 'stroke-width': 1.6 }),
    node('rect', { x: 2, y: 44, width: 46, height: 5, rx: 2.5, fill: '#00897b' }),
    node('circle', { cx: 50, cy: 35, r: 8, fill: '#81c784' }),
    node('circle', { cx: 52, cy: 33, r: 2.1, fill: '#1d2b36' }),
    node('circle', { cx: 52.7, cy: 32.3, r: 0.7, fill: '#fff' }),
    node('ellipse', { cx: 47.5, cy: 37.5, rx: 1.8, ry: 1.1, fill: '#a5d6a7' }),
    node('g', { transform: 'translate(47 38.6) rotate(12) scale(.7)' }, [pencil]),
  ]);

  // ---- flipped -----------------------------------------------------------
  const flipped = node('g', { 'data-pose': 'flipped' }, [
    node('ellipse', { cx: 31, cy: 55, rx: 15, ry: 2.4, fill: '#000', opacity: 0.35 }),
    node('g', {}, [
      node('animateTransform', {
        attributeName: 'transform', type: 'rotate', values: '-8 31 46;8 31 46;-8 31 46',
        dur: '1.6s', ...forever,
      }),
      node('path', { d: 'M10 30a21 19 0 0 0 42 0z', fill: '#1e88e5' }),
      node('path', { d: 'M14 34h34M18 40h26M24 31v12M31 31v14M38 31v12', stroke: '#90caf9', 'stroke-width': 1.6 }),
      node('rect', { x: 8, y: 26, width: 46, height: 5, rx: 2.5, fill: '#1565c0' }),
      node('circle', { cx: 55, cy: 34, r: 7, fill: '#81c784' }),
      node('circle', { cx: 53, cy: 36.4, r: 2.3, fill: '#fff' }),
      node('circle', { cx: 53, cy: 36.9, r: 1.3, fill: '#1d2b36' }),
      node('circle', { cx: 57.6, cy: 36.4, r: 2.3, fill: '#fff' }),
      node('circle', { cx: 57.6, cy: 36.9, r: 1.3, fill: '#1d2b36' }),
      node('path', { d: 'M60 27q2.2 3.6 0 5q-2.2-1.4 0-5z', fill: '#81d4fa' }),
    ]),
  ]);

  const svg = node('svg', {
    viewBox: `${MASCOT_VIEWBOX.x} ${MASCOT_VIEWBOX.y} ${MASCOT_VIEWBOX.w} ${MASCOT_VIEWBOX.h}`, width, height, 'aria-hidden': 'true',
    focusable: 'false', overflow: 'visible', 'data-mcc': 'mascot',
  }, [sleep, awake, flipped]);
  svg.style.display = 'block';
  svg.style.pointerEvents = 'none';

  const poses = { sleep, awake, flipped };
  const zs = Array.from(sleep.children).filter((c) => c.getAttribute('data-z') === '1');
  let current = '';
  let theme = '';

  /** Show one pose. */
  function set(pose) {
    if (!poses[pose]) pose = 'sleep';
    if (pose === current) return;
    for (const [name, g] of Object.entries(poses)) g.setAttribute('display', name === pose ? 'inline' : 'none');
    current = pose;
    svg.setAttribute('data-pose', pose);
  }

  /** 'dark' when drawn on the dark chip, 'light' when drawn straight on the page. */
  function setTheme(next) {
    if (next === theme) return;
    theme = next;
    for (const z of zs) z.setAttribute('fill', Z_COLORS[next] || Z_COLORS.dark);
    svg.setAttribute('data-theme', next);
  }

  set('sleep');
  setTheme('dark');
  return { svg, width, height, set, setTheme, get pose() { return current; }, get theme() { return theme; } };
}
