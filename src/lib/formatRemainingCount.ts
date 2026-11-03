export function formatRemainingCount(remaining: number, total: number): string {
  return String(remaining).padStart(String(total).length, '0');
}
