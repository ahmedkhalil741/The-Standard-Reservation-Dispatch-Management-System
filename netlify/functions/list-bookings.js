// The upcoming rides, for the dispatch page.
//
// This hands back customer names, phone numbers and home addresses, so unlike
// every other function here it will not answer without a token. The PIN box on
// admin-booking.html is only a cover on a door — anyone who reads the page
// source can walk past it. A token checked HERE cannot be read out of the page.
//
// Netlify environment variable required:
//   ADMIN_TOKEN = any long random string you like. Treat it as a password.
//
// With ADMIN_TOKEN unset this function refuses every request rather than
// defaulting to open, because the failure nobody notices is the dangerous one.

const { google } = require('googleapis');
const { readTab, rowToObject } = require('./_sheet');
const { parseRequestedDateTime, easternToInstant } = require('./_format');
const { driversFromTab, fromEnvironment } = require('./_drivers');
const L = require('./_loyalty');

// Authorised once per warm container, not once per tap.
//
// Netlify reuses the container between invocations, so building a JWT and
// exchanging it with Google on every request was a round trip bought and
// thrown away each time somebody opened the page. google-auth-library
// refreshes the token itself when it expires, so holding the client is safe.
let cachedSheets = null;
async function sheetsClient() {
  if (cachedSheets) return cachedSheets;
  const auth = new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    null,
    (process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '').replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/spreadsheets.readonly']
  );
  await auth.authorize();
  cachedSheets = google.sheets({ version: 'v4', auth });
  return cachedSheets;
}

const SHEET_TAB = 'Bookings';
const CUSTOMERS_TAB = 'Customers';

// WHAT THIS PAGE IS FOR decides what it shows. There are exactly two reasons
// to open it: to give a ride to a driver, and to mark one finished afterwards.
// Both of those live in a narrow window around today. A booking three months
// out needs nothing from anybody yet, and showing it from the day it is made
// just means scrolling past next month to find tonight.
//
// So the default window is yesterday to a week ahead, and `days=all` widens it
// to everything upcoming when you actually want to look further out.
const BIRTHDAY_LOOKAHEAD_DAYS = 7;   // the same window the morning email uses
// A credit is only worth chasing once they have stopped coming.
//
// Everyone who finishes a ride is owed something, and the after-the-ride text
// on their own card has just told them so. Listing them again at the top the
// same afternoon is the system saying the same thing twice. Someone who
// earned credit a fortnight ago and has not been back is the one worth a
// note - that is the whole point of the list.
const CREDIT_QUIET_DAYS = 14;
const LOOK_BACK_HOURS = 30;      // yesterday, so last night's rides can still be marked
const DEFAULT_DAYS_AHEAD = 7;

