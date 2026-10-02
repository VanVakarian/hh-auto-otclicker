import test from 'node:test';
import assert from 'node:assert/strict';
import { formatRubles } from './money.js';

test('formatRubles', async (t) => {
  const cases = [
    [0, '0 копеек'],
    [0.00002, '0,2 копейки'], // the price of one classifier request
    [0.00001, '0,1 копейки'],
    [0.0000001, 'меньше 0,1 копейки'],
    [0.0001, '1 копейка'],
    [0.0002, '2 копейки'],
    [0.0005, '5 копеек'],
    [0.0011, '11 копеек'],
    [0.0021, '21 копейка'],
    [0.004, '40 копеек'],
    [0.01, '1 рубль'],
    [0.02, '2 рубля'],
    [0.05, '5 рублей'],
    [0.11, '11 рублей'],
    [0.21, '21 рубль'],
    [0.124, '12 рублей 40 копеек'],
    [0.1241, '12 рублей 41 копейка'],
    [1.5, '150 рублей'],
  ];
  for (const [usd, expected] of cases) {
    await t.test(`$${usd} is «${expected}»`, () => assert.equal(formatRubles(usd), expected));
  }

  await t.test('tenths stop where they would round up to a whole kopeck', () => {
    assert.equal(formatRubles(0.000094), '0,9 копейки');
    assert.equal(formatRubles(0.000099), '1 копейка');
  });
});
