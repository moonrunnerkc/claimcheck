export function clampUpper(n: number, max: number): number {
  if (n > max) {
    return max;
  }
  return n;
}
