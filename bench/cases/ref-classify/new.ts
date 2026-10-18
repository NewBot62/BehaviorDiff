export function classify(n: number): string {
  return n < 0 ? "neg" : n === 0 ? "zero" : "pos";
}
