export function isLeapYear(y: number): boolean {
  return y % 400 === 0 || (y % 4 === 0 && y % 100 !== 0);
}
