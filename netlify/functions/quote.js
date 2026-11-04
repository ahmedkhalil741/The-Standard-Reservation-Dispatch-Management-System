// A price, asked for and given, with nothing written down.
//
// WHY THIS EXISTS. The fare has always been worked out on this server - but
// only ever inside log-booking, which means the only way a customer could
// learn what their ride cost was to hand over their name and phone number
// first and be told a figure afterwards. On a page whose whole argument is
// that nothing is hidden and nothing is added at the end, that was the one
// place the argument stopped being true.
//
// So: the same calculation, reachable before the booking. The customer puts
// in where they are going and gets the number back. If they don't like it
// they close the tab and we never knew they were here, which is the honest
// cost of doing it this way and worth paying.
//
// It writes nothing. No sheet row, no calendar entry, no customer profile,
// no email. Asking a price is not a booking and must never leave a trace
// that looks like one - a quote that created a row would fill the dispatch
// board with rides nobody asked for.
const { roundTripFare } = require('./_fare-calc');
const { FIRST_RIDE_CREDIT } = require('./_loyalty');

// Hours are an input to the price, not a correction of one - same shape the
// booking function uses, so the two can never drift apart and quote a
// customer one number here and a different one when they book.
function withHours(overrides, hours) {
  const base = (typeof overrides === 'object' && overrides !== null) ? overrides : { fare: overrides };
  return (hours === 0 || hours) ? Object.assign({}, base, { hours }) : base;
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { pickup, dropoff, dateTime, vehicle, payMethod, hours, firstRide, stops,
            returnDateTime, returnPickup, returnDropoff } = JSON.parse(event.body || '{}');

    if (!pickup || !dropoff) {
      return { statusCode: 200, body: JSON.stringify({ matched: false, reason: 'need both ends' }) };
    }

    // Somebody we have never driven sees the $10 already off, rather than a
    // full price here and a different number at the end of the form. The
    // page knows they are new because get-customer told it so; log-booking
    // checks the sheet again before it writes anything down.
    const firstRideOff = firstRide ? { discount: FIRST_RIDE_CREDIT } : undefined;
    const cleanStops = Array.isArray(stops)
      ? stops.filter((x) => String(x || '').trim()).slice(0, 5)
      : [];
    const asked = withHours(firstRideOff, hours);
    // ---- ONE PRICE, BOTH WAYS ----
    //
    // A round trip is one ride as of 4 November, here as much as on the
    // dispatch. roundTripFare is the only place a round trip gets totalled, and
    // log-booking calls the same function, so the estimate on the booking page
    // and the row that gets written cannot drift apart. The toll is charged
    // once, the $10 first ride once, and there is one card fee on the pair
    // instead of two fixed charges for one swipe.
    const ret = returnDateTime
      ? { returnDateTime, returnPickup, returnDropoff }
      : null;
    const fare = roundTripFare(pickup, dropoff, vehicle, dateTime, payMethod,
                               cleanStops.length ? Object.assign({}, asked || {}, { stops: cleanStops }) : asked,
                               ret);
    const back = fare.returnLeg || null;

    // Only the figures a quote is made of. Nothing about zones, nothing about
    // how the table decides - the customer is owed their price, not ours.
    if (!fare || !fare.matched) {
      return { statusCode: 200, body: JSON.stringify({ matched: false }) };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        matched: true,
        fare: fare.fare,
        toll: fare.toll || 0,
        cardFee: fare.cardFee || 0,
        cardFeeLabel: fare.cardFeeLabel || null,
        total: fare.total,
        tipSuggested: fare.tipSuggested || null,
        firstRideOff: fare.discountApplied || 0,
        stops: cleanStops.length || 0,
        stopFee: fare.stopFee || 0,
        // Null on a one-way. `total` and `tipSuggested` above already cover
        // both legs - this says WHAT the return leg is, so the page can show
        // the split without adding anything up itself.
        roundTrip: back ? {
          matched: true,
          from: back.from,
          to: back.to,
          dateTime: back.dateTime,
          outboundFare: fare.outboundFare ?? null,
          returnFare: fare.returnFare ?? null,
        } : null,
      }),
    };
  } catch (err) {
    // A quote that fails is a quote not shown, never a booking that breaks.
    return { statusCode: 200, body: JSON.stringify({ matched: false }) };
  }
};
