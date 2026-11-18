export const $ = (selector, root = document) => root.querySelector(selector);
const NS = 'http://www.w3.org/2000/svg';

export function append(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'dataset') for (const [name, item] of Object.entries(value)) node.dataset[name] = String(item);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key === 'style') node.setAttribute('style', value);
    else if (key === 'value') node.value = value;
    else if (key === 'checked') node.checked = Boolean(value);
    else if (key === 'selected') node.selected = Boolean(value);
    else if (key === 'open') { if (value) node.setAttribute('open', ''); }
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  append(node, children);
  return node;
}

export function svgEl(tag, attrs = {}, text = null) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) if (value !== null && value !== undefined)
    node.setAttribute(key, String(value));
  if (text !== null) node.textContent = text;
  return node;
}

const text = value => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
export const pre = value => el('pre', {class: 'raw'}, text(value));
export const button = (label, onClick, className = '') => el('button', {type: 'button', class: className, onClick}, label);
export const section = (title, ...body) => el('section', {class: 'panel-section'}, el('h3', {}, title), ...body);
export const notice = (value, kind = '') => el('p', {class: `notice ${kind}`.trim()}, value);
export const pill = (value, kind = '') => el('span', {class: `pill ${kind}`.trim()}, value);
export const source = file => el('p', {class: 'source'}, file);
export const details = (title, body, open = false) => el('details', open ? {open: true} : {}, el('summary', {}, title), body);
export const field = (label, control) => el('label', {class: 'field'}, el('span', {}, label), control);

export function selectOptions(select, items, value) {
  select.replaceChildren(...items.map(([key, label]) => el('option', {value: key}, label)));
  if (value !== undefined && value !== null && items.some(([key]) => String(key) === String(value))) select.value = value;
  else if (items.length) select.value = items[0][0];
}
