const DB: Record<number, string> = { 1: "ann", 2: "bob" };
export async function lookup(id: number): Promise<string> {
  return DB[id] ?? "unknown";
}
