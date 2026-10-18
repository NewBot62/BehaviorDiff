export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(Math.min(n, hi), lo);
}
