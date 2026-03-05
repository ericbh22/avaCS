const FACILITIES = [
  { id: 'oakleigh-rec-centre', short: 'Oakleigh' },
  { id: 'boroondara-sports-complex', short: 'BSC' },
  { id: 'sportslink-vermont', short: 'Sportslink' },
  { id: 'aqualink-box-hill', short: 'Aqualink' },
  { id: 'mullum-mullum-stadium', short: 'Mullum' },
  { id: 'dandenong-stadium', short: 'Dande' },
  { id: 'darebin-civic-centre', short: 'Darebin' },
];

const SNAPSHOT_URL = 'data/calendars.json';
const DEFAULT_HOURS = Array.from({ length: 16 }, (_, i) => 8 + i); // 8am–11pm
const DAYS_TO_RENDER = 7;

const state = {
  facilities: [],
  mappedFacilities: new Map(),
  hours: DEFAULT_HOURS,
  days: [],
  activeDayIndex: 0,
  generatedAt: null,
  errors: [],
};

const dateLabelEl = document.querySelector('#calendar-date');
const rangeLabelEl = document.querySelector('#calendar-range');
const hourRowEl = document.querySelector('#hour-row');
const facilityRowsEl = document.querySelector('#facility-rows');
const statusMessageEl = document.querySelector('#status-message');
const prevButton = document.querySelector('#prev-day');
const nextButton = document.querySelector('#next-day');

init();

function init() {
  prevButton.addEventListener('click', () => moveDay(-1));
  nextButton.addEventListener('click', () => moveDay(1));
  loadSnapshot();
}

