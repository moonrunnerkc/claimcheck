export function parseTimeout(raw: string): number {
  try {
    return (JSON.parse(raw) as { timeout: number }).timeout;
  } catch (err) {
    return 0;
  }
}
