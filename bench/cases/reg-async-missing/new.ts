const DB: Record<number, string> = { 1: "ann", 2: "bob" };
const cache = new Map<number, string>();
export async function lookup(id: number): Promise<string> {
  if (cache.has(id)) return cache.get(id)!;
  const v = DB[id];
  if (v !== undefined) cache.set(id, v);
  return v as string;
}
