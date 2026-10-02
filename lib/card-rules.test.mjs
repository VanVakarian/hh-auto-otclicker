// node --test lib/card-rules.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SkipReason, skipReasonOf } from './card-rules.js';
import { normalizeWordGroups } from './matching.js';

const rules = (overrides = {}) => ({
  processed: new Set(),
  blockedIds: new Set(),
  companyLines: normalizeWordGroups('Рога и копыта\nАдминистрация Самары'),
  titleStopWordLines: normalizeWordGroups('стажёр\nsenior sales'),
  ...overrides,
});
const card = (overrides = {}) => ({ vacancyId: '1', title: 'Project Manager', company: 'Acme', ...overrides });

test('skipReasonOf', async (t) => {
  await t.test('a plain card is a candidate', () => {
    assert.equal(skipReasonOf(card(), rules()), null);
  });

  await t.test('processed on this page', () => {
    assert.equal(skipReasonOf(card(), rules({ processed: new Set(['1']) })), SkipReason.PROCESSED);
  });

  await t.test('blacklisted', () => {
    assert.equal(skipReasonOf(card(), rules({ blockedIds: new Set(['1']) })), SkipReason.BLACKLISTED);
  });

  await t.test('a blacklisted company, its words need not be adjacent', () => {
    assert.equal(skipReasonOf(card({ company: 'Администрация города Самары' }), rules()), SkipReason.COMPANY);
  });

  await t.test('a stop word in the title', () => {
    assert.equal(skipReasonOf(card({ title: 'Стажёр-аналитик' }), rules()), SkipReason.TITLE_STOP_WORD);
  });

  await t.test('the order: processed, blacklisted, company, title', () => {
    const everything = card({ company: 'Рога и копыта', title: 'Стажёр' });
    const all = rules({ processed: new Set(['1']), blockedIds: new Set(['1']) });
    assert.equal(skipReasonOf(everything, all), SkipReason.PROCESSED);
    assert.equal(skipReasonOf(everything, { ...all, processed: new Set() }), SkipReason.BLACKLISTED);
    assert.equal(skipReasonOf(everything, { ...all, processed: new Set(), blockedIds: new Set() }), SkipReason.COMPANY);
  });

  await t.test('no rules, nothing is skipped', () => {
    const none = { processed: new Set(), blockedIds: new Set(), companyLines: [], titleStopWordLines: [] };
    assert.equal(skipReasonOf(card({ title: 'Стажёр' }), none), null);
  });
});
