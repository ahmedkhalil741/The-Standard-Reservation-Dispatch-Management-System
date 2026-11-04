// Shared helpers for reading and writing the Google Sheet by COLUMN HEADER
// NAME rather than by fixed position.
//
// Why this exists: the Bookings and Customers tabs get rearranged by hand —
// columns added, deleted, renamed, reordered. Any code that writes to "column
// D" silently corrupts the sheet the moment a column moves. Every function
// here looks up where a value belongs by its header name instead, so the
// layout can change freely without touching the code.
//
// Matching ignores case, spaces, hyphens and underscores: "Base Fare",
// "base_fare" and "base fare" are the same column.

// Headers that are spelled differently in the sheet from the key used in
// code. Add to this rather than renaming columns in the sheet.
const HEADER_ALIASES = {
  elderly_assitance: 'elderly_assistance',
  elderly_assistence: 'elderly_assistance',
  elderly: 'elderly_assistance',
  requested_date_time: 'requested_datetime',
  car_seat: 'car_seats',
  carseats: 'car_seats',
  cabin_temperature: 'cabin_temp',
  waiting_fee: 'waiting_late_fee',
  late_fee: 'waiting_late_fee',
  waiting_late: 'waiting_late_fee',
  hourly: 'hourly_trip',
  // The destination bucket: Newark, Manhattan, LaGuardia, JFK, Local, Other.
  destination: 'zone',
  city: 'zone',
  total: 'fare_total',
  payment: 'payment_method',
  rides: 'total_rides',
  monthly_rides: 'rides_this_month',
  rides_this_mounth: 'rides_this_month',
  car: 'car_type',
  vehicle: 'car_type',
  likes: 'likes',
  dislikes: 'dislikes',
  dislike: 'dislikes',
  like: 'likes',
};

function normalizeHeader(header) {
  const key = String(header || '')
    .trim()
    .toLowerCase()
    .replace(/[\s\-]+/g, '_')
    .replace(/_+/g, '_');
  return HEADER_ALIASES[key] || key;
}

