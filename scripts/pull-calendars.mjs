#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FACILITIES = [
  {
    id: 'sportslink-vermont',
    name: 'Sportslink (Vermont)',
    endpoint:
      'https://aqualink.perfectgym.com.au/ClientPortal2/api/Calendars/ClubZoneOccupancyCalendar/GetCalendar?calendarId=3ce734397',
  },
  {
    id: 'boroondara-sports-complex',
    name: 'Boroondara Sports Complex',
    endpoint:
      'https://boroondaraleisure.perfectgym.com.au/ClientPortal2/api/Calendars/ClubZoneOccupancyCalendar/GetCalendar?calendarId=3a1132fc5&requestedDate=2026-03-05',
  },
  {
    id: 'aqualink-box-hill',
    name: 'Aqualink Box Hill',
    endpoint:
      'https://aqualink.perfectgym.com.au/ClientPortal2/api/Calendars/ClubZoneOccupancyCalendar/GetCalendar?calendarId=6b1539a68',
  },
  {
    id: 'mullum-mullum-stadium',
    name: 'Mullum Mullum Stadium',
    endpoint:
      'https://activemanningham.perfectgym.com.au/ClientPortal2/api/Calendars/ClubZoneOccupancyCalendar/GetCalendar?calendarId=84e1bb164',
  },
  {
    id: 'dandenong-stadium',
    name: 'Dandenong Stadium',
    endpoint:
      'https://southeastleisure.perfectgym.com.au/ClientPortal2/api/Calendars/ClubZoneOccupancyCalendar/GetCalendar?calendarId=81c46f306',
  },
  {
    id: 'oakleigh-rec-centre',
    name: 'Oakleigh Recreation Centre',
    endpoint:
      'https://activemonash.perfectgym.com.au/ClientPortal2/api/Calendars/ClubZoneOccupancyCalendar/GetCalendar?calendarId=68534c6610&daysPerPage=4',
  },
];

const HOURS = Array.from({ length: 16 }, (_, index) => 8 + index); // 8am–11pm
const WEEK_DAYS = 7;

if (typeof fetch !== 'function') {
  console.error('This script requires Node.js 18+ (built-in fetch).');
  process.exit(1);
}

const args = process.argv.slice(2);
const outFlag = args.indexOf('--out');
const customOut = outFlag !== -1 ? args[outFlag + 1] : null;
const cwd = process.cwd();
const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const defaultOut = path.resolve(path.join(repoRoot, '..', 'data', 'calendars.json'));
const outputPath = path.resolve(cwd, customOut || defaultOut);
const requestedDates = buildRequestedDates(WEEK_DAYS);

main().catch((error) => {
  console.error('Failed to build snapshot:', error);
  process.exit(1);
});

async function main() {
  const results = await Promise.allSettled(
    FACILITIES.map((facility) => fetchFacilitySnapshot(facility, requestedDates))
  );

  const facilities = [];
  const errors = [];
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      facilities.push(result.value);
    } else {
      errors.push({ facility: FACILITIES[index].name, message: result.reason.message });
    }
  });

  const snapshot = {
    generatedAt: new Date().toISOString(),
    days: requestedDates,
    hours: HOURS,
    facilities,
    errors,
  };

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(snapshot, null, 2));
  console.log(`Saved snapshot to ${outputPath}`);
}

