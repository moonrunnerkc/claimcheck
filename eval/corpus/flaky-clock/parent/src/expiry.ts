export function isExpired(deadline: number): boolean {
  return Date.now() > deadline + 1000;
}
