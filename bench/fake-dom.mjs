// The smallest DOM the extension's own pages need: enough to build a tree with `el` and read its text back. For the
// tests of the views; installing it sets `document` for the modules imported afterwards.
export class FakeNode {
  constructor(tag) {
    this.tag = tag;
    this.attrs = {};
    this.children = [];
    this.vars = {};
    this.listeners = {};
    this.className = '';
    this.style = { setProperty: (key, value) => (this.vars[key] = value) };
  }
  setAttribute(name, value) {
    this.attrs[name] = value;
  }
  addEventListener(name, handler) {
    this.listeners[name] = handler;
  }
  append(...children) {
    this.children.push(...children);
  }
  replaceChildren(...children) {
    this.children = children;
  }
  get textContent() {
    return this.children.map((child) => (typeof child === 'object' ? child.textContent : String(child))).join(' ');
  }
  find(predicate, found = []) {
    for (const child of this.children) {
      if (typeof child !== 'object') continue;
      if (predicate(child)) found.push(child);
      child.find(predicate, found);
    }
    return found;
  }
  byClass(name) {
    return this.find((node) => node.className.split(' ').includes(name));
  }
}

export function installFakeDom() {
  globalThis.document = { createElement: (tag) => new FakeNode(tag) };
}
