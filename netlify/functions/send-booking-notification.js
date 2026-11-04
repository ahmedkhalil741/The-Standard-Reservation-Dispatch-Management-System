// Sends a booking notification email to the business owner whenever a
// customer submits the booking form — regardless of payment method.
//
// The fare breakdown only lists charges that actually apply to THAT trip.
// No placeholder rows: if there's no SUV fee, no SUV line; if it isn't an
// overnight pickup, no overnight line. Toll and waiting/late-pickup aren't
// knowable until the ride happens, so they never appear here at all.
//
// Setup required in Netlify dashboard (Site settings → Environment variables):
//   RESEND_API_KEY   = your API key from resend.com (free tier: 100 emails/day)
//   OWNER_EMAIL      = thestandard.nj@yahoo.com  (where booking alerts go)
//   FROM_EMAIL       = onboarding@resend.dev  (works immediately with no setup;
//                       switch to a verified standardnj.com address later)

const { roundTripFare, isOvernightPickup } = require('./_fare-calc');
const { firstRideOff } = require('./_first-ride');
const { formatRequestedDateTime } = require('./_format');

const LABEL_STYLE = 'padding:2px 14px 2px 0; color:#888; white-space:nowrap;';

function fareTable(fare) {
  const rows = [];

  if (fare.matched && fare.total !== null) {
    const shownFare = fare.fareBeforeDiscount ?? fare.fare;
    const hasExtras = Boolean(fare.toll || fare.cardFee || fare.discountApplied);
    // With no extras the fare IS the total — don't print the same number
    // twice, just show the one line.
    if (hasExtras) {
      rows.push(['Fare', `$${shownFare}`]);
      // This email goes to Ahmed and nobody else, so the discount is stated
      // plainly rather than folded into the fare.
      if (fare.discountApplied) rows.push(['Discount', `\u2212 $${fare.discountApplied}`]);
      // Its own line, never folded into the fare. Ahmed doesn't set either of
      // these two, which is exactly why they're shown apart.
      if (fare.toll) rows.push(['Tolls', `$${fare.toll}`]);
      if (fare.cardFee) rows.push([`${fare.cardFeeLabel} fee (${fare.cardFeeRate})`, `$${fare.cardFee.toFixed(2)}`]);
    }
    rows.push(['Fare total', `$${fare.total}`, true]);
    rows.push([`Suggested tip \u2014 20% of the $${fare.fare} fare`, `$${fare.tipSuggested}`]);
  } else if (fare.matched) {
    rows.push([fare.label, fare.totalDisplay, true]);
    if (fare.tipSuggested) rows.push(['Suggested tip (20%)', `$${fare.tipSuggested}`]);
  } else {
    rows.push(['No fixed route match', fare.display, true]);
  }

  return rows
    .map(([label, value, bold]) => `<tr><td style="${LABEL_STYLE}${bold ? ' font-weight:bold;' : ''}">${label}</td><td${bold ? ' style="font-weight:bold;"' : ''}>${value}</td></tr>`)
    .join('');
}

// Hours are an input to the price, not a correction of one, so they travel
// alongside the overrides rather than inside the caller's object.
function withHours(overrides, hours) {
  const base = (typeof overrides === 'object' && overrides !== null) ? overrides : { fare: overrides };
  return (hours === 0 || hours) ? Object.assign({}, base, { hours }) : base;
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const {
      name, pickup, dropoff, dateTime, phone, notes, payMethod,
      passengers, carSeats, flight, temp, elderly, contact15, vehicle, overrides, hours, roundTrip,
    } = JSON.parse(event.body);

    if (!pickup || !dropoff || !phone) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing required booking details.' }) };
    }

    // The same check log-booking makes, from the same sheet, so this email
    // and the row it is telling Ahmed about can never show two prices.
    const first = await firstRideOff(phone, overrides);
    // One job, both legs. A round trip is one booking as of 4 November, and
    // this email has to quote the figure that actually gets charged - the same
    // function log-booking uses, for the same reason the dispatch preview does.
    const fare = roundTripFare(pickup, dropoff, vehicle, dateTime, payMethod,
                               withHours(first.overrides, hours), roundTrip);
    const back = fare.returnLeg || null;
    const overnight = isOvernightPickup(dateTime);

    const emailBody = `
      <h2>New booking request — The Standard</h2>
      <p><strong>Customer name:</strong> ${name || 'N/A'}</p>
      <p><strong>Pickup:</strong> ${pickup}</p>
      <p><strong>Drop-off:</strong> ${dropoff}</p>
      ${back ? `<p><strong>Round trip — the way back:</strong> ${formatRequestedDateTime(back.dateTime)}<br>${back.from} → ${back.to}<br><span style="color:#777;font-size:0.9em">One ride, one row in the sheet. Tolls charged once; the fare below covers both legs.</span></p>` : ''}
      <p><strong>Requested time:</strong> ${formatRequestedDateTime(dateTime)}${overnight ? ' <span style="color:#c9a227;">(overnight pickup)</span>' : ''}</p>
      <p><strong>Vehicle:</strong> ${vehicle || 'SUV'}</p>
      <p><strong>Customer phone:</strong> ${phone}</p>
      ${passengers ? `<p><strong>Passengers:</strong> ${passengers}</p>` : ''}
      <p><strong>Car seats needed:</strong> ${carSeats && carSeats !== '0' ? carSeats : 'None'}</p>
      <p><strong>Elderly assistance needed:</strong> ${elderly ? 'Yes' : 'No'}</p>
      <p><strong>Flight number:</strong> ${flight || 'N/A'}</p>
      <p><strong>Cabin temperature:</strong> ${temp || 'No preference'}</p>
      <p><strong>Text/call 15 min before pickup:</strong> ${contact15 ? 'Yes' : 'No'}</p>
      <p><strong>Payment method:</strong> ${payMethod || 'N/A'}</p>
      <p><strong>Notes:</strong> ${notes || 'None'}</p>
      <hr>
      <div style="background:#fff6dd; border-left:3px solid #c9a227; padding:10px 14px; font-size:0.95em;">
        <strong>Fare for this trip</strong>
        <table style="margin-top:6px; border-collapse:collapse;">${fareTable(fare)}</table>
        <div style="color:#888; font-size:0.85em; margin-top:6px;">Internal estimate only. Confirm the final number with the customer before it's locked in.</div>
      </div>
      <p style="color:#888; font-size:0.85em;">This booking is not yet confirmed with the customer — let them know the price as soon as possible.</p>
    `;

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.FROM_EMAIL || 'onboarding@resend.dev',
        to: process.env.OWNER_EMAIL,
        subject: `New booking: ${pickup} → ${dropoff}${back ? ' (round trip)' : ''}`,
        html: emailBody,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Email send failed: ${errText}`);
    }

    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

// Exported so the breakdown can be checked without sending mail.
module.exports.fareTable = fareTable;
