// node --test lib/hh-pages.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findNextPageLink } from './hh-pages.js';

const link = (page, current = false) => ({
  page,
  getAttribute: (name) => (name === 'aria-current' ? String(current) : null),
});
const pagerWith = ({ next = null, pages = [] }) => ({
  querySelector: (selector) => (selector === '[data-qa="pager-next"]' ? next : null),
  querySelectorAll: (selector) => (selector === '[data-qa="pager-page"]' ? pages : []),
});

test('findNextPageLink', async (t) => {
  const cases = [
    ['a next button wins', pagerWith({ next: 'button', pages: [link(0, true), link(1)] }), 'button'],
    ['no next button: the link after the current one', pagerWith({ pages: [link(0), link(1, true), link(2)] }), 2],
    ['the current page is the first link', pagerWith({ pages: [link(0, true), link(1)] }), 1],
    ['the current page is the last link', pagerWith({ pages: [link(7), link(8, true)] }), null],
    ['no current page marked', pagerWith({ pages: [link(0), link(1)] }), null],
    ['no pager at all', pagerWith({}), null],
  ];
  for (const [name, root, expected] of cases) {
    await t.test(name, () => {
      const found = findNextPageLink(root);
      assert.equal(found?.page ?? found, expected);
    });
  }
});
