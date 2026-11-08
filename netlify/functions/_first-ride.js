// Has this person ridden with us before, and does the $10 come off?
//
// WHY THIS IS ITS OWN FILE. Three places need the same answer and they must
// never disagree: the row written to the sheet, the email that lands in Ahmed's
// inbox, and what the customer was shown. When only log-booking knew about the
// discount, the sheet said $175 and the email said $185 for the same ride, and
// the first time that happens on a real booking nobody knows which number to
// collect.
//
// The sheet decides, not the browser. A page can be edited; a phone number with
// completed rides against it cannot.
const { google } = require('googleapis');
const { readTab, rowToObject } = require('./_sheet');
const { FIRST_RIDE_CREDIT } = require('./_loyalty');

const CUSTOMERS_TAB = 'Customers';
const BOOKINGS_TAB = 'Bookings';

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

const tenDigits = (v) => String(v || '').replace(/\D/g, '').slice(-10);

// IS THE TEN STILL AVAILABLE TO THIS NUMBER?
//
// Exported, because three places need this answer and the browser is not
// allowed to be one of them. The dispatch used to work it out for itself from
// completed_rides alone, which is a different question - see below - and that
// is how the same customer got ten dollars off their outbound AND their return.
//
// ONCE, EVEN ACROSS BOOKINGS THAT HAVE NOT HAPPENED YET.
//
// completed_rides answers "have they ridden before". It cannot answer "have
// they already been given the ten", because a booking made ten minutes ago has
// completed nothing. Book a new customer's trip out and their trip back in one
// sitting and both look like a first ride. The promise on the flyer is $10 off
// their first ride, not $10 off every ride booked before the first one happens.
//
// Whichever booking was entered first keeps it: it is in the sheet with "First
// ride" against it, so the second finds it and pays full price. Cancel the
// first and the credit is free again, which is right - a ride that never
// happened was never their first.
// WHY IT DIDN'T COME OFF, in words, or null when it did.
//
// This exists because of a real booking on 8 November: a new customer, and the
// $10 simply was not there in the sheet. Nothing anywhere said why. Every one
// of the four reasons below returned a bare `false` and the dispatch drew a
// price with no discount and no explanation - so the only way to find out was
// to ask Claude and go through them one at a time.
//
// A silent no is the thing that cost the time, not the no itself.
async function firstRideWhyNot(phone, existingSheets) {
  const digits = tenDigits(phone);
  if (digits.length !== 10) {
    return 'no $10: the phone number is not ten digits, so this customer cannot be looked up';
  }

  try {
    const sheets = existingSheets || (await sheetsClient());
    const id = process.env.GOOGLE_SHEET_ID;

    const { keys, rows } = await readTab(sheets, id, CUSTOMERS_TAB);
    const them = rows
      .map((r) => rowToObject(keys, r))
      .find((c) => tenDigits(c.phone) === digits);
    const done = them ? (parseInt(them.completed_rides, 10) || 0) : 0;
    if (done > 0) {
      return `no $10: this number already has ${done} completed ride${done === 1 ? '' : 's'} in the Customers tab, so they are not a new customer`;
    }

    const bookings = await readTab(sheets, id, BOOKINGS_TAB);
    const already = bookings.rows
      .map((r) => rowToObject(bookings.keys, r))
      .find((b) => tenDigits(b.phone) === digits &&
                   !/^(cancelled|no-?show)$/i.test(String(b.ride_status || '').trim()) &&
                   /first ride/i.test(String(b.discount_reason || '')));
    if (already) {
      return 'no $10: an earlier booking for this number already took the first-ride discount';
    }
  } catch (err) {
    return `no $10: the sheet could not be read (${err.message}) - full price is the safe wrong answer`;
  }

  return null;
}

