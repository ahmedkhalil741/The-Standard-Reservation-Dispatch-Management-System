// A NAME FOR EVERY BOOKING THAT NEVER CHANGES.
//
// Ahmed's question, 4 November, after finding three sheet rows where he had
// entered four rides: "what if i be able to delete rides from the dispatch does
// that can fix the proplem". A delete button helps, but the hazard it would be
// papering over is this one:
//
// EVERY WRITE IN THIS SYSTEM USED TO ADDRESS A RIDE BY ITS POSITION. The
// dispatch sent `rowNumber: 7` and set-ride-status wrote "Completed" into row
// 7. That is correct for exactly as long as nothing above row 7 moves. Delete a
// row in the sheet, insert one, or sort the tab by date - all ordinary things
// to do to a spreadsheet - and every row below shifts up or down while the open
// dispatch still believes the old numbers. Tap Completed and it lands on a
// DIFFERENT CUSTOMER'S RIDE, silently, with no error anywhere. Same for
// changing a price, fixing the details, or assigning a driver.
//
// So each booking gets an id of its own, written once when the ride is saved
// and never touched again, and the dispatch asks for a ride BY THAT ID.
// Positions can then move as much as they like.
//
// ---- WHY NOT THE PHONE NUMBER ----
// Ahmed asked. A phone number names the CUSTOMER, not the ride: Bryan's
// November airport run and his December one carry the same number, and a search
// for it finds two rows with no way to choose between them.
//
// Phone plus the date and time is nearly unique, and still wrong - "fix the
// details" can move a pickup from 5pm to 6pm, which would change the id
// underneath a ride that is already saved, and a blank or mistyped phone leaves
// a row with no id at all. An id has to survive every edit, so it cannot be
// made of anything editable.
//
// ---- WHY NOT 1, 2, 3, 4 ----
// He asked that too, and counting is genuinely nicer to read out loud. It needs
// a read-then-write though: find the highest number so far, add one, save it.
// The website and the dispatch can both save in the same moment - someone books
// online while Ahmed is typing in a phone call - and two calls that each read
// "46" both decide they are 47. That is the same race that gave the $10 first
// ride away twice on round trips, fixed on 30 October by removing a
// read-then-write exactly like this one. Nothing here reads the sheet first, so
// there is nothing to race.
//
// ---- THE SHAPE: 1104-7K2MQX ----
// The month and day it was booked, then six characters of randomness. Short
// enough to read down the phone, tells you the day at a glance, and groups by
// date when the column is sorted.
//
// SIX, NOT FOUR, AND THE TEST IS WHY. This was written with four and a comment
// claiming 1.6 million combinations a day. Four characters from a 26-character
// alphabet is 456,976, not 1.6 million, and generating 200,000 ids for a single
// day produced 37,941 duplicates. At fifty bookings a day that is a 0.27%
// chance of a collision each day - which sounds small until you notice it
// compounds to roughly a 60% chance of SOME day in the year having two rides
// that share an id, and a shared id is the one thing this file exists to
// prevent. Six characters is 308 million a day, which puts it at about one
// chance in 250,000 over the same year. Numbers in comments get checked here.
//
// The date prefix means only ids from the SAME day can ever collide, which is
// what makes six enough rather than needing a long random string.
//
// THE ALPHABET LEAVES OUT 0, O, 1, I, L, S, 5, 2 and Z. This is read aloud to
// customers and typed into a search box by a tired person at 5am, and those are
// the characters people mishear and mistype for each other. 24 letters and
// digits that cannot be confused beats 36 that can.
const ALPHABET = 'ABCDEFGHJKMNPQRTUVWXY34六789'.replace(/[^A-Z0-9]/g, '');

// Eastern, like every other date this business writes down - a booking taken at
// 8pm on the 4th must not be stamped the 5th because the server is in UTC.
function easternMonthDay(now) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', month: '2-digit', day: '2-digit',
  }).formatToParts(now || new Date());
  const get = (t) => (parts.find((p) => p.type === t) || {}).value || '';
  return get('month') + get('day');
}

// THE FIRST CHARACTER IS ALWAYS A LETTER, so an id can never come out as
// nothing but digits and a hyphen. "1104-849793" is a string a spreadsheet can
// have opinions about - a date parse, or arithmetic - and an id that a sheet
// might rewrite is not an id. One letter in a known position removes the whole
// question, and costs 20 of the 26 characters at one position only.
const LETTERS = ALPHABET.replace(/[0-9]/g, '');

function randomPart(length) {
  let out = LETTERS[Math.floor(Math.random() * LETTERS.length)];
  for (let i = 1; i < length; i += 1) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return out;
}

function newBookingId(now) {
  return `${easternMonthDay(now)}-${randomPart(6)}`;
}

// Compared case-insensitively and with spaces stripped, because this value gets
// read out, typed back in, and pasted around. "1104-7k2m" is the same booking.
function sameBookingId(a, b) {
  const tidy = (v) => String(v == null ? '' : v).replace(/\s+/g, '').toUpperCase();
  const left = tidy(a);
  return Boolean(left) && left === tidy(b);
}

module.exports = { newBookingId, sameBookingId, ALPHABET };
