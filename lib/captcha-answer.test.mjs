// node --test lib/captcha-answer.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractAnswer } from './captcha-answer.js';

test('extractAnswer', async (t) => {
  const cases = [
    ['plain marker', 'ANSWER: восхи укладисто', 'восхи укладисто'],
    ['working before the marker is ignored', 'в о с х и\nу к л а д и с т о\nANSWER: восхи укладисто', 'восхи укладисто'],
    ['the last marker wins', 'ANSWER: раз два\nпоправка\nANSWER: три четыре', 'три четыре'],
    ['marker case and spacing', 'answer:   Благу   Смиришься  ', 'благу смиришься'],
    ['answer on the line after the marker', 'ANSWER:\nпучит сгущенное', 'пучит сгущенное'],
    ['markdown and quotes are stripped', '**ANSWER:** «домбра» "непутево"', 'домбра непутево'],
    ['trailing punctuation is stripped', 'ANSWER: выращенной беты.', 'выращенной беты'],
    ['ё is kept', 'ANSWER: ёлка стоит', 'ёлка стоит'],
    ['hyphenated word', 'ANSWER: кто-то стоит', 'кто-то стоит'],
    ['one word', 'ANSWER: люка', 'люка'],
    ['four words', 'ANSWER: раз два три четыре', 'раз два три четыре'],
    ['no marker', 'восхи укладисто', null],
    ['empty marker', 'ANSWER:', null],
    ['null content', null, null],
    ['latin letters', 'ANSWER: voshi ukladisto', null],
    ['digits', 'ANSWER: восхи 123', null],
    ['mixed alphabets inside a word', 'ANSWER: восxи укладисто', null],
    ['five words', 'ANSWER: раз два три четыре пять', null],
    ['a sentence with punctuation inside', 'ANSWER: я не могу, извините', null],
    ['too long', `ANSWER: ${'а'.repeat(61)}`, null],
  ];

  for (const [name, content, expected] of cases) {
    await t.test(name, () => assert.equal(extractAnswer(content), expected));
  }
});
