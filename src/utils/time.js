const { DateTime } = require('luxon');

function toISODate(d) {
  if (!d) return null;
  const dt = typeof d === 'string' ? DateTime.fromISO(d, { zone: 'utc' }) : DateTime.fromJSDate(d, { zone: 'utc' });
  return dt.isValid ? dt.toISODate() : null;
}
function toMonday(dateISO) {
  const d = DateTime.fromISO(dateISO, { zone: 'utc' });
  return d.startOf('week').toISODate();
}
function weekRange(weekStartISO) {
  const start = DateTime.fromISO(weekStartISO, { zone: 'utc' }).startOf('day');
  const end = start.plus({ days: 7 });
  return { start, end };
}
function hoursToSlots(dateISO, hours) {
  const base = DateTime.fromISO(dateISO, { zone: 'utc' }).startOf('day');
  return hours.map((h) => {
    const start = base.set({ hour: h, minute: 0, second: 0, millisecond: 0 });
    const end = start.plus({ hours: 1 });
    return { slotISO: start.toISO(), start, end, hour: h };
  });
}

function fmtDateOnly(v) {
  if (!v) return null;
  const d = v instanceof Date ? DateTime.fromJSDate(v, { zone: 'utc' }) : DateTime.fromISO(String(v), { zone: 'utc' });
  return d.isValid ? d.toFormat('yyyy-LL-dd') : v;
}
function fmtDateTime(v) {
  if (!v) return null;
  const d = v instanceof Date ? DateTime.fromJSDate(v, { zone: 'utc' }) : DateTime.fromISO(String(v), { zone: 'utc' });
  return d.isValid ? d.toFormat('yyyy-LL-dd HH:mm:ss') : v;
}

module.exports = { toISODate, toMonday, weekRange, hoursToSlots, DateTime, fmtDateOnly, fmtDateTime };
