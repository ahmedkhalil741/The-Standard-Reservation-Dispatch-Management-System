// What a trip costs, without booking anything.
//
// The website deliberately never shows a price — the promise is that a real
// person confirms your fare before the car moves. But when Ahmed is ON the
// phone with somebody, he needs that number in front of him, and working it
// out from a 77-row table while a customer waits is not realistic.
//
// So this answers the same question the booking functions answer internally,
// and writes nothing. No sheet row, no calendar entry, no email. Ask it as
// many times as you like while the address is still being typed.
//
// It is token-gated because it reveals the whole pricing model, which is not
// public. Same ADMIN_TOKEN as dispatch.

const { roundTripFare, isOvernightPickup, hourlyRateFor } = require('./_fare-calc');
const { FIRST_RIDE_CREDIT } = require('./_loyalty');
const { firstRideAvailable } = require('./_first-ride');

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
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const expected = process.env.ADMIN_TOKEN || '';
  if (!expected) return { statusCode: 503, body: JSON.stringify({ error: 'ADMIN_TOKEN is not set in Netlify.' }) };

  try {
    const { token, pickup, dropoff, vehicle, dateTime, payMethod, overrides, hours, firstRide,
            cardOnFile, phone, stops,
            returnDateTime, returnPickup, returnDropoff } = JSON.parse(event.body || '{}');
    if (token !== expected) return { statusCode: 401, body: JSON.stringify({ error: 'Wrong passcode.' }) };

    if (!pickup || !dropoff) {
      return { statusCode: 200, body: JSON.stringify({ ready: false, reason: 'Need both a pickup and a drop-off.' }) };
    }

    // THE PREVIEW HAS TO AGREE WITH WHAT GETS SAVED.
    //
    // log-booking takes $10 off a new customer's first ride by itself, but
    // this preview knew nothing about it. So the dispatch showed one total and
    // the sheet recorded another ten dollars lower — and the number Ahmed read
    // out to the customer was the one on the screen in front of him. Same
    // credit, same place in the arithmetic, so the two can never disagree.
    //
    // A discount already typed in wins: a loyalty balance being redeemed is
    // not also owed the new-customer ten.
    //
    // THE BROWSER NO LONGER DECIDES THIS. The dispatch used to send a
    // `firstRide` flag it worked out from completed_rides, and completed_rides
    // is still zero while an earlier booking sits unridden - so a customer's
    // outbound AND their return both came up ten dollars off, every time Ahmed
    // entered a round trip. The sheet answers it now, exactly as log-booking
    // does, so the quote on screen and the row that gets saved cannot disagree.
    // The flag is still accepted as a fallback for when no phone has been typed
    // in yet.
    const asked = withStops(withHours(overrides, hours), stops);
    const earned = phone ? await firstRideAvailable(phone) : Boolean(firstRide);
    const withCredit = (earned && !asked.discount)
      ? Object.assign({}, asked, { discount: FIRST_RIDE_CREDIT })
      : asked;

    // Same rule as log-booking: a saved card is quoted at the keyed rate, so
    // the screen Ahmed reads out and the row that gets saved cannot disagree.
    const payFor = (cardOnFile && /^card$/i.test(String(payMethod || '').trim()))
      ? 'Card on file' : payMethod;

    // ---- ONE PRICE FOR THE WHOLE JOB ----
    //
    // A round trip is one ride now - Ahmed's instruction, 4 November. This used
    // to price the two legs separately and hand the page a `bothTotal` to add
    // up, which meant the screen and the sheet each did their own arithmetic on
    // the same booking. They agree by construction now: roundTripFare is the
    // one function that totals a round trip, and log-booking calls exactly the
    // same one. That is the whole reason the preview exists.
    //
    // The toll once, the $10 first ride once, one card fee on the pair, and the
    // discount capped against both legs rather than stranded on the first - see
    // the note above roundTripFare in _fare-calc.js.
    const ret = returnDateTime
      ? { returnDateTime, returnPickup, returnDropoff }
      : null;
    const fare = roundTripFare(pickup, dropoff, vehicle, dateTime, payFor, withCredit, ret);
    const back = fare.returnLeg || null;

    // The parts, so a price can be EXPLAINED on the phone rather than just
    // stated. "Seventy-five, plus thirty-five because it's the Suburban."
    const lines = [];
    if (fare.matched) {
      // Four lines, never more. The vehicle surcharge, the city premium and
      // the overnight charge all live inside the fare now — see _fare-calc.js
      // for why. Tolls and the card fee keep their own lines because Ahmed
      // does not set either one.
      const shown = fare.fareBeforeDiscount !== undefined && fare.fareBeforeDiscount !== null
        ? fare.fareBeforeDiscount
        : fare.fare;
      if (shown) lines.push(`$${shown} fare${fare.roundTrip ? ', there and back' : ''}`);
      // Said out loud, with a minus sign, because this line is for Ahmed and
      // for the customer. The driver never sees it — see _fare-calc.js.
      if (fare.discountApplied) lines.push(`\u2212 $${fare.discountApplied} discount`);
      if (fare.toll) lines.push(`$${fare.toll} tolls`);
      if (fare.cardFee) lines.push(`$${fare.cardFee.toFixed(2)} ${fare.cardFeeLabel} fee (${fare.cardFeeRate})`);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        ready: true,
        matched: fare.matched,
        // WHAT THE RETURN LEG IS, NOT WHAT IT COSTS ON ITS OWN.
        //
        // `total` and `tip` above already cover both legs, because the job is
        // priced as one thing. This block is here so the page can SHOW the
        // split - "$235 out, $235 back" - without adding anything up itself.
        // It carried a `bothTotal` until 4 November and the page summed the
        // legs on screen; that is the arithmetic-in-two-places shape that put
        // $290 on the dispatch and $280 in the sheet last month.
        roundTrip: back ? {
          matched: fare.matched,
          from: back.from,
          to: back.to,
          dateTime: back.dateTime,
          outboundFare: fare.outboundFare ?? null,
          returnFare: fare.returnFare ?? null,
        } : null,
        label: fare.label || null,
        zone: fare.zone || null,
        total: fare.totalDisplay || null,
        display: fare.display,
        lines,
        tip: fare.tipSuggested,
        toll: fare.toll || 0,
        agreedFare: fare.agreedFare ?? null,
        discount: fare.discountApplied || 0,
        firstRideOff: (earned && !asked.discount) ? (fare.discountApplied || 0) : 0,
        // Asked for more than the fare could take — the rest stays on their
        // balance, and the page says so rather than quietly swallowing it.
        discountUnused: fare.discountUnused || 0,
        discountNote: fare.discountNote || null,
        // The parts, so the page can prefill an editable box per line.
        parts: {
          // The fare BEFORE the discount, because that is the box the discount
          // is subtracted from on screen. Showing the discounted figure there
          // would subtract it twice.
          fare: fare.fareBeforeDiscount !== undefined && fare.fareBeforeDiscount !== null
            ? fare.fareBeforeDiscount
            : (fare.fare || 0),
          discount: fare.discountApplied || 0,
          toll: fare.toll || 0,
          cardFee: fare.cardFee || 0,
        },
        overnight: isOvernightPickup(dateTime),
        // The rate for the car actually chosen - $85 Suburban or Escalade,
        // $75 Tesla. Sent so the dispatch never has a figure of its own to
        // fall out of step with.
        hourlyRate: hourlyRateFor(vehicle),
      }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
