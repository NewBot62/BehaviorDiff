export function initials(name: string): string {
  return name.split(" ").filter(Boolean).map((p) => p[0]!.toUpperCase()).join("");
}