async function loadSnapshot() {
  setStatus('Loading snapshot…');
  try {
    const response = await fetch(SNAPSHOT_URL, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Snapshot unavailable (HTTP ${response.status})`);
    const snapshot = await response.json();
    applySnapshot(snapshot);
    renderView();
  } catch (error) {
    facilityRowsEl.innerHTML = '<p class="calendar-empty">Could not load snapshot.</p>';
    setStatus(error.message);
  }
}

function applySnapshot(snapshot) {
  state.facilities = snapshot.facilities || [];
  state.hours = snapshot.hours?.length ? snapshot.hours : DEFAULT_HOURS;
  state.generatedAt = snapshot.generatedAt ? new Date(snapshot.generatedAt) : null;
  state.errors = snapshot.errors || [];

  state.mappedFacilities = new Map(state.facilities.map((facility) => [facility.id, facility]));

  const providedDays = (snapshot.days || []).map((day) => startOfDay(new Date(day))).filter(isValidDate);
  state.days = ensureDays(providedDays, state.facilities);
  state.activeDayIndex = 0;
}

function ensureDays(days, facilities) {
  const list = days.slice(0, DAYS_TO_RENDER);
  const fallbackStart = getEarliestSlotDate(facilities) || startOfDay(new Date());
  if (!list.length) {
    list.push(fallbackStart);
  }
  while (list.length < DAYS_TO_RENDER) {
    list.push(addDays(list[list.length - 1], 1));
  }
  return list;
}

function renderView() {
  if (!state.days.length) {
    facilityRowsEl.innerHTML = '<p class="calendar-empty">No dated availability in snapshot.</p>';
    hourRowEl.innerHTML = '';
    setStatus('No dates available.');
    return;
  }

  const activeDay = state.days[state.activeDayIndex];
  const hours = state.hours;

  dateLabelEl.textContent = formatLongDate(activeDay);
  rangeLabelEl.textContent = `${formatHour(hours[0])} – ${formatHour(hours[hours.length - 1])}`;
  prevButton.disabled = state.activeDayIndex === 0;
  nextButton.disabled = state.activeDayIndex === state.days.length - 1;

  renderHours(hours);
  renderFacilities(activeDay, hours);
  updateStatusFooter();
}

function renderHours(hours) {
  hourRowEl.innerHTML = '';
  hours.forEach((hour) => {
    const span = document.createElement('span');
    span.textContent = formatHour(hour);
    hourRowEl.appendChild(span);
  });
}

function renderFacilities(day, hours) {
  facilityRowsEl.innerHTML = '';
  const dayKey = formatDayKey(day);

  FACILITIES.forEach((meta) => {
    const facility = state.mappedFacilities.get(meta.id);
    const row = document.createElement('div');
    row.className = 'calendar-row calendar-row--data';

    const name = document.createElement('div');
    name.className = 'facility-name';
    name.textContent = facility?.short || meta.short;

    const hourCells = document.createElement('div');
    hourCells.className = 'hour-cells';

    hours.forEach((hour) => {
      const cell = document.createElement('span');
      cell.className = 'hour-cell-value';
      const summary = resolveSummary(facility, dayKey, hour, day);
      cell.dataset.level = summary.level;
      cell.textContent = summary.label;
      hourCells.appendChild(cell);
    });

    row.appendChild(name);
    row.appendChild(hourCells);
    facilityRowsEl.appendChild(row);
  });
}

function resolveSummary(facility, dayKey, hour, date) {
  if (!facility) return makeSummary();
  const snapshotCell = facility.hourly?.[dayKey]?.[hour];
  if (snapshotCell) {
    return makeSummary(snapshotCell.label, snapshotCell.level, snapshotCell.available, snapshotCell.capacity, snapshotCell.closed);
  }

  const slot = (facility.intervals || []).find((interval) => {
    const midpoint = new Date(date);
    midpoint.setHours(hour, 30, 0, 0);
    return new Date(interval.start) <= midpoint && new Date(interval.end) >= midpoint;
  });

  if (!slot) return makeSummary();
  const available = toNumber(slot.available);
  const capacity = toNumber(slot.capacity);
  const safeAvailable = Math.max(0, available ?? 0);
  const safeCapacity = capacity ?? safeAvailable;
  const ratio = safeCapacity ? safeAvailable / safeCapacity : 0;
  const level = ratio === 0 ? 'empty' : ratio < 0.25 ? 'low' : ratio < 0.75 ? 'medium' : 'high';
  return makeSummary(`${safeAvailable}/${safeCapacity}`, level, safeAvailable, safeCapacity, false);
}

function makeSummary(label = 'N/A', level = 'empty', available = null, capacity = null, closed = true) {
  return { label, level, available, capacity, closed };
}

function moveDay(delta) {
  const nextIndex = state.activeDayIndex + delta;
  if (nextIndex < 0 || nextIndex >= state.days.length) return;
  state.activeDayIndex = nextIndex;
  renderView();
}

function updateStatusFooter() {
  if (state.errors.length) {
    setStatus(state.errors.join(' | '));
  } else if (state.generatedAt) {
    setStatus(`Snapshot generated ${state.generatedAt.toLocaleString()}`);
  } else {
    setStatus('Snapshot loaded.');
  }
}

function setStatus(text) {
  statusMessageEl.textContent = text;
}

function formatHour(hour) {
  const period = hour >= 12 ? 'pm' : 'am';
  const normalized = hour % 12 || 12;
  return `${normalized}${period}`;
}

function formatLongDate(date) {
  return date.toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

function formatDayKey(date) {
  return `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, '0')}-${`${date.getDate()}`.padStart(2, '0')}`;
}

function addDays(date, amount) {
  const clone = new Date(date);
  clone.setDate(clone.getDate() + amount);
  return startOfDay(clone);
}

function startOfDay(date) {
  const clone = new Date(date);
  clone.setHours(0, 0, 0, 0);
  return clone;
}

function isValidDate(date) {
  return date instanceof Date && !Number.isNaN(date.getTime());
}

function getEarliestSlotDate(facilities) {
  const timestamps = facilities
    .flatMap((facility) => facility.intervals || [])
    .map((slot) => new Date(slot.start).getTime())
    .filter((ts) => Number.isFinite(ts));
  if (!timestamps.length) return null;
  return startOfDay(new Date(Math.min(...timestamps)));
}

function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}
