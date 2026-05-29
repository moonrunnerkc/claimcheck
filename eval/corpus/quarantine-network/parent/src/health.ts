export async function checkHealth(url: string): Promise<boolean> {
  const res = await fetch(url);
  return res.status === 200;
}
