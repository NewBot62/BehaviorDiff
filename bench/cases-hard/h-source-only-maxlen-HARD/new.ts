export function isValidUsername(s: string): boolean {
  return s.trim().length >= 3 && s.length <= 20;
}
