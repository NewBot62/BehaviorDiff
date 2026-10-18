export function discount(price: number): number {
  return price >= 100 ? price * 0.9 : price;
}
