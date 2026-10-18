export function isValidPassword(p: string): boolean {
  return p.length >= 8 && p.length <= 64;
}
