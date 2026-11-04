// DELETES A RIDE'S ROW FROM THE BOOKINGS TAB.
//
// Ahmed's question, 4 November: "what if i be able to delete rides from the
// dispatch does that can fix the proplem". It does, now that rides have ids -
// before them, a delete aimed by row number was the single most dangerous
// thing this system could have offered, because the row it hit depended on
// nothing having moved since the page loaded.
//
// This is for a row that should never have existed: a double entry, a test, a
// booking typed in twice. IT IS NOT HOW YOU CANCEL A RIDE. A cancelled ride
// stays in the sheet with its reason, because the fact that somebody booked
// and cancelled is a thing the business wants to know at year end, and the
// cancellation fee lives on that row. Use the Cancelled status for that.
//
// ---- THREE GUARDS, AND WHY EACH IS THERE ----
//
// 1. A COMPLETED RIDE IS REFUSED. Completing a ride puts a loyalty point, and
//    sometimes a $15 credit, onto the customer in the Customers tab. Deleting
//    the booking row does not take any of that back - the point would sit
//    there for a ride that no longer exists, and re-entering the ride would
//    award a second one. So this refuses and says to set the ride back to
//    Confirmed first, which is the path that already returns the point and the
//    credit properly (see set-ride-status.js). Two taps, and nothing silent.
//
// 2. A ROW WITH NO ID HAS TO MATCH ON THE ADDRESSES TOO. Rides booked before
//    ids existed can only be found by position, and a position can be stale.
//    So for those the pickup and drop-off the page is showing must still match
//    what is in the row, or nothing is deleted. Rides with an id skip this -
//    an id cannot point at the wrong row.
//
// 3. THE SHEET'S NUMERIC ID IS LOOKED UP, NOT ASSUMED. deleteDimension works
//    on a sheetId, which is not the tab name and not its position among the
//    tabs. Guessing 0 works right up until somebody reorders the tabs, and
//    then it deletes a row out of the wrong tab.
//
// What it answers with: the name, route and time of what it removed, so the
// dispatch can say what went rather than just "done".

const { google } = require('googleapis');
const { readTab, rowToObject, findBookingRow, noSuchRow } = require('./_sheet');

const BOOKINGS_TAB = 'Bookings';
const COMPLETED = 'Completed';

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

async function numericSheetId(sheets, spreadsheetId, title) {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets(properties(sheetId,title))',
  });
  const tab = (meta.data.sheets || [])
    .map((s) => s.properties || {})
    .find((p) => String(p.title || '').trim().toLowerCase() === title.toLowerCase());
  if (!tab || typeof tab.sheetId !== 'number') {
    throw new Error(`No tab named "${title}" in that spreadsheet.`);
  }
  return tab.sheetId;
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const expected = process.env.ADMIN_TOKEN || '';
  if (!expected) return { statusCode: 503, body: JSON.stringify({ error: 'ADMIN_TOKEN is not set in Netlify.' }) };

  try {
    const { token, bookingId, rowNumber, pickup, dropoff } = JSON.parse(event.body || '{}');
    if (token !== expected) return { statusCode: 401, body: JSON.stringify({ error: 'Wrong passcode.' }) };

    const sheets = await sheetsClient();
    const spreadsheetId = process.env.GOOGLE_SHEET_ID;
    const { keys, rows } = await readTab(sheets, spreadsheetId, BOOKINGS_TAB);

    const found = findBookingRow(keys, rows, bookingId, rowNumber);
    if (!found) {
      return { statusCode: 409, body: JSON.stringify({ error: noSuchRow(bookingId) }) };
    }

    const row = rowToObject(keys, rows[found.idx]);

    // Guard 2 - see the note at the top.
    if (found.foundBy === 'position') {
      const same = (a, b) => String(a || '').trim() === String(b || '').trim();
      if (!same(row.pickup, pickup) || !same(row.dropoff, dropoff)) {
        return { statusCode: 409, body: JSON.stringify({
          error: 'This ride has no id yet and the sheet has moved since this page loaded, '
               + 'so the row it points at is a different ride. Reload the dispatch and try again.',
        }) };
      }
    }

    // Guard 1 - see the note at the top.
    if (String(row.ride_status || '').trim().toLowerCase() === COMPLETED.toLowerCase()) {
      return { statusCode: 409, body: JSON.stringify({
        error: 'This ride is marked Completed, so the customer has a loyalty point for it. '
             + 'Tap the status back to Confirmed first — that returns the point and any credit '
             + '— then delete it.',
      }) };
    }

    const sheetId = await numericSheetId(sheets, spreadsheetId, BOOKINGS_TAB);

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          deleteDimension: {
            // Zero-based and end-exclusive, and the header is index 0 - so the
            // row the sheet calls N is index N-1 and this deletes exactly it.
            range: { sheetId, dimension: 'ROWS', startIndex: found.rowNumber - 1, endIndex: found.rowNumber },
          },
        }],
      },
    });

    return { statusCode: 200, body: JSON.stringify({
      success: true,
      deleted: {
        bookingId: String(row.booking_id || '').trim(),
        name: row.name || '',
        pickup: row.pickup || '',
        dropoff: row.dropoff || '',
        when: row.requested_datetime || '',
        status: row.ride_status || '',
      },
      // Everything below it has just shifted up, so any other page looking at
      // this sheet by position is now wrong. The dispatch refreshes itself.
      note: 'Row removed. Reload any other dispatch you have open.',
    }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
