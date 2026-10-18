export function groupBy(items: { k: string; v: number }[]): Record<string, number[]> {
  const acc: Record<string, number[]> = {};
  for (const it of items) {
    if (!acc[it.k]) acc[it.k] = [];
    acc[it.k]!.push(it.v);
  }
  return acc;
}
