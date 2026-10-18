export function taxRate(country: "US" | "FR" | "DE" | "CA"): number {
  switch (country) {
    case "US": return 0.07;
    case "FR": return 0.2;
    case "DE": return 0.19;
    case "CA": return 0.05;
    default: return 0;
  }
}
