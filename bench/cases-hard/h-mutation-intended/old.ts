export function sortAsc(xs: number[]): number[] {
  return [...xs].sort((a, b) => a - b);
}
