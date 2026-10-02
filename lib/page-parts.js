import { isFit } from './vacancy-fit.js';

// The pieces of the extension's own pages (the benchmark, the history) that look the same on both.

// Everything on a page that comes from the outside — vacancy texts, error bodies — is put in as text, never
// as markup: `el` builds nodes, it does not parse HTML.
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (name === 'class') node.className = value;
    else if (name === 'vars') for (const [key, val] of Object.entries(value)) node.style.setProperty(key, val);
    else if (name.startsWith('on')) node.addEventListener(name.slice(2), value);
    else node.setAttribute(name, value === true ? '' : value);
  }
  node.append(...children.flat().filter((child) => child != null && child !== false));
  return node;
}

export const pct = (probability) => `${Math.round(probability * 100)}%`;
export const ms = (value) => `${Math.round(value)} мс`;
export const chip = (text, modifier = '') => el('span', { class: `chip ${modifier}`.trim() }, text);

// the probability bar: filled to the probability, a tick at the threshold, green or red by which side
export function probabilityBar(probability, threshold) {
  return el(
    'div',
    {
      class: `pbar ${isFit(probability, threshold) ? 'pbar_ok' : 'pbar_no'}`,
      vars: { '--p': `${probability * 100}%`, '--t': `${threshold * 100}%` },
      title: `${(probability * 100).toFixed(1)}%`,
    },
    el('div', { class: 'pbar-fill' }),
    el('div', { class: 'pbar-tick' }),
  );
}

// one answer: the percentage first, then what it means at this threshold (`words` is the pair of labels for yes and
// no), then the bar
export function probabilityCell(probability, threshold, words, title = null) {
  const fit = isFit(probability, threshold);
  return el(
    'div',
    { class: `cell ${fit ? 'cell_ok' : 'cell_no'}` },
    title,
    el('div', { class: 'cell-pct' }, pct(probability)),
    el('div', { class: 'cell-verdict' }, fit ? words.yes : words.no),
    probabilityBar(probability, threshold),
  );
}

// a vacancy as it went to the model: its fields, name and value
export function stateList(state) {
  return el(
    'dl',
    { class: 'state' },
    Object.entries(state).flatMap(([key, value]) => [el('dt', {}, key), el('dd', {}, value)]),
  );
}
