// GIVES EVERY RIDE ALREADY IN THE SHEET AN ID. Run once, from the dispatch.
//
// Ahmed's request, 4 November: "lets do it to all old rides before we adjust
// the 2 round trips." Every booking saved from now on gets an id as it is
// written (see log-booking.js), but the rides already in the sheet have none -
// and a ride with no id is still addressed by its position, which is the whole
// problem. So this fills them in.
//
// WHAT IT WILL NOT DO:
//   * Touch a row that already has an id. An id that changes is worse than no
//     id at all, because an open dispatch would be holding the old one.
//   * Touch any other column. It writes ONE column and nothing else - not
//     through buildRow, not a whole-row update - so there is no path by which
//     this can disturb a fare, a status or a hand-typed note.
//   * Invent a column. If the Bookings tab has no booking_id header it stops
//     and says so rather than guessing which column to fill.
//
// THE DATE IN EACH ID IS THE DAY THE RIDE WAS BOOKED, read out of the existing
// timestamp column, so an old ride gets 1021-xxxxxx rather than today's date
// and the column still sorts into something meaningful.
//
// It is safe to run twice. The second run reports that there was nothing to do.

const { google } = require('googleapis');
const { readTab, columnLetter } = require('./_sheet');
const { newBookingId } = require('./_booking-id');

const BOOKINGS_TAB = 'Bookings';
const ID_KEY = 'booking_id';

async function sheetsClient() {
  const auth = new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    null,
    (process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '').replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  await auth.authorize();
  return google.sheets({ version: 'v4', auth });
}

// "Nov 4, 2026, 5:10 PM ET" is what formatTimestamp writes. Date can parse that
// once the trailing zone label is off; anything it cannot read falls back to
// today, which is a cosmetic loss and never a wrong id.
function bookedOn(timestampCell) {
  const text = String(timestampCell == null ? '' : timestampCell).replace(/\s*ET\s*$/i, '').trim();
  if (!text) return null;
  const d = new Date(text);
  return isNaN(d.getTime()) ? null : d;
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const expected = process.env.ADMIN_TOKEN || '';
  if (!expected) return { statusCode: 503, body: JSON.stringify({ error: 'ADMIN_TOKEN is not set in Netlify.' }) };

  try {
    const { token } = JSON.parse(event.body || '{}');
    if (token !== expected) return { statusCode: 401, body: JSON.stringify({ error: 'Wrong passcode.' }) };

    const sheets = await sheetsClient();
    const spreadsheetId = process.env.GOOGLE_SHEET_ID;
    const { keys, rows } = await readTab(sheets, spreadsheetId, BOOKINGS_TAB);

    const col = keys.indexOf(ID_KEY);
    if (col === -1) {
      return { statusCode: 400, body: JSON.stringify({
        error: `The Bookings tab has no "booking_id" column. Add it to row 1 first, then run this again.`,
      }) };
    }
    const tsCol = keys.indexOf('timestamp');

    // One value per existing row, in order. A row that already has an id keeps
    // exactly what it has - the same string is written back, which is a no-op.
    let filled = 0;
    const samples = [];
    const column = rows.map((row) => {
      const current = String(row[col] == null ? '' : row[col]).trim();
      if (current) return [current];
      // A completely empty row - a gap someone left in the middle of the sheet
      // - gets nothing. An id on a blank row would make it look like a ride.
      const hasAnything = row.some((cell) => String(cell == null ? '' : cell).trim());
      if (!hasAnything) return [''];
      const id = newBookingId(tsCol === -1 ? null : bookedOn(row[tsCol]));
      filled += 1;
      if (samples.length < 5) samples.push(id);
      return [id];
    });

    if (!filled) {
      return { statusCode: 200, body: JSON.stringify({
        success: true, filled: 0,
        note: `Every ride in the sheet already has an id — nothing to do.`,
      }) };
    }

    const letter = columnLetter(col + 1);
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      // ONE COLUMN, from row 2 to the last row that exists. Nothing else in
      // the sheet is in range, so nothing else can be affected.
      range: `${BOOKINGS_TAB}!${letter}2:${letter}${rows.length + 1}`,
      valueInputOption: 'RAW',
      requestBody: { values: column },
    });

    return { statusCode: 200, body: JSON.stringify({
      success: true,
      filled,
      total: rows.length,
      column: letter,
      samples,
      note: `Gave ${filled} ride${filled === 1 ? '' : 's'} an id. Reload the dispatch.`,
    }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
