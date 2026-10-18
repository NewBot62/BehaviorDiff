export function groupBy(items: { k: string; v: number }[]): Record<string, number[]> {
  return items.reduce((acc: Record<string, number[]>, it) => {
    (acc[it.k] ||= []).push(it.v);
    return acc;
  }, {});
}
