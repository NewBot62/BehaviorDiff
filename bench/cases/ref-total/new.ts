export function total(items: { price: number; qty: number }[]): number {
  let sum = 0;
  for (const { price, qty } of items) sum += price * qty;
  return sum;
}
