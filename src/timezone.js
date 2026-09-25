import { execFileSync } from 'node:child_process';

export const SYSTEM_TIME_ZONE = 'system';
export const TIME_ZONE_REFRESH_MS = 30_000;
const knownZones = new Map();

function validTimeZone(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('无法读取电脑时区，请检查系统日期与时间设置。');
  if (!knownZones.has(value)) knownZones.set(value, new Intl.DateTimeFormat('en', {timeZone:value}).resolvedOptions().timeZone);
  return knownZones.get(value);
}

export function readSystemTimeZone() {
  // A fresh process avoids ICU's cached default zone after an OS timezone change.
  // Ignore a fixed TZ environment override so "system" means the computer setting.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'TZ'));
  return validTimeZone(execFileSync(process.execPath,
    ['-p', 'Intl.DateTimeFormat().resolvedOptions().timeZone'],
    {encoding:'utf8', env, timeout:2000, maxBuffer:4096, windowsHide:true, stdio:['ignore','pipe','pipe']}).trim());
}

export function createSystemTimeZoneResolver({read = readSystemTimeZone, clock = Date.now, refreshMs = TIME_ZONE_REFRESH_MS} = {}) {
  let cached, checkedAt;
  return () => {
    const now = clock();
    if (cached && now >= checkedAt && now - checkedAt < refreshMs) return cached;
    try {
      cached = validTimeZone(read()); checkedAt = now;
    } catch {
      // Do not continue a digest with a stale zone after a failed refresh.
      cached = undefined;
      throw new Error('无法读取电脑时区，请检查系统日期与时间设置后重试。');
    }
    return cached;
  };
}

export const computerClock = {timeZone:createSystemTimeZoneResolver()};

export function effectiveTimeZone(setting = SYSTEM_TIME_ZONE) {
  return setting === SYSTEM_TIME_ZONE ? computerClock.timeZone() : validTimeZone(setting);
}

export function timeZoneLabel(setting = SYSTEM_TIME_ZONE) {
  const zone = effectiveTimeZone(setting);
  return setting === SYSTEM_TIME_ZONE ? `${zone}（跟随电脑）` : zone;
}
