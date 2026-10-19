export function label(o: { name?: string }): string {
  return o.name ?? "anonymous";
}
