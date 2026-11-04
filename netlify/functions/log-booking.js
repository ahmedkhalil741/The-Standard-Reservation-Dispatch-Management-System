// Logs every booking to a Google Sheet so all reservations (web bookings
// automatically, plus phone/text/email bookings entered through the private
// quick-entry page at admin-booking.html) live in one place you can open in
// Excel, or pull into Python/SQL later for year-end totals and tax reporting.
//
// ---- HOW COLUMNS ARE MATCHED (important) ----
// This function does NOT write to fixed column positions. It reads row 1 of
// the sheet and matches each value to the column with the matching HEADER
// NAME. That means you can add, delete, rename or reorder columns in the
// Bookings tab whenever you like and the data keeps landing in the right
// place — no code change needed.
//
// Header matching ignores case, spaces, hyphens and underscores, so
// "Base Fare", "base_fare" and "base fare" are all the same column.
//
// The values it knows how to fill, by header name:
//   timestamp, requested_datetime, pickup, dropoff, name, phone,
//   booking_id, passengers, car_seats, elderly_assistance, flight, stops, cabin_temp,
//   round_trip, return_datetime, return_pickup, return_dropoff,
//   text_before_ride, payment_method, notes, source, zone, base_fare,
//   card_fee, sedan, vehicle, toll, discount, discount_reason,
//   discount_spent, tip, hourly_trip, hours, waiting_late_fee, fare_total
// Any column whose header isn't in that list is left alone (so your own
// notes/status columns won't get overwritten). Any header in that list
// that isn't in your sheet is simply skipped.
//
// Anything the customer didn't provide is written as "N/A" rather than
// left blank — but only in columns of WORDS. A column of money gets a
// number, zero included, because a column that mixes the two stops being
// numeric and every average and chart over it goes quietly wrong. See
// orZero in _sheet.js.
//
// waiting_late_fee is the exception that proves it: it stays "N/A" because
// nobody knows it until the ride has happened. Fill it in by hand after.
//
// ---- ONE-TIME SETUP ----
// 1. Enable the "Google Sheets API" in the same Google Cloud project used
//    for Calendar/Maps (APIs & Services -> Library -> Enable).
// 2. Share the Sheet with the service account's email (the "client_email"
//    in the JSON key file) with "Editor" access.
// 3. Copy the Sheet's ID out of its URL:
//    https://docs.google.com/spreadsheets/d/THIS_PART_IS_THE_ID/edit
// 4. A second tab named "Customers" holds saved customer preferences —
//    see get-customer.js and save-customer.js.
//
// ---- Netlify environment variables required ----
//   GOOGLE_SERVICE_ACCOUNT_EMAIL = same value already used for Calendar
//   GOOGLE_SERVICE_ACCOUNT_KEY   = same value already used for Calendar
//   GOOGLE_SHEET_ID              = the Sheet ID from step 3 above
//
// Phone, text, and email bookings should go through the private quick-entry
// page (admin-booking.html) rather than being typed straight into the
// sheet, so they end up in the same format as web bookings and also update
// the customer's saved profile.

const { google } = require('googleapis');
const { estimateFare, roundTripFare, pricesAsSedan } = require('./_fare-calc');
const { formatTimestamp, formatRequestedDateTime, phoneCell } = require('./_format');
const { readTab, buildRow, orNA, orZero } = require('./_sheet');
const { firstRideOff, cardOnFile, payMethodFor } = require('./_first-ride');
const { newBookingId } = require('./_booking-id');

// The tab bookings are appended to.
const SHEET_TAB = 'Bookings';

// What gets written when the customer didn't give us something.
const NA = 'N/A';

async function getSheetsClient() {
  const auth = new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    null,
    (process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '').replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  await auth.authorize();
  return google.sheets({ version: 'v4', auth });
}

// Hours are an input to the price, not a correction of one, so they travel
// alongside the overrides rather than inside the caller's object.
function withHours(overrides, hours) {
  const base = (typeof overrides === 'object' && overrides !== null) ? overrides : { fare: overrides };
  return (hours === 0 || hours) ? Object.assign({}, base, { hours }) : base;
}

