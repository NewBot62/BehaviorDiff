export function retryDelay(attempt: number): number {
  return Math.min(Math.pow(2, attempt) * 100, 30000);
}
