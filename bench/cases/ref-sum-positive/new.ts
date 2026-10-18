export function sumPositive(xs: number[]): number {
  return xs.filter((x) => x > 0).reduce((a, b) => a + b, 0);
}
