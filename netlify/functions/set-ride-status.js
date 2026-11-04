// Marks a ride Completed, Cancelled or No-show — and, on Completed, awards
// the loyalty point.
//
// This is the piece the loyalty programme was missing. Before it, every count
// happened at booking time, so a cancellation earned exactly as much as a
// finished airport run. Points are awarded HERE and nowhere else.
//
// Completing the same ride twice must not award two points, so the Bookings
// row's current status is read first and a ride already marked Completed is
// left alone. The same guard means a ride marked Cancelled AFTER it was
// completed takes its point back.
//
// Netlify environment variables: the usual Google ones, plus ADMIN_TOKEN.

const { google } = require('googleapis');
const { readTab, buildRow, rowToObject, orNA, findBookingRow, noSuchRow } = require('./_sheet');
const { easternToday, phoneCell } = require('./_format');
const { sendOwnerEmail } = require('./_email');
const L = require('./_loyalty');

const BOOKINGS_TAB = 'Bookings';
const CUSTOMERS_TAB = 'Customers';

const COMPLETED = 'Completed';
const CANCELLED = 'Cancelled';
const NO_SHOW = 'No-show';
const REQUESTED = 'Requested';
// Confirmed sits between Requested and Completed: Ahmed has looked at the
// booking, agreed the price and told the customer. It deliberately earns
// nothing and settles nothing - only Completed touches points and credit -
// so it is safe to set, unset and set again while a ride is being arranged.
const CONFIRMED = 'Confirmed';
const ALLOWED = [COMPLETED, CANCELLED, NO_SHOW, REQUESTED, CONFIRMED];

function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-10);
}

// Whatever name we have for this customer, in order of preference.
function who0(customer, fallbackName, phoneKey) {
  return (customer && customer.name) || fallbackName || phoneKey;
}

// Authorised once per warm container, not once per tap.
//
// Netlify reuses the container between invocations, so building a JWT and
// exchanging it with Google was a round trip bought and thrown away on every
// single request. google-auth-library refreshes the token itself when it
// expires, so holding the client is safe.
let cachedSheets = null;
async function sheetsClient() {
  if (cachedSheets) return cachedSheets;
  const auth = new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    null,
    (process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '').replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  await auth.authorize();
  cachedSheets = google.sheets({ version: 'v4', auth });
  return cachedSheets;
}

// WHY THE CREDITS TAB IS GONE — Ahmed's call, 2026-10-25.
//
// It was a separate tab with one row per credit event, and for three weeks it
// sat completely empty, because the first event a customer ever generates is
// the $15 at ten rides. He asked about it three times. A tab that will look
// broken until somebody's tenth ride is a tab that costs more in doubt than
// it returns in tidiness, and he does not want to open a second sheet to find
// out why a balance is what it is.
//
// So the reason now lives on the CUSTOMER, in credit_history, next to the
// balance it explains - and the morning email already prints that cell beside
// the amount owed, which is where he actually reads it.
//
// The objection to this before was that the cell grew without limit. It did,
// because the old version wrote a line for every single ride. Credits are
// rare - ten rides apart, a birthday, a referral - so at this size the cell
// holds a couple of entries a year, and KEEP_ENTRIES caps it regardless.
const KEEP_ENTRIES = 8;

