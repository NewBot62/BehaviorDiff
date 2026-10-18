export interface Item { id: number; v: string }
export function uniqueById(items: Item[]): Item[] {
  const m = new Map<number, Item>();
  for (const it of items) m.set(it.id, it);
  return [...m.values()];
}