async function fetchFacilitySnapshot(facility, requestedDates) {
  const slots = [];
  const coveredDays = new Set();

  for (const dateString of requestedDates) {
    const url = buildUrlForDate(facility.endpoint, dateString);
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }
    const payload = await response.json();
    slots.push(...extractSlots(payload, coveredDays));
  }

  const missingDays = requestedDates.filter((date) => !coveredDays.has(date));
  for (const dateString of missingDays) {
    const extraUrl = buildUrlWithStartDate(facility.endpoint, dateString);
    const response = await fetch(extraUrl, { headers: { Accept: 'application/json' } });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${extraUrl}`);
    }
    const payload = await response.json();
    slots.push(...extractSlots(payload, coveredDays));
    if (coveredDays.size >= requestedDates.length) break;
  }

  const hourly = buildHourlyGrid(slots, requestedDates);
  const intervals = slots.map((slot) => ({
    start: slot.start.toISOString(),
    end: slot.end.toISOString(),
    available: slot.available,
    capacity: slot.capacity,
    label: slot.isClosed ? 'N/A' : `${slot.available}/${slot.capacity}`,
    isClosed: slot.isClosed,
  }));

  return { ...facility, intervals, hourly };
}

function buildUrlForDate(endpoint, dateString) {
  return buildUrlWithParam(endpoint, 'requestedDate', dateString);
}

function buildUrlWithStartDate(endpoint, dateString) {
  return buildUrlWithParam(endpoint, 'startDate', dateString);
}

function buildUrlWithParam(endpoint, key, value) {
  const url = new URL(endpoint);
  url.searchParams.delete('requestedDate');
  url.searchParams.delete('startDate');
  url.searchParams.set(key, value);
  return url.toString();
}

function extractSlots(payload, coveredDays = null) {
  const output = [];
  (payload.dayBlocks || []).forEach((block) => {
    const dateString = block.date;
    (block.hours || []).forEach((entry) => {
      const start = parseDayTime(dateString, entry.fromHour);
      const end = parseDayTime(dateString, entry.toHour);
      if (!start || !end) return;
      const available = toNumber(entry.totalCountOfOccupancyAvailability);
      const capacity = toNumber(entry.numberOfFacilities);
      const isClosed = entry.isAvailable === false;
      if (coveredDays) {
        coveredDays.add(formatDayKey(startOfDay(start)));
      }
      output.push({
        start,
        end,
        available: isClosed ? 0 : available ?? 0,
        capacity: capacity ?? available ?? 0,
        isClosed,
      });
    });
  });
  return output.sort((a, b) => a.start - b.start);
}

function buildHourlyGrid(slots, requestedDates) {
  const grid = {};
  requestedDates.forEach((dateString) => {
    const day = startOfDay(new Date(`${dateString}T00:00:00`));
    const key = formatDayKey(day);
    grid[key] = {};
    HOURS.forEach((hour) => {
      grid[key][hour] = summarizeSlot(slots, day, hour);
    });
  });
  return grid;
}

function summarizeSlot(slots, day, hour) {
  const midpoint = new Date(day);
  midpoint.setHours(hour, 30, 0, 0);
  const slot = slots.find((entry) => entry.start <= midpoint && entry.end >= midpoint);

  if (!slot) {
    return { label: 'N/A', level: 'empty', available: null, capacity: null, closed: true };
  }

  if (slot.isClosed) {
    return { label: 'N/A', level: 'empty', available: 0, capacity: slot.capacity, closed: true };
  }

  const available = Math.max(0, slot.available ?? 0);
  const capacity = slot.capacity ?? available;
  const ratio = capacity ? available / capacity : 0;
  const level = ratio === 0 ? 'empty' : ratio < 0.25 ? 'low' : ratio < 0.75 ? 'medium' : 'high';
  return {
    label: `${available}/${capacity}`,
    level,
    available,
    capacity,
    closed: false,
  };
}

function parseDayTime(dateString, timeObject) {
  if (!dateString || !timeObject) return null;
  const raw =
    (typeof timeObject === 'string' && timeObject) ||
    timeObject.value ||
    timeObject.name ||
    null;
  if (!raw) return null;
  const normalized = raw.length === 5 ? `${raw}:00` : raw;
  const iso = `${dateString}T${normalized}`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

function buildRequestedDates(days) {
  const start = startOfDay(new Date());
  return Array.from({ length: days }, (_, index) => formatDayKey(addDays(start, index)));
}

function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

function startOfDay(date) {
  const clone = new Date(date);
  clone.setHours(0, 0, 0, 0);
  return clone;
}

function addDays(date, amount) {
  const clone = new Date(date);
  clone.setDate(clone.getDate() + amount);
  return startOfDay(clone);
}

function formatDayKey(date) {
  return `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, '0')}-${`${date.getDate()}`.padStart(2, '0')}`;
}
