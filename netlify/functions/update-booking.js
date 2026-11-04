// Fixing a booking's DETAILS after it was taken — the address, the time, the
// car, how many people.
//
// WHY THIS EXISTS. update-fare could change what a ride costs and nothing
// could change what the ride WAS. A customer typed "88 Forest Way" with no
// town, the rate card could not price it, and the only way to correct the
// address was to open the sheet and retype the cell — which left the calendar
// entry, the thing the driver actually reads on the morning, still pointing at
// the old one. A wrong price is an awkward conversation. A wrong address is a
// car outside the wrong house while somebody misses a flight.
//
// So this writes BOTH, in one action, or tells you which half failed.
//
// IT DOES NOT TOUCH THE PRICE. Changing the pickup usually changes what the
// ride is worth, but the customer may already have been told a number, and a
// quote that moves by itself after it was given is worse than one that is out
// of date. Instead it works out what the rate card says for the corrected
// route and hands that back, so the dispatch can offer it and a person can
// decide. The price still changes in exactly one place: update-fare.
//
// Netlify environment variables: the usual Google ones, plus ADMIN_TOKEN.

const { google } = require('googleapis');
const { readTab, buildRow, rowToObject } = require('./_sheet');
const { findRideEvent } = require('./_calendar');
const { shiftLocalDateTime, formatRequestedDateTime, phoneCell } = require('./_format');
const { estimateFare } = require('./_fare-calc');

const BOOKINGS_TAB = 'Bookings';
const BUSINESS_TIMEZONE = 'America/New_York';

// What may be corrected here, and nothing else. Money is update-fare's job;
// ride_status is set-ride-status's. A field not in this list cannot be
// written by this function however it is spelled in the request.
const EDITABLE = ['pickup', 'dropoff', 'dateTime', 'vehicle', 'passengers', 'phone', 'flight', 'notes'];

