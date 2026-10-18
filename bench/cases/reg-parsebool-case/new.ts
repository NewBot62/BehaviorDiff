export function parseBool(s: string): boolean {
  const v = s.trim();
  return v === "true" || v === "1" || v === "yes";
}
