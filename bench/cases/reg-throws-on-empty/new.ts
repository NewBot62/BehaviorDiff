export function initials(name: string): string {
  const t = name.trim();
  if (t.length === 0) throw new Error("empty name");
  return t.split(" ").filter(Boolean).map((p) => p[0]!.toUpperCase()).join("");
}