// 1 -> "A", 26 -> "Z", 27 -> "AA"
function columnLetter(n) {
  let letters = '';
  while (n > 0) {
    const remainder = (n - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

// Empty / missing -> "N/A". 0 is a real value and is kept as 0.
function orNA(value) {
  if (value === null || value === undefined) return 'N/A';
  if (typeof value === 'string' && value.trim() === '') return 'N/A';
  return value;
}

// THE SAME IDEA FOR A COLUMN OF MONEY, AND WHY IT HAD TO BE DIFFERENT.
//
// "N/A" and 0 do not mean the same thing. N/A means nobody knows; 0 means we
// know, and it is nothing. A Zelle ride's card fee is the second: the price
// was worked out at booking and the fee came to zero. Writing N/A there hides
// an answer we already have.
//
// It also breaks the column. One piece of text in a column of numbers and
// Google Sheets stops treating it as numeric: AVERAGE silently skips those
// rows and reports a figure that is too high, COUNT disagrees with the number
// of rides, and a pivot or a chart over it either refuses or misleads. SUM
// happens to come out right, which is what makes this the kind of mistake you
// find in December.
//
// So: a number we know goes in as a number, zero included. N/A is kept for
// what genuinely is not known yet — the waiting fee before the ride, the
// driver before one is assigned — and for columns of words, where nothing
// will ever be calculated and "N/A" reads better than an empty cell.
function orZero(value) {
  if (value === null || value === undefined || value === '') return 0;
  const n = Number(value);
  return isFinite(n) ? n : 0;
}

// Reads a whole tab and returns its header row (normalized), plus the data
// rows. `keys` lines up index-for-index with each row's cells.
async function readTab(sheets, spreadsheetId, tab) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tab}!A:ZZ`,
  });
  const values = res.data.values || [];
  const headers = values[0] || [];
  return {
    headers,
    keys: headers.map(normalizeHeader),
    rows: values.slice(1),
    lastColumn: columnLetter(Math.max(headers.length, 1)),
  };
}

// Builds a row laid out to match `keys`. Starts from `existingRow` so any
// column the caller doesn't manage — hand-typed notes, likes, dislikes, a
// status column someone keeps by hand — survives the write untouched. Only
// keys present in `cells` are overwritten.
// ---- COLUMNS THAT MUST STAY TEXT, ON EVERY WRITE ----
//
// Ahmed, 4 November: "the ride month always goes in the left and has ' in the
// beginning so i always delete it... same thing for the phone number."
//
// The apostrophe is deliberate and it is doing real work. "2026-10" looks like
// a date to Google Sheets and gets stored as the serial number 46296;
// "9084949256" is a number and renders as 9.08E+09. A leading apostrophe
// forces the cell to stay text. Sheets eats the apostrophe itself, so it shows
// in the formula bar and not in the cell.
//
// THE BUG THIS FIXES, which is why he saw it coming back. log-booking writes
// the apostrophe, but it is not the only thing that writes these rows. Marking
// a ride Completed, changing its price or fixing its details all rewrite the
// WHOLE row through buildRow, carrying every column they do not manage
// straight through. Those values were read back with values.get, which returns
// the DISPLAYED text - "2026-10", with no apostrophe, because Sheets had
// already consumed it - and writing that back with USER_ENTERED parses it
// afresh. So the guard was applied once at booking and then thrown away by the
// first status change, which is exactly the "happens frequently" he described.
//
// So the guard is re-applied here, on the way out, for every write in the
// codebase rather than in the one function that remembered.
//
// Money columns are deliberately absent: a column that mixes text and numbers
// stops being numeric and every average and chart over it goes quietly wrong.
// See orZero.
const TEXT_COLUMNS = new Set([
  // "2026-10" -> the date serial 46296
  'ride_month',
  // ten digits -> 9.08E+09
  'phone',
  // "03-14" -> 14 March of the current year
  'birthday',
  // the random half can come out all digits, and "1104-849793" is one date
  // parse away from being something else entirely
  'booking_id',
  // these carry a readable date; they are text today because of the separator
  // in them, which is a thing a later edit to the format could take away
  'timestamp', 'requested_datetime', 'return_datetime',
]);

// Already protected, or nothing to protect: leave it exactly as it is. Writing
// a second apostrophe would put a real one in the cell.
function asText(value) {
  if (typeof value !== 'string') return value;
  if (!value || value.charAt(0) === "'") return value;
  return "'" + value;
}

// Builds a row laid out to match `keys`.
function buildRow(keys, cells, existingRow = []) {
  return keys.map((key, i) => {
    const value = Object.prototype.hasOwnProperty.call(cells, key)
      ? cells[key]
      : (existingRow[i] !== undefined ? existingRow[i] : '');
    return TEXT_COLUMNS.has(key) ? asText(value) : value;
  });
}

// Pulls one row out into a plain object keyed by header name.
function rowToObject(keys, row = []) {
  const out = {};
  keys.forEach((key, i) => {
    out[key] = row[i] !== undefined ? row[i] : '';
  });
  return out;
}

// ---- FINDING A RIDE WITHOUT TRUSTING ITS POSITION ----
//
// Every write to the Bookings tab used to be aimed by row number: the dispatch
// sent `rowNumber: 7` and the function wrote into row 7. That is right until
// anything above row 7 moves - a deleted row, an inserted one, the tab sorted
// by date - at which point an open dispatch is still holding the old numbers
// and the write lands on SOMEBODY ELSE'S RIDE. No error, no warning. See the
// long note in _booking-id.js for how this was found.
//
// So: ask for the ride by its booking id and go looking for it.
//
// WHEN AN ID IS GIVEN AND NOT FOUND, THIS REFUSES. It does not quietly fall
// back to the row number, because "the id isn't there" almost always means the
// row was deleted or the sheet was rebuilt - and writing to whatever occupies
// that position now is the precise accident the id exists to prevent. The
// caller gets null and tells the person to reload, which costs a tap.
//
// The row number is still accepted, and still used, for every ride booked
// before ids existed. Those rows have an empty booking_id, the dispatch sends
// no id for them, and they are addressed the old way - carefully, and with
// the same reload warning. They age out as they are completed.
function findBookingRow(keys, rows, bookingId, rowNumber) {
  const wanted = String(bookingId == null ? '' : bookingId).replace(/\s+/g, '').toUpperCase();

  if (wanted) {
    const at = rows.findIndex((row) => {
      const got = rowToObject(keys, row).booking_id;
      return String(got == null ? '' : got).replace(/\s+/g, '').toUpperCase() === wanted;
    });
    if (at === -1) return null;
    return { idx: at, rowNumber: at + 2, foundBy: 'id' };
  }

  // 2, not 1: row 1 is the header, and the rows array starts after it.
  const n = Number(rowNumber);
  const idx = Number.isInteger(n) && n >= 2 ? n - 2 : -1;
  if (idx < 0 || idx >= rows.length) return null;
  return { idx, rowNumber: n, foundBy: 'position' };
}

// What to say when findBookingRow comes back empty, so the four functions that
// call it all say the same thing. An id that has gone is a different story from
// a row number off the end, and the person can act on the difference.
function noSuchRow(bookingId) {
  return String(bookingId || '').trim()
    ? `No ride with the id ${String(bookingId).trim()} - it may have been deleted. Reload the dispatch and try again.`
    : 'That ride is not where the page expected it. Reload the dispatch and try again.';
}

module.exports = {
  normalizeHeader,
  TEXT_COLUMNS,
  asText,
  findBookingRow,
  noSuchRow,
  columnLetter,
  orNA,
  orZero,
  readTab,
  buildRow,
  rowToObject,
  HEADER_ALIASES,
};