exports.handler = async function (event) {
  const token = (event.queryStringParameters || {}).token || '';
  const expected = process.env.ADMIN_TOKEN || '';

  if (!expected) {
    return { statusCode: 503, body: JSON.stringify({ error: 'ADMIN_TOKEN is not set in Netlify. Set it, redeploy, and this page will work.' }) };
  }
  if (token !== expected) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Wrong passcode.' }) };
  }

  try {
    const sheets = await sheetsClient();
    const id = process.env.GOOGLE_SHEET_ID;

    // FOUR TABS AT ONCE, not one after another.
    //
    // This used to be six sequential round trips to Google - authorise,
    // Bookings, Customers, Credits, Drivers, and then Drivers AGAIN for the
    // dropdown - with each one waiting for the last to come back. On a phone
    // that is the pause between tapping Dispatch and seeing anything, and
    // Ahmed described it exactly: "it's so slow".
    //
    // allSettled, not all: only Bookings is load-bearing. A missing Customers,
    // Credits or Drivers tab must still leave the rides on screen, which is
    // what the individual try/catches used to guarantee one at a time.
    const [bk, cu, dr] = await Promise.allSettled([
      readTab(sheets, id, SHEET_TAB),
      readTab(sheets, id, CUSTOMERS_TAB),
      readTab(sheets, id, 'Drivers'),
    ]);

    if (bk.status !== 'fulfilled') throw bk.reason;
    const { headers, keys, rows } = bk.value;

    const daysParam = (event.queryStringParameters || {}).days || '';
    const showAll = String(daysParam).toLowerCase() === 'all';
    const daysAhead = /^\d+$/.test(daysParam) ? Number(daysParam) : DEFAULT_DAYS_AHEAD;

    // "Everything" has to mean everything. This used to widen only the far
    // end of the window, so a ride that happened the day before yesterday was
    // off the page with no setting that brought it back and no count saying it
    // existed - Bryan's completed Newark run simply was not there any more.
    // Now Everything drops the look-back as well, and `behind` below tells the
    // page how many are back there whatever window is chosen.
    const cutoff = showAll ? 0 : Date.now() - LOOK_BACK_HOURS * 3600 * 1000;
    // Measured to the END of the last day, not to this moment plus N days.
    // "Today" asked at 10am must still include tonight's 9pm airport run,
    // which "now + 24 hours" would happen to catch and "now + 1 day" at 11pm
    // would not.
    const endOfToday = easternToInstant(
      new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York',
        year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()) + 'T23:59'
    );
    const horizon = showAll
      ? Infinity
      : endOfToday.getTime() + Math.max(0, daysAhead - 1) * 86400 * 1000;

    // Who each customer is, so every reservation carries their standing —
    // Ahmed's spec point 6. A missing Customers tab must not take the
    // dispatch page down with it.
    const byPhone = new Map();
    let customerColumns = [];

    // WHO NEEDS A TEXT TODAY, independent of whether they have a booking.
    //
    // This is the half of the loyalty programme that no ride triggers. A
    // birthday arrives whether or not anyone books; a customer going quiet is
    // the absence of an event; a credit already earned sits there until
    // somebody tells them it exists. Until now all three only reached Ahmed in
    // a morning email, which meant the dispatch page he actually has open all
    // day knew nothing about them.
    //
    // One entry per PERSON, not one per reason. Someone with a birthday on
    // Friday who is also owed $10 is one text, not two, and splitting them is
    // how a customer gets messaged twice in an hour.
    const toText = [];

    // EVERY customer, for the Messages tab - name, phone, email and standing.
    // toText is "who needs a text today"; this is "everyone, so Ahmed can pick
    // one". Two different questions, and the first is useless for the second:
    // he wants to write to somebody precisely BECAUSE nothing flagged them.
    const people = [];
    const today = new Date();

    try {
      if (cu.status !== 'fulfilled') throw cu.reason;
      const cust = cu.value;
      customerColumns = cust.headers;
      const digits = (v) => String(v || '').replace(/\D/g, '').slice(-10);
      for (let ri = 0; ri < cust.rows.length; ri++) {
        const row = cust.rows[ri];
        const c = rowToObject(cust.keys, row);
        const key = digits(c.phone);

        // A BROKEN PHONE CELL USED TO DELETE SOMEBODY FROM THE SYSTEM.
        //
        // This line was `if (!key) continue;`. Two rows in the Customers tab
        // had #ERROR! where the phone should be - Sheets reading "+1 203 506
        // 1637" as a formula - and because that cell has no digits in it the
        // customer was dropped here without a word. They were not in the
        // Messages tab, so there was nobody to write to; set-ride-status
        // could not find them either, so completing their ride awarded no
        // point and wrote no credit row; and the sheet looked fine, because
        // the ride itself said Completed.
        //
        // Now the name is listed with the problem on it. Nothing can be sent
        // to a number we do not have - no texting, no credit granting, and
        // no standing to show - but a name in the list with "phone needs
        // fixing" beside it is a thing Ahmed can act on, and silence is not.
        if (!key) {
          if (c.name || c.email) {
            people.push({
              rowNumber: ri + 2,
              name: c.name || c.email, phone: '', email: c.email || '',
              status: L.STATUS_NEW, activity: '\u2014', points: 0,
              completedRides: parseInt(c.completed_rides, 10) || 0,
              creditOwed: parseFloat(c.credit_owed) || 0,
              birthday: c.birthday || '', cardOnFile: false, lastRide: '',
              next: L.nextMilestone(0),
              phoneBroken: String(c.phone || '').trim() || 'empty',
            });
          }
          continue;
        }
        const points = parseInt(c.lifetime_points, 10) || 0;
        const completedRides = parseInt(c.completed_rides, 10) || 0;
        const status = L.statusFor(points, c.status);
        // Never ridden yet is not the same as gone quiet.
        const activity = completedRides === 0 ? '—' : L.activityFor(c.last_ride);
        const creditOwed = parseFloat(c.credit_owed) || 0;
        byPhone.set(key, {
          status, activity, points, completedRides, creditOwed,
          firstRide: c.first_ride || '', lastRide: c.last_ride || '',
          next: L.nextMilestone(points),
          standing: L.standingLine({ name: c.name, status, activity, points, completedRides }),
        });

        const reasons = [];
        const sinceRide = L.daysSince(c.last_ride, today);
        if (creditOwed > 0 && (sinceRide === null || sinceRide >= CREDIT_QUIET_DAYS)) {
          reasons.push({ kind: 'credit', amount: creditOwed, days: sinceRide });
        }
        // Granted at the moment the text goes out, not now - see grant-credit.
        if (L.birthdayWithin(c.birthday, BIRTHDAY_LOOKAHEAD_DAYS, today) &&
            !L.birthdayOfferedThisYear(c.birthday_offered, today)) {
          reasons.push({ kind: 'birthday', amount: L.BIRTHDAY_CREDIT, on: c.birthday || '' });
        }
        if (completedRides > 0 && L.justWentQuiet(c.last_ride, today)) {
          reasons.push({ kind: 'quiet', amount: L.WIN_BACK_CREDIT, days: L.daysSince(c.last_ride, today) });
        }
        people.push({
          rowNumber: ri + 2,
          name: c.name || c.phone, phone: c.phone || '', email: c.email || '',
          status, activity, points, completedRides, creditOwed,
          birthday: c.birthday || '',
          // So the edit box opens with the right box ticked, and so the
          // booking form knows which card rate to quote - see _first-ride.js.
          cardOnFile: /^(yes|y|true|1)$/i.test(String(c.card_on_file || '').trim()),
          lastRide: c.last_ride || '',
          next: L.nextMilestone(points),
        });

        if (reasons.length) {
          toText.push({
            rowNumber: ri + 2,
            name: c.name || c.phone, phone: c.phone || '',
            status, activity, points, completedRides, creditOwed,
            birthday: c.birthday || '',
            next: L.nextMilestone(points),
            reasons,
          });
        }
      }
    } catch (err) {
      // leave byPhone and toText empty; the rides still list
    }

    // Birthdays first - they have a date on them and stop being true. A credit
    // owed is true for as long as it takes.
    // Most recently in the car first: the person Ahmed wants to write to is
    // usually somebody he has just thought about, and he has just driven them.
    people.sort((a, b) => String(b.lastRide || '').localeCompare(String(a.lastRide || '')) ||
                          String(a.name).localeCompare(String(b.name)));

    const ORDER = { birthday: 0, quiet: 1, credit: 2 };
    toText.sort((a, b) => ORDER[a.reasons[0].kind] - ORDER[b.reasons[0].kind] ||
                          String(a.name).localeCompare(String(b.name)));

    const rides = rows
      .map((row, i) => {
        const r = rowToObject(keys, row);
        const dateTime = parseRequestedDateTime(r.requested_datetime);
        return {
          rowNumber: i + 2,                 // 1 for the header, 1 because sheets count from 1
          dateTime,
          when: r.requested_datetime || '',
          name: r.name || '', phone: r.phone || '',
          pickup: r.pickup || '', dropoff: r.dropoff || '',
          // ---- THE RETURN LEG, ON THE SAME CARD ----
          //
          // A round trip is one row as of 4 November, so the card has to show
          // both journeys or the second one is invisible on the page the day is
          // actually run from. Read straight out of the sheet - these columns
          // are written by log-booking and matched by name, so a sheet that has
          // not had them added yet simply shows nothing here.
          roundTrip: /^(yes|y|true|1)$/i.test(String(r.round_trip || '').trim()),
          returnWhen: r.return_datetime && r.return_datetime !== 'N/A' ? r.return_datetime : '',
          returnPickup: r.return_pickup && r.return_pickup !== 'N/A' ? r.return_pickup : '',
          returnDropoff: r.return_dropoff && r.return_dropoff !== 'N/A' ? r.return_dropoff : '',
          // The addresses, which have never reached this page. The fee is
          // already inside base_fare; this is the part a driver reads.
          stops: r.stops && r.stops !== 'N/A' ? r.stops : '',
          vehicle: r.vehicle || r.car_type || '', passengers: r.passengers || '',
          carSeats: r.car_seats || '', flight: r.flight || '',
          temp: r.cabin_temp || '', elderly: r.elderly_assistance || '',
          notes: r.notes || '', payMethod: r.payment_method || '',
          fare: r.fare_total || '', driver: r.driver || '',
          // Ahmed's page, not the driver's — the driver gets a text with the
          // total to collect and nothing else. Showing the zone and any
          // discount here is also the only way to see, without opening the
          // sheet, that those columns are actually receiving values.
          zone: r.zone || '',
          // The stored parts of the price, so the driver can be told what the
          // fare, the tolls and the card fee are without anything being
          // recalculated. Recalculating is how a driver once got quoted the
          // SUV price for a sedan booking.
          toll: r.toll && r.toll !== 'N/A' ? r.toll : '',
          cardFee: r.card_fee && r.card_fee !== 'N/A' ? r.card_fee : '',
          tip: r.tip && r.tip !== 'N/A' ? r.tip : '',
          discount: r.discount && r.discount !== 'N/A' ? r.discount : '',
          discountReason: r.discount_reason && r.discount_reason !== 'N/A' ? r.discount_reason : '',
          discountSpent: r.discount_spent && r.discount_spent !== 'N/A' ? r.discount_spent : '',
          email: r.email || '',
          rideStatus: r.ride_status || '',
          cancelReason: r.cancel_reason || '',
          cardEntry: r.card_entry || '',
          customer: byPhone.get(String(r.phone || '').replace(/\D/g, '').slice(-10)) || null,
        };
      })
      .filter((r) => r.pickup && r.dropoff)
      // Undated rows stay in — better a ride you have to look at than one that
      // silently vanished because its date cell was typed by hand.
      // `dateTime` is Eastern wall-clock. Sticking a Z on it calls it UTC and
      // shrinks this six-hour look-back to two — a ride the driver is on RIGHT
      // NOW then vanishes off the dispatch page. easternToInstant is the only
      // correct way to turn a typed time into a real one.
      .filter((r) => {
        // A row with an unreadable date stays in whatever the window is —
        // better a ride you have to look at than one that silently vanished
        // because somebody typed its date by hand.
        if (!r.dateTime) return true;
        const t = (easternToInstant(r.dateTime) || new Date(0)).getTime();
        return t > cutoff && t < horizon;
      })
      // Anything already finished or called off drops to the bottom. It is
      // still there to look at or undo, just not in the way of the rides that
      // still need something doing.
      .sort((a, b) => {
        const done = (r) => /^(completed|cancelled|no-?show)$/i.test(String(r.rideStatus || '').trim()) ? 1 : 0;
        const byDone = done(a) - done(b);
        if (byDone) return byDone;
        return String(a.dateTime || '').localeCompare(String(b.dateTime || ''));
      });

    // How many are outside the window, so the page can offer to show them
    // rather than pretending they don't exist.
    const beyond = showAll ? 0 : rows.reduce((n, row) => {
      const r = rowToObject(keys, row);
      if (!r.pickup || !r.dropoff) return n;
      const dt = parseRequestedDateTime(r.requested_datetime);
      if (!dt) return n;
      const t = (easternToInstant(dt) || new Date(0)).getTime();
      return (t >= horizon) ? n + 1 : n;
    }, 0);

    // And how many have already been and gone. Counted even when the window is
    // the default, because "it has disappeared" is the wrong thing for the
    // page to imply about a ride that is sitting in the sheet.
    const behind = showAll ? 0 : rows.reduce((n, row) => {
      const r = rowToObject(keys, row);
      if (!r.pickup || !r.dropoff) return n;
      const dt = parseRequestedDateTime(r.requested_datetime);
      if (!dt) return n;
      const t = (easternToInstant(dt) || new Date(0)).getTime();
      return (t > 0 && t <= cutoff) ? n + 1 : n;
    }, 0);

    let drivers = [];
    let driversError = null;
    let driversSource = 'none';
    // One read of the Drivers tab answers both questions - where the dropdown's
    // names came from, and what they are. It used to be read twice.
    if (dr.status === 'fulfilled') {
      driversSource = dr.value.keys.length ? 'sheet' : 'tab has no header row';
      try { drivers = driversFromTab(dr.value.keys, dr.value.rows); }
      catch (err) { drivers = fromEnvironment(); }
    } else {
      driversSource = process.env.DRIVERS ? 'netlify setting (no Drivers tab yet)' : 'none';
      try { drivers = fromEnvironment(); } catch (err) { driversError = err.message; }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        rides,
        beyond,
        behind,
        toText,
        people,
        // Every figure the dispatch page quotes to a customer comes from here,
        // which reads _loyalty.js. Nothing in the page hardcodes a dollar
        // amount, so a rule change in one file can never leave a text message
        // promising last month's number.
        loyalty: {
          loyalPoints: L.LOYAL_POINTS,
          firstRide: L.FIRST_RIDE_CREDIT,
          loyal: L.LOYALTY_CREDIT,
          repeat: L.REPEAT_CREDIT,
          referral: L.REFERRAL_CREDIT,
          winBack: L.WIN_BACK_CREDIT,
          birthday: L.BIRTHDAY_CREDIT,
        },
        window: showAll ? 'all' : `${daysAhead} days`,
        drivers,
        driversError,
        hasDriverColumn: keys.includes('driver'),
        hasRideStatusColumn: keys.includes('ride_status'),
        // what the sheet's header row actually says, so an empty field on the
        // dispatch card points at a missing column rather than a mystery
        sheetColumns: headers,
        customerColumns,
        // Where the dropdown's names came from, so an empty dropdown points at
        // a missing tab rather than looking like a bug.
        driversFrom: driversSource,
        // Named so a blank field on a card points at a missing column instead
        // of being a mystery — the same mistake has cost hours twice already.
        missingColumns: {
          bookings: ['driver', 'ride_status', 'cancel_reason', 'card_entry', 'passengers', 'car_seats', 'elderly_assistance', 'email', 'referred_by']
            .filter((k) => !keys.includes(k)),
          customers: ['email', 'completed_rides', 'lifetime_points', 'activity', 'credit_owed', 'credit_history', 'referred_by', 'birthday', 'birthday_offered', 'car_seats']
            .filter((k) => !customerColumns.map((h) => String(h).trim().toLowerCase().replace(/[\s-]+/g, '_')).includes(k)),
        },
      }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
