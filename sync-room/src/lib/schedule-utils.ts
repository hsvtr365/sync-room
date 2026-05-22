// core schedule utility functions

export interface DateSlot {
  date: Date;
  dateStr: string; // YYYY-MM-DD
  isPast: boolean;
  isYesterday: boolean;
  label: string; // e.g. "5/22 (Fri)"
}

export interface TimeSlot {
  label: string;      // e.g. "18:00", "19:00"
  startHour: number;  // Offset hour relative to start (can be > 24 if crosses midnight)
  startMinOffset: number; // Offset in minutes from the start of the daily range
  durationMin: number;    // Duration of display unit in minutes
}

export interface DatabaseSlot {
  start_at: string;
  end_at: string;
  participant_id: string;
}

// Parse "HH:MM" format string to minute representation
export function timeStringToMinutes(timeStr: string): number {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

// Convert minutes to "HH:MM" format
export function minutesToTimeString(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// Generate the list of dates to show based on pastPolicy and rangeDays
// pastPolicy can be: 'today' (hide before today), 'yesterday' (keep yesterday, default), '7days' (keep past 7 days)
export function generateDates(rangeDays: number, pastPolicy: string): DateSlot[] {
  const dates: DateSlot[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let startOffset = 0;
  if (pastPolicy === 'yesterday') {
    startOffset = -1;
  } else if (pastPolicy === '7days') {
    startOffset = -7;
  }

  // We render from today + startOffset to today + rangeDays
  const totalDays = rangeDays - startOffset;
  const daysOfWeek = ['일', '월', '화', '수', '목', '금', '토'];

  for (let i = startOffset; i < rangeDays; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);

    const isPast = d.getTime() < today.getTime();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    const isYesterday = d.getTime() === yesterday.getTime();

    const dateStr = d.toISOString().split('T')[0];
    const label = `${d.getMonth() + 1}/${d.getDate()} (${daysOfWeek[d.getDay()]})`;

    dates.push({
      date: d,
      dateStr,
      isPast,
      isYesterday,
      label
    });
  }

  return dates;
}

// Generate intra-day time slots based on start/end times and the display unit.
// Handles midnight crossing, e.g., 18:00 to 03:00.
export function generateTimeSlots(
  timeStart: string,
  timeEnd: string,
  displayUnit: string
): TimeSlot[] {
  const startMin = timeStringToMinutes(timeStart);
  let endMin = timeStringToMinutes(timeEnd);

  // If timeEnd is before or equal to timeStart, it means it crosses midnight
  if (endMin <= startMin) {
    endMin += 24 * 60; // Add 24 hours in minutes
  }

  const totalDurationMin = endMin - startMin;

  // Determine display unit size in minutes
  let unitSizeMin = 60;
  switch (displayUnit) {
    case '15min':
      unitSizeMin = 15;
      break;
    case '30min':
      unitSizeMin = 30;
      break;
    case '1hour':
      unitSizeMin = 60;
      break;
    case '3hour':
      unitSizeMin = 180;
      break;
    case '6hour':
      unitSizeMin = 360;
      break;
    case '1day':
      unitSizeMin = totalDurationMin;
      break;
  }

  const slots: TimeSlot[] = [];
  for (let offset = 0; offset < totalDurationMin; offset += unitSizeMin) {
    const currentMin = startMin + offset;
    const label = minutesToTimeString(currentMin);
    slots.push({
      label,
      startHour: Math.floor(offset / 60),
      startMinOffset: offset,
      durationMin: Math.min(unitSizeMin, totalDurationMin - offset)
    });
  }

  return slots;
}

// Generate all 15-minute sub-slots (the database atomic block) for a specific date and absolute minutes offset.
// This matches Svelte client coordinate to precise 15-minute interval start/end Date objects.
export function getAbsoluteSlotDates(
  dateSlot: DateSlot,
  timeStart: string,
  startMinOffset: number,
  durationMin: number
): { start: Date; end: Date } {
  const baseDate = new Date(dateSlot.date);
  const startHours = timeStringToMinutes(timeStart);

  // Set time of the base date to the room's start time + the current slot's offset
  const absoluteStartMin = startHours + startMinOffset;

  const start = new Date(baseDate);
  start.setMinutes(start.getMinutes() + absoluteStartMin);

  const end = new Date(start);
  end.setMinutes(end.getMinutes() + durationMin);

  return { start, end };
}

// Generate standard 15-minute intervals inside a specific time slot to execute multi-slot toggling
export function get15MinSubSlots(
  dateSlot: DateSlot,
  timeStart: string,
  slot: TimeSlot
): { start: Date; end: Date; startISO: string; endISO: string }[] {
  const subSlots: { start: Date; end: Date; startISO: string; endISO: string }[] = [];
  const { start, end } = getAbsoluteSlotDates(dateSlot, timeStart, slot.startMinOffset, slot.durationMin);

  let current = new Date(start);
  while (current < end) {
    const next = new Date(current);
    next.setMinutes(current.getMinutes() + 15);
    subSlots.push({
      start: new Date(current),
      end: next,
      startISO: current.toISOString(),
      endISO: next.toISOString()
    });
    current = next;
  }
  return subSlots;
}

// Check display unit constraints as per Rule 9
// - 15min: range <= 2 hours
// - 30min: range <= 6 hours
// - 1hour+: 24 hours allowed
export function isUnitAllowed(timeStart: string, timeEnd: string, unit: string): boolean {
  const startMin = timeStringToMinutes(timeStart);
  let endMin = timeStringToMinutes(timeEnd);
  if (endMin <= startMin) {
    endMin += 24 * 60;
  }
  const diffHours = (endMin - startMin) / 60;

  if (unit === '15min') {
    return diffHours <= 2;
  }
  if (unit === '30min') {
    return diffHours <= 6;
  }
  return true; // 1hour, 3hour, 6hour, 1day are always allowed
}

// Fallback utility if unit constraint fails: returns recommended unit
export function getRecommendedUnit(timeStart: string, timeEnd: string): string {
  const startMin = timeStringToMinutes(timeStart);
  let endMin = timeStringToMinutes(timeEnd);
  if (endMin <= startMin) {
    endMin += 24 * 60;
  }
  const diffHours = (endMin - startMin) / 60;

  if (diffHours <= 2) return '15min';
  if (diffHours <= 6) return '30min';
  return '1hour';
}

// Helper to determine if a 15-minute sub-slot overlaps with unavailable slots list
export function isSubSlotUnavailable(
  startISO: string,
  endISO: string,
  userSlots: { start_at: string; end_at: string }[]
): boolean {
  const sTime = new Date(startISO).getTime();
  const eTime = new Date(endISO).getTime();

  return userSlots.some(slot => {
    const slotStart = new Date(slot.start_at).getTime();
    const slotEnd = new Date(slot.end_at).getTime();
    return sTime < slotEnd && eTime > slotStart;
  });
}

// Get local date string as 'YYYY-MM-DD'
export function getTodayStr(): string {
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// Convert YYYY-MM-DD to a local Date object (at local midnight 00:00:00)
export function parseLocalDate(dateStr: string): Date {
  const [yyyy, mm, dd] = dateStr.split('-').map(Number);
  return new Date(yyyy, mm - 1, dd, 0, 0, 0, 0);
}

// Convert rangeDays to the end date ('YYYY-MM-DD') from today (inclusive)
export function getEndDateFromDays(days: number): string {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const end = new Date(today);
  end.setDate(today.getDate() + (days - 1));
  const yyyy = end.getFullYear();
  const mm = String(end.getMonth() + 1).padStart(2, '0');
  const dd = String(end.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// Calculate the number of days between today (inclusive) and endDateStr (inclusive)
export function getDaysFromEndDate(endDateStr: string): number {
  if (!endDateStr) return 7;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const end = parseLocalDate(endDateStr);

  const diffTime = end.getTime() - today.getTime();
  const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24)) + 1;
  return diffDays > 0 ? diffDays : 1;
}