async function firstRideAvailable(phone, existingSheets) {
  const digits = tenDigits(phone);
  if (digits.length !== 10) return false;

  try {
    const sheets = existingSheets || (await sheetsClient());
    const id = process.env.GOOGLE_SHEET_ID;

    const { keys, rows } = await readTab(sheets, id, CUSTOMERS_TAB);
    const them = rows
      .map((r) => rowToObject(keys, r))
      .find((c) => tenDigits(c.phone) === digits);
    if (them && (parseInt(them.completed_rides, 10) || 0) > 0) return false;

    const bookings = await readTab(sheets, id, BOOKINGS_TAB);
    const alreadyGiven = bookings.rows
      .map((r) => rowToObject(bookings.keys, r))
      .some((b) => tenDigits(b.phone) === digits &&
                   !/^(cancelled|no-?show)$/i.test(String(b.ride_status || '').trim()) &&
                   /first ride/i.test(String(b.discount_reason || '')));
    if (alreadyGiven) return false;
  } catch (err) {
    // No Customers tab yet, or the read failed. Full price is the safe wrong
    // answer: it takes ten seconds to correct on the dispatch, and a discount
    // handed to the wrong person cannot be taken back.
    return false;
  }

  return true;
}

// Returns the overrides to price with, and how much was taken off.
//
// A discount already set by hand wins outright. Someone redeeming $15 of credit
// from the dispatch is not also owed the new-customer ten, and Ahmed deciding a
// price is not something this should quietly edit.
async function firstRideOff(phone, overrides, existingSheets) {
  const base = (typeof overrides === 'object' && overrides !== null) ? overrides : { fare: overrides };
  const none = { overrides: base, applied: 0 };

  if (base.discount) return none;
  if (!(await firstRideAvailable(phone, existingSheets))) return none;

  return {
    overrides: Object.assign({}, base, { discount: FIRST_RIDE_CREDIT }),
    applied: FIRST_RIDE_CREDIT,
  };
}

// IS THIS CUSTOMER'S CARD SAVED IN SQUARE?
//
// A saved card is card-not-present, and Square charges 3.5% + 15c for it
// instead of 2.6% + 15c. Until now everybody was quoted the tapped price and
// Ahmed absorbed the difference - about $2.20 on a $245 ride. His call,
// 23 October: the customer pays the real cost of the method they chose.
//
// IT HAS TO BE KNOWN AT BOOKING TIME, which is the whole reason this reads
// the sheet rather than waiting for the car. Every message we send promises
// a flat price with nothing added at the end, and a fee that changes once the
// reader comes out would make that a lie for two dollars.
//
// So a NEW customer is always quoted the tapped rate: they carry no flag yet,
// and this returns false. The flag is set the first time Ahmed marks a ride
// "On file" on the dispatch - a button he already presses - and from the next
// booking on, the price is right from the start.
async function cardOnFile(phone, existingSheets) {
  const digits = tenDigits(phone);
  if (digits.length !== 10) return false;
  try {
    const sheets = existingSheets || (await sheetsClient());
    const { keys, rows } = await readTab(sheets, process.env.GOOGLE_SHEET_ID, CUSTOMERS_TAB);
    if (!keys.includes('card_on_file')) return false;
    const them = rows
      .map((r) => rowToObject(keys, r))
      .find((c) => tenDigits(c.phone) === digits);
    return Boolean(them && /^(yes|y|true|1)$/i.test(String(them.card_on_file || '').trim()));
  } catch (err) {
    // The cheaper rate is the safe wrong answer: overcharging somebody by
    // $2 is a refund and an apology, undercharging is 90 cents of our own.
    return false;
  }
}

// What to price with. "Card on file" is a real entry in _card-fee.js with the
// keyed rate against it; everything else is left exactly as it arrived.
function payMethodFor(payMethod, saved) {
  return (saved && /^card$/i.test(String(payMethod || '').trim())) ? 'Card on file' : payMethod;
}

module.exports = { firstRideOff, firstRideAvailable, firstRideWhyNot, cardOnFile, payMethodFor, FIRST_RIDE_CREDIT };
