export function shippingCost(total: number): number {
  return total >= 50 ? 0 : 5.99;
}