const clean = (v) => String(v === null || v === undefined ? '' : v).trim();

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const expected = process.env.ADMIN_TOKEN || '';
  if (!expected) return { statusCode: 503, body: JSON.stringify({ error: 'ADMIN_TOKEN is not set in Netlify.' }) };

  const steps = {};

  try {
    const body = JSON.parse(event.body || '{}');
    const { token, rowNumber, was, now } = body;
    if (token !== expected) return { statusCode: 401, body: JSON.stringify({ error: 'Wrong passcode.' }) };
    if (!was || !now) return { statusCode: 400, body: JSON.stringify({ error: 'Nothing to change.' }) };

    const next = {};
    for (const field of EDITABLE) {
      const v = clean(now[field]);
      if (v !== '') next[field] = v;
    }
    if (!next.pickup || !next.dropoff) {
      return { statusCode: 400, body: JSON.stringify({ error: 'A ride needs both a pickup and a drop-off.' }) };
    }
    if (next.dateTime && !shiftLocalDateTime(next.dateTime, 0)) {
      return { statusCode: 400, body: JSON.stringify({ error: `That date and time can't be read: ${next.dateTime}` }) };
    }

    const auth = new google.auth.JWT(
      process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      null,
      (process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '').replace(/\\n/g, '\n'),
      ['https://www.googleapis.com/auth/spreadsheets']
    );
    await auth.authorize();
    const sheets = google.sheets({ version: 'v4', auth });
    const spreadsheetId = process.env.GOOGLE_SHEET_ID;

    // ---- the row, and the guard ----
    const { keys, rows, lastColumn } = await readTab(sheets, spreadsheetId, BOOKINGS_TAB);
    const idx = Number.isInteger(rowNumber) && rowNumber >= 2 ? rowNumber - 2 : -1;
    if (idx < 0 || idx >= rows.length) {
      return { statusCode: 409, body: JSON.stringify({ error: 'That ride is no longer at that row — refresh and try again.' }) };
    }
    const existing = rowToObject(keys, rows[idx]);
    // The OLD values are the guard. The page may have loaded before the sheet
    // was re-sorted, and overwriting somebody else's ride with this one's
    // address is the one mistake this function must never make.
    if (existing.pickup !== clean(was.pickup) || existing.dropoff !== clean(was.dropoff)) {
      return { statusCode: 409, body: JSON.stringify({ error: 'The sheet has changed since this page loaded — refresh and try again.' }) };
    }

    const cells = {};
    if (next.pickup !== existing.pickup) cells.pickup = next.pickup;
    if (next.dropoff !== existing.dropoff) cells.dropoff = next.dropoff;
    if (next.vehicle) { cells.vehicle = next.vehicle; cells.car_type = next.vehicle; cells.sedan = /sedan/i.test(next.vehicle) ? 'Yes' : 'No'; }
    if (next.passengers) cells.passengers = next.passengers;
    if (next.phone) cells.phone = phoneCell(next.phone);
    if (next.flight) cells.flight = next.flight;
    if (next.notes) cells.notes = next.notes;
    if (next.dateTime) {
      cells.requested_datetime = formatRequestedDateTime(next.dateTime);
      // The ride's month follows the ride, not the booking — and a leading
      // apostrophe keeps "2026-10" text instead of a date serial. Same rule as
      // log-booking; see the note there.
      if (/^(\d{4})-(\d{2})/.test(next.dateTime)) cells.ride_month = "'" + next.dateTime.slice(0, 7);
    }

    if (!Object.keys(cells).length) {
      return { statusCode: 200, body: JSON.stringify({ success: true, unchanged: true, steps: { sheet: 'nothing changed' } }) };
    }

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${BOOKINGS_TAB}!A${rowNumber}:${lastColumn}${rowNumber}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [buildRow(keys, cells, rows[idx])] },
    });
    steps.sheet = 'updated';

    // ---- the calendar, found by what it still says ----
    try {
      const { event: match, calendar, note: why } = await findRideEvent({
        pickup: clean(was.pickup), dropoff: clean(was.dropoff), dateTime: clean(was.dateTime),
      });
      if (!match) {
        steps.calendar = why || 'no matching calendar entry found';
      } else {
        const patch = {
          summary: `The Standard ride for ${existing.name || 'customer'}: ${next.pickup} → ${next.dropoff}`,
        };
        if (next.dateTime) {
          const start = shiftLocalDateTime(next.dateTime, 0);
          patch.start = { dateTime: start, timeZone: BUSINESS_TIMEZONE };
          patch.end = { dateTime: start, timeZone: BUSINESS_TIMEZONE };
        }
        // The description is a block of lines the driver reads. Rewrite only
        // the lines that changed and leave the rest of it alone — car seats,
        // cabin temperature and the notes were never this function's business.
        const lines = String(match.description || '').split('\n');
        const setLine = (label, value) => {
          if (!value) return;
          const at = lines.findIndex((l) => l.toLowerCase().startsWith(label.toLowerCase() + ':'));
          if (at === -1) lines.push(`${label}: ${value}`);
          else lines[at] = `${label}: ${value}`;
        };
        setLine('Customer phone', next.phone);
        setLine('Vehicle', next.vehicle);
        setLine('Passengers', next.passengers);
        setLine('Flight', next.flight);
        patch.description = lines.join('\n');

        try {
          await calendar.events.patch({
            calendarId: process.env.GOOGLE_CALENDAR_ID, eventId: match.id, requestBody: patch,
          });
          steps.calendar = 'updated';
        } catch (zeroLength) {
          // Google occasionally refuses a zero-length event; give it a minute.
          if (patch.start) patch.end = { dateTime: shiftLocalDateTime(next.dateTime, 1), timeZone: BUSINESS_TIMEZONE };
          await calendar.events.patch({
            calendarId: process.env.GOOGLE_CALENDAR_ID, eventId: match.id, requestBody: patch,
          });
          steps.calendar = 'updated';
        }
      }
    } catch (err) {
      steps.calendar = `failed: ${err.message}`;
    }

    // ---- what the rate card says NOW, as an offer and not an action ----
    //
    // NOT OFFERED ON A ROUND TRIP, and that is deliberate. estimateFare prices
    // ONE journey, so on a round-trip row it would offer the one-way figure -
    // $292.76 against a job actually booked at $534.03 - and the offer is a
    // button Ahmed can press. A tempting wrong number next to a right one is
    // worse than no number. Change the price by hand on these, or rebook.
    let repriced = null;
    const isRoundTrip = /^(yes|y|true|1)$/i.test(String(existing.round_trip || '').trim());
    try {
      if (isRoundTrip) throw new Error('round trip - priced as one job, not repriced here');
      const when = next.dateTime || clean(was.dateTime);
      const quote = estimateFare(next.pickup, next.dropoff, next.vehicle || existing.vehicle || existing.car_type,
                                 when, existing.payment_method, {});
      if (quote.matched && typeof quote.total === 'number') {
        repriced = {
          fare: quote.fare, toll: quote.toll || 0, cardFee: quote.cardFee || 0,
          total: quote.total, label: quote.label || null, tip: quote.tipSuggested || 0,
        };
      }
    } catch (err) { /* an offer that cannot be made is not an error */ }

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, changed: Object.keys(cells), repriced, steps }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message, steps }) };
  }
};
