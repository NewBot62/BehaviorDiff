export function parseBool(s: string): boolean {
  const v = s.trim().toLowerCase();
  return v === "true" || v === "1";
}
