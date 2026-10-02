// What the extension spends is billed in dollars (that is how OpenRouter reports it) and kept in dollars; a
// person reads it in rubles. One rough rate, in one place: a dollar is a hundred rubles.
export const RUBLES_PER_USD = 100;

const KOPECKS_PER_RUBLE = 100;

// the Russian plural form of a counted noun: 1 рубль, 2 рубля, 5 рублей, 11 рублей, 21 рубль
function plural(count, [one, few, many]) {
  if (count % 10 === 1 && count % 100 !== 11) return one;
  if (count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 12 || count % 100 > 14)) return few;
  return many;
}

const rubles = (count) => `${count} ${plural(count, ['рубль', 'рубля', 'рублей'])}`;
const kopecks = (count) => `${count} ${plural(count, ['копейка', 'копейки', 'копеек'])}`;

// A request to the vacancy classifier costs about a fifth of a kopeck, so below a kopeck the amount is shown in
// tenths — otherwise the price of one request would read as zero.
//   12.4 rubles → «12 рублей 40 копеек», 0.4 → «40 копеек», 0.002 → «0,2 копейки», 0 → «0 копеек»
export function formatRubles(usd) {
  const totalKopecks = usd * RUBLES_PER_USD * KOPECKS_PER_RUBLE;

  const tenths = Math.round(totalKopecks * 10);
  if (totalKopecks > 0 && tenths < 10) {
    return tenths === 0 ? 'меньше 0,1 копейки' : `${(tenths / 10).toString().replace('.', ',')} копейки`;
  }

  const whole = Math.round(totalKopecks);
  const wholeRubles = Math.floor(whole / KOPECKS_PER_RUBLE);
  const restKopecks = whole % KOPECKS_PER_RUBLE;
  if (wholeRubles === 0) return kopecks(restKopecks);
  return restKopecks === 0 ? rubles(wholeRubles) : `${rubles(wholeRubles)} ${kopecks(restKopecks)}`;
}
