// Phoenix is UTC-7 year-round. Expressing its business clock in UTC avoids
// dependence on the worker host timezone and daylight-saving-time settings.
export function nextBusinessTime(timestamp: number): number {
  let local = new Date(timestamp - 7 * 60 * 60_000);
  const day = local.getUTCDay();
  const hour = local.getUTCHours();
  if (day >= 2 && day <= 6 && hour >= 9 && hour < 18) return timestamp;
  if (day >= 2 && day <= 6 && hour < 9) local.setUTCHours(9, 0, 0, 0);
  else {
    local.setUTCDate(local.getUTCDate() + 1);
    local.setUTCHours(9, 0, 0, 0);
    while (local.getUTCDay() < 2) local.setUTCDate(local.getUTCDate() + 1);
  }
  return local.getTime() + 7 * 60 * 60_000;
}

