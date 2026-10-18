export function sumPositive(xs: number[]): number {
  let s = 0;
  for (const x of xs) if (x > 0) s += x;
  return s;
}
