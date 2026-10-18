export function total(items: { price: number; qty: number }[]): number {
  return items.reduce((s, i) => s + i.price * i.qty, 0);
}
