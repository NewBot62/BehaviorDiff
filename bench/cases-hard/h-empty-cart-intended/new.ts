export function maxPrice(prices: number[]): number {
  return prices.length === 0 ? 0 : Math.max(...prices);
}
