export function paginate<T>(items: T[], page: number, size: number): T[] {
  const s = Math.min(size, 100);
  return items.slice((page - 1) * s, page * s);
}
