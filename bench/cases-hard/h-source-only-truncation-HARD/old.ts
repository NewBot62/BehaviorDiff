export function normalizePhone(s: string): string {
  return s.replace(/\D/g, "");
}