// Stops ride alongside the overrides for the same reason hours do: they are a
// property of the trip, not a price somebody typed over.
function withStops(overrides, stops) {
  const base = (typeof overrides === 'object' && overrides !== null) ? overrides : { fare: overrides };
  const list = Array.isArray(stops) ? stops.filter((x) => String(x || '').trim()) : [];
  return list.length ? Object.assign({}, base, { stops: list }) : base;
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const {
      name, pickup, dropoff, dateTime, phone, email, notes, payMethod,
      passengers, carSeats, flight, temp, elderly, contact15, source, vehicle, referredBy, overrides, stops,
      discountReason, hours, roundTrip,
    } = JSON.parse(event.body);

    if (!pickup || !dropoff) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing required booking details.' }) };
    }

    // The sheet is opened before the price is worked out, because whether this
    // is their first ride is part of the price.
    const sheets = await getSheetsClient();
    const first = await firstRideOff(phone, overrides, sheets);
    // A saved card costs more to accept, so it has to be known before the
    // price is quoted - see cardOnFile in _first-ride.js.
    const saved = await cardOnFile(phone, sheets);
    const payFor = payMethodFor(payMethod, saved);

    // ---- ONE ROW FOR A ROUND TRIP ----
    //
    // Ahmed's instruction, 4 November. The return leg used to be a second POST
    // to this same function from the page, which produced a second row, a
    // second ride card and a second Completed button. It is one job now:
    // roundTripFare adds the two legs, charges the toll once, charges the $10
    // first ride once, and works the card fee out once on the pair. See the
    // long note above roundTripFare in _fare-calc.js for what two rows got
    // wrong - the stranded discount and the $0 return leg especially.
    //
    // `roundTrip` is null on an ordinary booking and roundTripFare then behaves
    // exactly like estimateFare, so nothing about a one-way ride changes.
    const fare = roundTripFare(pickup, dropoff, vehicle, dateTime, payFor,
                               withStops(withHours(first.overrides, hours), stops), roundTrip);
    const back = fare.returnLeg || null;
    const isSedan = pricesAsSedan(vehicle);

    // Local (range) and unmatched routes don't break down into base + SUV,
    // so those cells get N/A and the whole quote goes in fare_total rather
    // than forcing a number that isn't real.
    const hasNumericFare = fare.matched && fare.total !== null;

    const cells = {
      // ---- THE RIDE'S OWN NAME ----
      //
      // Written once, here, and never touched again by anything. Every write
      // to this row afterwards finds it by this value rather than by its
      // position in the sheet, so deleting a row, inserting one or sorting the
      // tab can no longer send a status or a price onto somebody else's ride.
      // The whole argument is in _booking-id.js, including why it isn't the
      // phone number and why it isn't 1, 2, 3, 4.
      //
      // It is also a reference Ahmed can read down the phone - "your ride is
      // 1104-7K2MQX" - and something to search the sheet for when a customer
      // calls about a booking.
      booking_id: newBookingId(),
      timestamp: formatTimestamp(new Date().toISOString()),
      requested_datetime: formatRequestedDateTime(dateTime),
      // The month the RIDE falls in, not the month it was booked in — written
      // as "2026-09" so it sorts and filters as text. This exists so a
      // question like "how many rides did this customer take in September"
      // is one COUNTIFS in the sheet instead of a script that can drift out
      // of step with the rows it is counting.
      // A LEADING APOSTROPHE, AND IT MATTERS.
      //
      // "2026-10" looks like a date to Google Sheets, so with USER_ENTERED it
      // was parsed and stored as the serial number 46296 — Ahmed opened the
      // sheet and found a five-digit number where the month should be. The
      // apostrophe forces it to stay text; Sheets eats the apostrophe itself
      // and the cell reads "2026-10", which is what sorts and groups properly
      // at year end.
      ride_month: /^(\d{4})-(\d{2})/.test(String(dateTime || '')) ? "'" + String(dateTime).slice(0, 7) : NA,
      pickup,
      dropoff,
      name: orNA(name),
      phone: orNA(phoneCell(phone)),
      email: orNA(email),
      referred_by: orNA(referredBy),
      passengers: orNA(passengers),
      car_seats: (carSeats && carSeats !== '0') ? carSeats : 'None',
      elderly_assistance: elderly ? 'Yes' : 'No',
      flight: orNA(flight),
      // THE STOPS, WRITTEN OUT. The driver needs the addresses, not a count -
      // "2 stops" tells him nothing at 5am. The count and the fee are already
      // inside base_fare; this is the part a person reads.
      stops: (Array.isArray(stops) && stops.filter((x) => String(x || '').trim()).length)
        ? stops.filter((x) => String(x || '').trim()).join(' \u00b7 ')
        : NA,
      // ---- THE RETURN LEG, ON THE SAME ROW ----
      //
      // Three columns and a Yes/No, so the sheet still answers "was this a
      // round trip" with a filter rather than a text search through notes, and
      // so the driver reads the second pickup without opening anything else.
      // Add them to the Bookings header whenever you like - columns are matched
      // by NAME here, so the order does not matter and a missing one is simply
      // skipped.
      round_trip: back ? 'Yes' : 'No',
      return_datetime: back ? formatRequestedDateTime(back.dateTime) : NA,
      return_pickup: back ? back.from : NA,
      return_dropoff: back ? back.to : NA,
      cabin_temp: orNA(temp),
      text_before_ride: contact15 ? 'Yes' : 'No',
      payment_method: orNA(payMethod),
      notes: orNA(notes),
      source: source || 'Web',
      // Every booking starts here. Points are only awarded when this becomes
      // "Completed" on the dispatch page — see _loyalty.js.
      ride_status: 'Requested',
      // The whole driving charge for the vehicle booked, city premium,
      // SUV surcharge and overnight all included. There is no longer a
      // separate fee column for any of them — see _fare-calc.js.
      base_fare: hasNumericFare ? (fare.fareBeforeDiscount ?? fare.fare) : NA,
      // Which of the five the ride was: Newark, Manhattan, LaGuardia, JFK,
      // Local, or Other. This exists so a year-end question like "how much
      // did city work earn me" is one SUMIFS instead of a fragile text match
      // against a free-typed address.
      zone: fare.zone || NA,
      // Zero when the method costs nothing to accept, not N/A — we know.
      card_fee: orZero(fare.cardFee),
      // Yes for anything priced as a sedan, so the column still answers
      // "did this ride pay the Suburban surcharge" whatever the car is called.
      sedan: isSedan ? 'Yes' : 'No',
      // Says the vehicle outright so you never have to work it out from a
      // Yes/No. Paired with `zone`, this is what makes revenue splittable by
      // car and by destination at year-end.
      // THE CAR THAT IS ACTUALLY COMING, not the tier it was priced in.
      // Folding the Tesla into "Sedan" would lose which car turned up on
      // every row, and the driver's calendar entry reads this.
      vehicle: (vehicle || '').trim() || (isSedan ? 'Sedan' : 'SUV'),
      // A column headed "vehicle" or "car" normalises to car_type (see
      // HEADER_ALIASES in _sheet.js), so a row keyed only `vehicle` left that
      // column empty however it was spelled. Write both keys; whichever one
      // the sheet actually has gets filled and the other is ignored.
      car_type: (vehicle || '').trim() || (isSedan ? 'Sedan' : 'SUV'),
      // The toll is an ESTIMATE from the destination — a Manhattan run crosses
      // one Port Authority tolled bridge or tunnel and pays the congestion
      // charge, an airport run crosses the bridge only, Newark and local trips
      // cross nothing. Replace it with the real figure off the E-ZPass
      // statement if it differs; nothing else recalculates from it.
      // Zero on a Newark or local run, where the car crosses nothing.
      toll: orZero(fare.toll),
      // What came off the fare, and why. Written at booking time but NOT taken
      // off the customer's balance here — that happens when the ride is marked
      // Completed, in set-ride-status.js, so a cancelled ride never spends a
      // credit the customer never got the benefit of.
      discount: orZero(fare.discountApplied),
      // The reason stays words: N/A when nothing came off.
      discount_reason: fare.discountApplied
        ? orNA(discountReason || (first.applied ? 'First ride' : ''))
        : NA,
      // Nothing is spent off a balance until the ride is completed - see
      // set-ride-status.js. It starts at zero so the column is numeric from
      // the first row rather than from the first completed ride.
      discount_spent: 0,
      // These two genuinely cannot be known yet, so they stay N/A. The waiting
      // fee depends on what happened on the road, and the tip is a suggestion
      // until somebody actually hands it over. Both become a number — zero
      // included — once the ride has happened.
      waiting_late_fee: NA,
      tip: orNA(fare.tipSuggested),
      // The charge for an hourly job, and the hours it was billed for. N/A on
      // a normal A-to-B ride, which is most of them.
      //
      // This column used to read `fare.matched ? 'No' : 'Yes'` and was wrong
      // twice over: it guessed "hourly" purely because a route didn't match a
      // known zone — unmatched means unknown, not hourly — and it wrote Yes/No
      // into a column holding an amount everywhere else. Now the booking form
      // actually offers hourly, it holds the amount it always should have.
      hourly_trip: orZero(fare.hourlyAmount),
      hours: orZero(fare.hours),
      fare_total: hasNumericFare ? fare.total : (fare.matched ? fare.totalDisplay : fare.display),
    };

    // Read the header row and build the row in whatever order the sheet is
    // currently arranged in.
    const { keys, lastColumn } = await readTab(sheets, process.env.GOOGLE_SHEET_ID, SHEET_TAB);
    if (!keys.length) {
      throw new Error(`No header row found in the "${SHEET_TAB}" tab — row 1 must contain the column names.`);
    }

    const row = buildRow(keys, cells);

    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: `${SHEET_TAB}!A:${lastColumn}`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] },
    });

    // The customer sees this. Until now the fare was worked out here, written
    // to the sheet, mailed to Ahmed - and never shown to the person who asked
    // for the ride. They handed over a phone number and were told a number
    // would arrive by text later, on the page that promises nothing is hidden.
    //
    // Only the figures a quote is made of, and only when the route is one we
    // actually price. Nothing about zones, nothing about how the table works.
    // An unmatched route sends matched:false and the page says it will be
    // priced by hand, which is the truth rather than a blank.
    const quote = fare && fare.matched ? {
      matched: true,
      fare: fare.fare,
      toll: fare.toll || 0,
      cardFee: fare.cardFee || 0,
      cardFeeLabel: fare.cardFeeLabel || null,
      total: fare.total,
      tipSuggested: fare.tipSuggested || null,
      // So the confirmation screen can say "there and back" rather than
      // showing one number with no hint that it covers two journeys.
      roundTrip: Boolean(back),
    } : { matched: false, roundTrip: Boolean(back) };

    // The id goes back to whoever saved it, so the dispatch can address this
    // ride immediately without waiting for a re-read of the sheet.
    return { statusCode: 200, body: JSON.stringify({ success: true, quote, bookingId: cells.booking_id }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
