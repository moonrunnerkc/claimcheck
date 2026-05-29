export function parseTimeout(raw: string): number {
  return (JSON.parse(raw) as { timeout: number }).timeout;
}
