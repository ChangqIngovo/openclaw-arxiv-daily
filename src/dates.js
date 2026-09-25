export const DAY = 86_400_000;
const formatters = new Map(), windows = new Map();

export function localStamp(now, timeZone) {
  if (!formatters.has(timeZone)) formatters.set(timeZone, new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }));
  const p = Object.fromEntries(formatters.get(timeZone).formatToParts(new Date(now)).map(p => [p.type, p.value]));
  return {day: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`};
}

// Find the first instant of a civil date, including 23/25-hour DST days.
// Date arithmetic in the host OS timezone would give the wrong Beijing window.
function startOfDay(day, timeZone) {
  const nominal = Date.parse(`${day}T00:00:00Z`);
  let low = nominal - 36 * 3_600_000, high = nominal + 36 * 3_600_000;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (localStamp(middle, timeZone).day < day) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function previousDayWindow(now, timeZone = 'Asia/Shanghai') {
  const today = localStamp(now, timeZone).day;
  const cached = windows.get(timeZone);
  if (cached?.today === today) return cached;
  const day = new Date(Date.parse(`${today}T12:00:00Z`) - DAY).toISOString().slice(0, 10);
  const window = Object.freeze({day, today, timeZone, since: startOfDay(day, timeZone), until: startOfDay(today, timeZone)});
  windows.set(timeZone, window);
  return window;
}

export const inWindow = (paper, window) => Boolean(paper && paper.published >= window.since && paper.published < window.until);
export const isCurrentWindow = (window, now) => localStamp(now, window.timeZone).day === window.today;
