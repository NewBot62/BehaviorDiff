export function normalizePhone(s: string): string {
  return "+33" + s.replace(/\D/g, "").slice(-10);
}
