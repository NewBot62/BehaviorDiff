export function average(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