function addNote(existing, date, amount, reason) {
  const sign = amount < 0 ? '-' : '+';
  const line = `${date} ${sign}$${Math.abs(amount)} (${reason})`;
  const kept = String(existing || '').split(' \u00b7 ').map((x) => x.trim()).filter(Boolean);
  kept.push(line);
  return kept.slice(-KEEP_ENTRIES).join(' \u00b7 ');
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const expected = process.env.ADMIN_TOKEN || '';
  if (!expected) return { statusCode: 503, body: JSON.stringify({ error: 'ADMIN_TOKEN is not set in Netlify.' }) };

  try {
    const { token, bookingId, rowNumber, status, pickup, dropoff, phone, name, reason, cardEntry } = JSON.parse(event.body);
    if (token !== expected) return { statusCode: 401, body: JSON.stringify({ error: 'Wrong passcode.' }) };

    const wanted = ALLOWED.find((s) => s.toLowerCase() === String(status || '').trim().toLowerCase());
    if (!wanted) return { statusCode: 400, body: JSON.stringify({ error: `Status must be one of: ${ALLOWED.join(', ')}` }) };

    const sheets = await sheetsClient();
    const spreadsheetId = process.env.GOOGLE_SHEET_ID;

    // ---- the booking row ----
    const bookings = await readTab(sheets, spreadsheetId, BOOKINGS_TAB);
    if (!bookings.keys.includes('ride_status')) {
      return { statusCode: 200, body: JSON.stringify({ success: false, error: 'The Bookings tab has no "ride_status" column. Add one to the header row.' }) };
    }

    // The ride is found by its ID, not by the row number the page remembered -
    // see findBookingRow in _sheet.js. A stale position can no longer send a
    // write to a different customer's ride.
    const found = findBookingRow(bookings.keys, bookings.rows, bookingId, rowNumber);
    if (!found) {
      return { statusCode: 409, body: JSON.stringify({ error: noSuchRow(bookingId) }) };
    }
    const { idx, rowNumber: atRow } = found;
    const row = rowToObject(bookings.keys, bookings.rows[idx]);
    if (row.pickup !== pickup || row.dropoff !== dropoff) {
      return { statusCode: 409, body: JSON.stringify({ error: 'The sheet has changed since this page loaded — refresh and try again.' }) };
    }

    const before = String(row.ride_status || '').trim();

    // WHY A REASON IS A SEPARATE WRITE.
    //
    // The dispatch page saves Cancelled the instant the button is tapped, and
    // only then asks why. That order is deliberate: a cancellation half-made
    // because somebody was interrupted is worse than one with no reason on it,
    // and the fee a cancellation carries depends on when it happened, not on
    // whether anyone wrote a note. So the reason arrives in a SECOND call with
    // the same status, which used to fall straight into the unchanged branch
    // below and be thrown away.
    //
    // A reason only means anything on a ride that did not happen. Moving a
    // ride back to Confirmed or Completed clears it rather than leaving last
    // week's "flight cancelled" sitting on a run that went ahead.
    // HOW THE CARD WAS TAKEN. Recorded, never repriced.
    //
    // Ahmed charges everybody the tapped rate whichever way the card is run,
    // so this changes no money. It exists so that at year end the saved-card
    // rides can be counted and the real cost of them worked out, instead of
    // the gap between what Square billed and what the sheet says being a
    // mystery nobody can explain.
    const ENTRIES = ['Tapped', 'On file'];
    const hasEntryCol = bookings.keys.includes('card_entry');
    const entry = ENTRIES.find((e) => e.toLowerCase() === String(cardEntry || '').trim().toLowerCase()) || '';

    const hasReasonCol = bookings.keys.includes('cancel_reason');
    const settled = /^(cancelled|no-?show)$/i.test(wanted);
    const reasonText = settled ? String(reason == null ? '' : reason).trim().slice(0, 200) : '';
    const reasonChanged = hasReasonCol &&
      reasonText !== String(row.cancel_reason || '').trim() &&
      (settled ? reasonText !== '' : String(row.cancel_reason || '').trim() !== '');

    const entryChanged = hasEntryCol && entry && entry !== String(row.card_entry || '').trim();
    const sideCells = {};
    if (reasonChanged) sideCells.cancel_reason = reasonText;
    if (entryChanged) sideCells.card_entry = entry;

    if (reasonChanged || entryChanged) {
      const cells = Object.assign({ ride_status: wanted }, sideCells);
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${BOOKINGS_TAB}!A${atRow}:${bookings.lastColumn}${atRow}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [buildRow(bookings.keys, cells, bookings.rows[idx])] },
      });
      bookings.rows[idx] = buildRow(bookings.keys, cells, bookings.rows[idx]);
    }

    // ONE TAP SETS IT, AND IT STAYS SET.
    //
    // Marking a ride "On file" says the card is saved in Square, and that
    // changes what every future booking for this number costs to accept:
    // 3.5% instead of 2.6%. The price has to know before it is quoted, not
    // after - every message we send promises nothing is added at the end - so
    // the answer is written onto the CUSTOMER here, and _first-ride.js reads
    // it at booking time.
    //
    // THIS HAS TO LIVE HERE, not further down with the points. The dispatch
    // asks "Tapped or on file?" after the ride is already Completed, so that
    // second call changes no status, takes the early return above, and never
    // reaches the customer block at the bottom of this function.
    //
    // Only ever written true. A customer taking their card out of Square is a
    // conversation, not something this code can observe, so clearing it is a
    // hand edit in the sheet - the safer direction to leave manual.
    let savedCard = null;
    if (entry === 'On file') {
      try {
        const key0 = normalizePhone(phone || row.phone);
        const cust = await readTab(sheets, spreadsheetId, CUSTOMERS_TAB);
        const pc = cust.keys.indexOf('phone');
        if (!cust.keys.includes('card_on_file')) {
          savedCard = 'the Customers tab has no "card_on_file" column — add one to the header row';
        } else if (key0 && pc !== -1) {
          const at = cust.rows.findIndex((r) => normalizePhone(r[pc]) === key0);
          if (at !== -1 && !/^(yes|y|true|1)$/i.test(String(rowToObject(cust.keys, cust.rows[at]).card_on_file || '').trim())) {
            await sheets.spreadsheets.values.update({
              spreadsheetId,
              range: `${CUSTOMERS_TAB}!A${at + 2}:${cust.lastColumn}${at + 2}`,
              valueInputOption: 'USER_ENTERED',
              requestBody: { values: [buildRow(cust.keys, { card_on_file: 'Yes' }, cust.rows[at])] },
            });
            savedCard = 'card on file — future bookings use the keyed rate';
          }
        }
      } catch (err) { savedCard = `not recorded: ${err.message}`; }
    }

    if (before.toLowerCase() === wanted.toLowerCase()) {
      return { statusCode: 200, body: JSON.stringify({
        success: true, unchanged: !(reasonChanged || entryChanged), status: wanted,
        reason: reasonText, cardEntry: entry, savedCard,
        entryNote: (entry && !hasEntryCol)
          ? 'The Bookings tab has no "card_entry" column, so that was not saved. Add one to the header row.'
          : undefined,
        note: (settled && reasonText && !hasReasonCol)
          ? 'The Bookings tab has no "cancel_reason" column, so the reason was not saved. Add one to the header row.'
          : undefined,
      }) };
    }

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${BOOKINGS_TAB}!A${atRow}:${bookings.lastColumn}${atRow}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [buildRow(bookings.keys,
        Object.assign({ ride_status: wanted },
          hasReasonCol ? { cancel_reason: reasonText } : {},
          hasEntryCol && entry ? { card_entry: entry } : {}),
        bookings.rows[idx])] },
    });

    // ---- the point, or two of them ----
    // One on the way into Completed, one back on the way out of it. Nothing
    // else moves the total, so marking a ride Completed twice can't
    // double-count and correcting a mistake genuinely corrects it.
    //
    // A ROUND TRIP IS WORTH TWO. Ahmed's call, 4 November, when the two sheet
    // rows became one: the customer was driven there and driven back, so the
    // reward ladder should count both. One row, one Completed button, two
    // points - and the reversal takes both back, which is the half that is
    // easy to forget.
    //
    // creditEarnedAcross, not creditEarned, for the reason spelled out in
    // _loyalty.js: a two-point jump can step straight over the ten that earns
    // the $15, and the old test only ever saw the number it landed on.
    const wasCompleted = before.toLowerCase() === COMPLETED.toLowerCase();
    const nowCompleted = wanted === COMPLETED;
    const legs = /^(yes|y|true|1)$/i.test(String(row.round_trip || '').trim()) ? 2 : 1;
    const delta = legs * ((nowCompleted ? 1 : 0) - (wasCompleted ? 1 : 0));

    if (delta === 0) {
      return { statusCode: 200, body: JSON.stringify({ success: true, status: wanted, pointsChanged: false,
        reason: reasonText,
        note: (settled && reasonText && !hasReasonCol)
          ? 'The Bookings tab has no "cancel_reason" column, so the reason was not saved. Add one to the header row.'
          : undefined }) };
    }


    const key = normalizePhone(phone || row.phone);
    if (!key) {
      return { statusCode: 200, body: JSON.stringify({ success: true, status: wanted, pointsChanged: false, note: 'No phone number on this ride, so no customer to credit.' }) };
    }

    const customers = await readTab(sheets, spreadsheetId, CUSTOMERS_TAB);
    const phoneCol = customers.keys.indexOf('phone');
    if (phoneCol === -1) {
      return { statusCode: 200, body: JSON.stringify({ success: true, status: wanted, pointsChanged: false, note: 'The Customers tab has no phone column.' }) };
    }
    const cIdx = customers.rows.findIndex((r) => normalizePhone(r[phoneCol]) === key);
    if (cIdx === -1) {
      // SAY WHICH WAY IT FAILED. "No customer profile" used to cover two very
      // different problems: a genuinely new number, and a profile that exists
      // but whose phone cell the sheet has turned into #ERROR! - which looks
      // identical from here and costs the customer their point, their credit
      // and their place in the Messages tab. If any row in the Customers tab
      // has an unreadable phone, name it, because that is almost certainly
      // the one and it is one cell to fix.
      const broken = customers.rows
        .map((r, i) => ({ row: i + 2, cell: String(r[phoneCol] == null ? '' : r[phoneCol]).trim(),
                          name: rowToObject(customers.keys, r).name }))
        .filter((x) => x.cell && !/\d/.test(x.cell));
      const note = broken.length
        ? `No customer matched ${key}, and ${broken.length === 1 ? 'one row has' : broken.length + ' rows have'} ` +
          `an unreadable phone number: ` +
          broken.map((x) => `row ${x.row} (${x.name || 'no name'}) says ${x.cell}`).join(', ') +
          `. Retype the number in that cell as (201) 555-0123 — a leading + makes Sheets read it as a formula. ` +
          `Then set this ride back to Confirmed and to Completed again, so the point is awarded.`
        : `No customer profile for ${key} yet, so no point was awarded.`;
      return { statusCode: 200, body: JSON.stringify({ success: true, status: wanted, pointsChanged: false, note }) };
    }

    const c = rowToObject(customers.keys, customers.rows[cIdx]);
    const pointsBefore = parseInt(c.lifetime_points, 10) || 0;
    const points = Math.max(0, pointsBefore + delta);
    const completedRides = Math.max(0, (parseInt(c.completed_rides, 10) || 0) + delta);

    const today = easternToday();
    const previousStatus = c.status;
    const status_ = L.statusFor(points, previousStatus);
    const lastRide = nowCompleted ? today.date : (c.last_ride || '');
    const firstRide = (nowCompleted && !c.first_ride) ? today.date : (c.first_ride || '');
    const activity = completedRides === 0 ? '—' : L.activityFor(lastRide);

    // Credits follow the point exactly, in both directions.
    //
    // THE BUG THIS FIXES (caught by testing the reversal, 2026-09-18): taking
    // a point back left the credit behind. Mark a ride Completed, then
    // Cancelled, then Completed again — a correction anyone might make — and
    // the customer walked away with $10 of credit for one $5 ride. Whatever
    // completing awarded, un-completing takes back.
    const credit = nowCompleted ? L.creditEarnedAcross(pointsBefore, points) : null;
    // On the way OUT of Completed, the range runs the other way: from the new
    // lower total back up to the total that earned the credit in the first
    // place. Same milestone, same amount, reversed.
    const reversed = !nowCompleted && wasCompleted ? L.creditEarnedAcross(points, pointsBefore) : null;

    // ---- SPENDING the credit ----
    //
    // This is the half of the loyalty programme that did not exist. Credits
    // were earned, added up, and never went anywhere — the balance only ever
    // grew. A discount typed on the booking page is what spends them, and it
    // is spent HERE rather than at booking time, for the same reason points
    // are awarded here: a ride that gets cancelled should not cost the
    // customer a credit they never got the benefit of.
    //
    // A discount is NOT always a redemption. Ahmed knocks money off for all
    // sorts of reasons — a goodwill gesture, a regular he likes, a job that
    // ran short. So only the part of the discount the customer actually had
    // balance for comes off that balance. The rest is simply a lower price,
    // and touches nothing.
    //
    // The amount actually taken is written back to the booking row, so
    // un-completing the ride puts back exactly what was removed rather than
    // a number recalculated from a balance that has since moved.
    const balanceBefore = parseFloat(c.credit_owed) || 0;
    const discountOnRide = parseFloat(row.discount) || 0;
    const alreadySpent = parseFloat(row.discount_spent) || 0;

    // Without a discount_spent column there is nothing recording what was
    // actually taken, so an un-complete cannot put back the right amount. It
    // refuses to guess — refunding the whole discount would over-credit anyone
    // whose spend was capped by their balance — but it says so out loud rather
    // than quietly returning nothing, which is the failure nobody notices.
    const canRecordSpend = bookings.keys.includes('discount_spent');
    let spent = 0;
    let refunded = 0;
    let spendWarning = null;
    if (nowCompleted) {
      spent = Math.round(Math.min(discountOnRide, Math.max(0, balanceBefore)) * 100) / 100;
      if (spent && !canRecordSpend) {
        spendWarning = `$${spent} of credit was spent on this ride, but the Bookings tab has no "discount_spent" column, so it cannot be given back if this ride is later cancelled. Add that column to the header row.`;
      }
    } else if (wasCompleted) {
      refunded = alreadySpent;
      if (!refunded && discountOnRide && !canRecordSpend) {
        spendWarning = `This ride had a $${discountOnRide} discount, but the Bookings tab has no "discount_spent" column, so there is no record of how much credit was actually taken and none has been given back. Check ${who0(c, name, key)}'s balance by hand.`;
      }
    }

    const creditOwed = Math.max(0,
      Math.round((balanceBefore
        + (credit ? credit.amount : 0)
        - (reversed ? reversed.amount : 0)
        - spent
        + refunded) * 100) / 100);

    // Every event that moved the balance, written beside the balance. Two
    // things can happen on one ride - a credit earned AND a discount spent -
    // and both get their own entry, because a balance you cannot explain is
    // the thing this is here to prevent.
    let creditNote = c.credit_history || '';
    if (credit)   creditNote = addNote(creditNote, today.date,  credit.amount,   credit.reason);
    if (reversed) creditNote = addNote(creditNote, today.date, -reversed.amount, `ride marked ${wanted.toLowerCase()}`);
    if (spent)    creditNote = addNote(creditNote, today.date, -spent,
                                       row.discount_reason && row.discount_reason !== 'N/A'
                                         ? String(row.discount_reason) : 'discount on a ride');
    if (refunded) creditNote = addNote(creditNote, today.date,  refunded, 'discount put back');

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${CUSTOMERS_TAB}!A${cIdx + 2}:${customers.lastColumn}${cIdx + 2}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [buildRow(customers.keys, {
          lifetime_points: points,
          completed_rides: completedRides,
          status: status_,
          activity,
          first_ride: firstRide,
          last_ride: lastRide,
          credit_owed: creditOwed ? creditOwed : 0,
          credit_history: creditNote,
        }, customers.rows[cIdx])],
      },
    });

    // Record what was actually taken, on the ride that took it.
    if ((spent || refunded) && bookings.keys.includes('discount_spent')) {
      try {
        await sheets.spreadsheets.values.update({
          spreadsheetId,
          range: `${BOOKINGS_TAB}!A${atRow}:${bookings.lastColumn}${atRow}`,
          valueInputOption: 'USER_ENTERED',
          requestBody: {
            values: [buildRow(bookings.keys, {
              ride_status: wanted,
              discount_spent: nowCompleted ? (spent || 0) : 0,
            }, bookings.rows[idx])],
          },
        });
      } catch (err) { /* the balance is already right; this is the audit trail */ }
    }

    // ---- the referral ----
    // Paid to the REFERRER, once, when the person they sent completes their
    // first ride. Only on the first: a referral is worth one credit however
    // many times that customer comes back afterwards.
    let referral = null;
    // A missing column is the failure that looks like nothing happening, so
    // say it out loud rather than returning a silent null.
    if (nowCompleted && completedRides === 1 && !customers.keys.includes('referred_by')) {
      referral = { noColumn: 'The Customers tab has no "referred_by" column, so referrals can never be credited. Add one to the header row.' };
    }
    if (nowCompleted && completedRides === 1 && c.referred_by) {
      const refKey = normalizePhone(c.referred_by);
      const refIdx = refKey
        ? customers.rows.findIndex((r) => normalizePhone(r[phoneCol]) === refKey)
        : -1;
      if (refIdx !== -1 && refIdx !== cIdx) {
        const ref = rowToObject(customers.keys, customers.rows[refIdx]);
        const refOwed = (parseFloat(ref.credit_owed) || 0) + L.REFERRAL_CREDIT;
        const refNote = addNote(ref.credit_history, today.date, L.REFERRAL_CREDIT,
                                `referred ${c.name || key}`);
        try {
          await sheets.spreadsheets.values.update({
            spreadsheetId,
            range: `${CUSTOMERS_TAB}!A${refIdx + 2}:${customers.lastColumn}${refIdx + 2}`,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [buildRow(customers.keys, { credit_owed: refOwed, credit_history: refNote }, customers.rows[refIdx])] },
          });
          referral = { name: ref.name || refKey, phone: refKey, amount: L.REFERRAL_CREDIT, owed: refOwed };
        } catch (err) {
          referral = { error: err.message };
        }
      } else if (refKey) {
        referral = { unmatched: c.referred_by };
      }
    }

    // ---- tell Ahmed, so he can send the offer himself ----
    const who = c.name || name || key;
    let emailed = null;
    const becameLoyal = previousStatus !== L.STATUS_LOYAL && status_ === L.STATUS_LOYAL;

    if (credit || becameLoyal || spent || spendWarning || (referral && referral.amount)) {
      const subject = becameLoyal
        ? `⭐ New Loyal Customer – ${who}`
        : credit
          ? `${who} earned a $${credit.amount} credit`
          : spent
            ? `${who} used $${spent} of their credit`
            : `Check ${who}'s credit balance`;
      const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.7;color:#111">
        <p style="margin:0 0 12px"><strong>${who}</strong> — ${key}</p>
        <p style="margin:0 0 12px">${L.standingLine({ name: who, status: status_, activity, points, completedRides })}</p>
        ${credit ? `<p style="margin:0 0 12px"><strong>Earned: $${credit.amount}</strong> — ${credit.reason}.<br>Balance owed: <strong>$${creditOwed}</strong>.</p>` : ''}
        ${spent ? `<p style="margin:0 0 12px"><strong>Used: $${spent}</strong> of their credit on this ride${discountOnRide > spent ? ` (the discount was $${discountOnRide} — the rest was simply a lower price, not credit)` : ''}.<br>Balance left: <strong>$${creditOwed}</strong>.</p>` : ''}
        ${referral && referral.amount ? `<p style="margin:0 0 12px;padding:10px 12px;background:#f5f2ea;border-radius:6px"><strong>${referral.name}</strong> referred them — <strong>$${referral.amount}</strong> credit added, balance now <strong>$${referral.owed}</strong>.</p>` : ''}
        ${spendWarning ? `<p style="margin:0 0 12px;padding:10px 12px;background:#fdf0ee;border-left:3px solid #a05;border-radius:4px;color:#a05"><strong>Needs attention:</strong> ${spendWarning}</p>` : ''}
        ${referral && referral.unmatched ? `<p style="margin:0 0 12px;color:#a05">Referred by "${referral.unmatched}" — no customer with that number, so no referral credit was given.</p>` : ''}
        <p style="margin:0;color:#555;font-size:13px">Nothing has been sent to the customer. Send the offer yourself when you're ready, then adjust <code>credit_owed</code> in the Customers tab.</p>
      </div>`;
      try { await sendOwnerEmail(subject, html); emailed = subject; }
      catch (err) { emailed = `email failed: ${err.message}`; }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        status: wanted,
        pointsChanged: true,
        customer: {
          name: who, status: status_, activity, points, completedRides,
          // What they are working towards NOW, so the thank-you text can name
          // it without the page having to reload and read the sheet again.
          next: L.nextMilestone(points),
          creditOwed, creditEarned: credit ? credit.amount : 0,
          creditSpent: spent, creditReturned: refunded,
          discountOnRide,
          spendWarning,
          standing: L.standingLine({ name: who, status: status_, activity, points, completedRides }),
        },
        referral,
        emailed,
      }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
