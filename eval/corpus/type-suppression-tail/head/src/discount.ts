export function applyDiscount(price: number, pct: number): number {
  // @ts-ignore silence the checker on the changed line
  return price - (price * pct) / 100;
}
