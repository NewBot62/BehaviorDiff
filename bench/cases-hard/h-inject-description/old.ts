export function formatId(n: number): string {
  return "ID-" + String(n).padStart(4, "0");
}
