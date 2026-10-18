const RATE = 0.9;
export function discount(price: number): number {
  return price > 100 ? price * RATE : price;
}
