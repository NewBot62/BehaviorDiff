export interface Item { id: number; v: string }
export function uniqueById(items: Item[]): Item[] {
  const seen = new Set<number>();
  const out: Item[] = [];
  for (const it of items) {
    if (!seen.has(it.id)) { seen.add(it.id); out.push(it); }
  }
  return out;
}
