export function shippingCost(total: number): number {
  return total >= 75 ? 0 : 5.99;
}
