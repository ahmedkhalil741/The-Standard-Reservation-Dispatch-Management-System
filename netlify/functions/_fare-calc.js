// Internal fare estimator — NOT shown to customers as a public price list.
// It works out what a trip costs so the owner email, the calendar event and
// the Bookings sheet all agree, and so a price can be quoted instantly.
//
// ---- HOW PRICING WORKS ----
// Flat rates, never per-mile. The customer is told one number before the car
// moves. The site promises "No surge pricing. No meter. No surprises", and
// a meter would break that promise.
//
// A trip is priced from a TOWN and a DESTINATION:
//
//   town  -> the pickup or drop-off that isn't an airport or Manhattan
//   dest  -> Newark (EWR), Manhattan, LaGuardia or JFK
//
// TOWN_FARES below holds one price per town per destination. Those are SEDAN
// prices, all in. An SUV adds a surcharge on top: $35 to Newark, $50 to
// Manhattan, LaGuardia or JFK. A sedan adds nothing.
//
// Trips between two listed towns are the local flat rate, same either car.
// Anything else returns matched:false and is quoted by hand.
//
// ---- WHY THERE IS NO LONGER A "NEW YORK SEDAN FEE" ----
// There used to be a $35 surcharge on New York trips in a sedan, on top of
// the base. The town table replaced it, because these prices are already
// complete sedan prices — adding a sedan fee would charge it twice and put
// the sedan fares well above the local market. SEDAN_FEE_NY stays exported
// as null so the sheet's sedan_fee_ny column keeps writing "N/A".
//
// To change a price, edit TOWN_FARES. To add a town, copy a row. Nothing
// else needs to change.

const { cardFeeFor } = require('./_card-fee');

// A number, or null. Zero is a real answer — "waive the card fee" is written
// as 0 and has to survive, so a plain falsy check would throw it away.
function numOrNull(v) {
  return ((v === 0 || v) && !isNaN(parseFloat(v))) ? Math.max(0, parseFloat(v)) : null;
}

// SUV surcharges. A sedan pays neither.
const SUV_FEE = 35;        // to Newark
const SUV_FEE_NY = 50;     // to Manhattan, LaGuardia, JFK

// WHICH CARS PRICE AS A SEDAN.
//
// The Suburban is the only one that costs more, so this is the whole of the
// question "does the surcharge apply". The Tesla seats four and takes the
// same roads; charging Suburban money for it would be charging for a car
// nobody is getting.
//
// Named rather than written as "anything that isn't an SUV", because the
// vehicle arrives as free text from a form and from the sheet, and a typo
// would then quietly bill somebody the Suburban rate. Unknown pays the
// higher price: being asked for $35 you do not owe is a phone call, giving
// away $35 is gone.
const SEDAN_CARS = ['sedan', 'tesla', 'model y'];
function pricesAsSedan(vehicle) {
  const v = String(vehicle || '').trim().toLowerCase();
  return SEDAN_CARS.some((name) => v.includes(name));
}

// Pickup between 12:00 AM and 5:59 AM.
const OVERNIGHT_FEE = 10;

// Town to town, all-inclusive, same price either vehicle.
const LOCAL_RANGE = [20, 35];

// ---- TOLLS ----
// Charged to the customer as their own line, never buried in the base fare.
// The site promises "No surge pricing. No meter. No surprises", and a toll
// added after the ride is exactly the surprise that promise rules out.
//
// THESE ARE AHMED'S FIXED FIGURES, not a live lookup, and they are ROUND TRIP.
// The passenger travels one way; the car does not. Sending a driver to JFK
// means paying to get there and paying to get back, and the customer who
// caused the journey pays for the journey. This is how black-car and limousine
// operators normally quote out-of-area work, and it is why these are roughly
// double a one-way published rate.
//
// It follows that the toll applies whether the trip GOES to New York or COMES
// FROM it - either way the car makes the round trip. The code already matches
// a destination at either end, so that falls out for free.
//
// Flat amounts, deliberately. Real tolls move with the hour and the crossing,
// but a number that changes while a customer is on the phone is worse than a
// number that is occasionally a dollar out.
const TOLLS = {
  ewr:    { standard: 0,  overnight: 0 },   // Route 78 is free
  manh:   { standard: 29, overnight: 29 },  // Manhattan, round trip
  lgajfk: { standard: 50, overnight: 50 },  // LaGuardia and JFK, round trip
};
const LOCAL_TOLL = 0;

// For work that isn't A to B — a night out, waiting between stops, errands.
//
// NO MINIMUM, which is Ahmed's decision from 2026-09-17 and the thing that
// actually wins these jobs. Summit Express, three streets away, charges $55 an
// hour but will not take the booking under FIVE HOURS - so a one-hour job is
// $275 from them and $85 from us. Nobody else local will take the short ones.
//
// THE RATES WENT UP ON 8 NOVEMBER, from a flat $60, after reading what the
// competition actually publishes. Summit Elite Class lists $95/hr for an SUV
// and $80 for a sedan, and theirs is before tolls, fees AND gratuity - ours has
// the tolls inside it. At $60 we were charging about half the going rate for
// the one kind of work that costs a whole day.
//
// Ahmed's call: $85 for the Suburban or the Escalade, $75 for the Tesla. Still
// under Summit Elite on both, still no minimum, still tolls included.
//
// The airport card was deliberately NOT touched. Those prices are printed on
// cards and flyers already handed out, and airport work is where customers
// genuinely shop on price. Hourly is neither - it lives in this file and on one
// line of the website, and somebody booking a car for a day is choosing on
// trust and availability, not on five dollars an hour.
const HOURLY_RATE_SUV = 85;
const HOURLY_RATE_SEDAN = 75;

// Split on the SAME test the rate card uses, so there is one idea of what
// counts as a sedan rather than two that can drift apart. SEDAN_CARS covers
// the Tesla, which is why the Tesla gets $75.
function hourlyRateFor(vehicle) {
  return pricesAsSedan(vehicle) ? HOURLY_RATE_SEDAN : HOURLY_RATE_SUV;
}

// Kept so nothing that still imports it breaks. It is the SUV rate, which is
// the one to quote when the car is not yet known.
const HOURLY_RATE = HOURLY_RATE_SUV;

// ---- A STOP ON THE WAY ----
//
// Ahmed's rule, 30 October: "$15 for any short stops, but for a long ride
// just add a normal price as a full ride." So a quick stop - collect somebody,
// drop a bag, pick up a key - is a flat $15 and the route price is otherwise
// untouched. A detour that is really another journey (his example: Summit, a
// stop in Morristown, then on) is not a stop at all; it is priced as its own
// leg at the listed fare, which is a judgement nobody can make from an address
// string, so Ahmed makes it when he confirms the booking.
//
// It goes on the DRIVING charge rather than beside it, which is deliberate
// and is the other half of his instruction - "the tip will be for the whole
// amount". The tip is 20% of driving, so adding the stop fee there means the
// tip counts it, and the card fee counts it too. A stop that paid no tip
// would quietly make the driver's hour worth less for the trouble.
//
// Hourly trips get no stop fee: the hours already cover the stops, which is
// what Ahmed meant by "stops inside the waiting time, that's fine".
// Revised 30 October, Ahmed's rule: "if it's a stop in the same town, a quick
// stop, no additional fee. If it's in another town, make $10 additional fee."
//
// Which is the right shape. Pulling in on the way past somebody's house three
// streets from the pickup costs the driver two minutes; crossing into the next
// town costs him a leg of a journey. A flat fee for both was charging for the
// first and undercharging for the second.
const STOP_FEE = 10;

// What the stops add, and whether we can price them at all.
//
// A stop in a town that is not on the rate card is the same situation as a
// FARE that is not on the rate card, and gets the same answer: we do not
// invent a number, we say it needs quoting by hand. Ahmed's instruction -
// "if not listed just make same as we do if the fare not listed". A long
// detour is really another journey and he prices it himself, by the hour or
// as its own leg; no address string tells you which.
function stopsCharge(stops, pickupText) {
  const list = Array.isArray(stops)
    ? stops.map((x) => String(x || '').trim()).filter(Boolean)
    : [];
  if (!list.length) {
    const n = parseInt(stops, 10);
    // A bare count has no address to look up, so it falls back to the old
    // flat fee. Nothing in the app sends one; this is for safety.
    return { count: Number.isFinite(n) && n > 0 ? n : 0,
             fee: (Number.isFinite(n) && n > 0 ? n : 0) * STOP_FEE, unlisted: [] };
  }

  const home = findTown(pickupText);
  let fee = 0;
  const unlisted = [];
  for (const stop of list) {
    const town = findTown(stop);
    if (!town) { unlisted.push(stop); continue; }
    // Same town as the pickup is a quick stop and costs nothing.
    if (home && town.town === home.town) continue;
    fee += STOP_FEE;
  }
  return { count: list.length, fee, unlisted };
}
const HOURLY_MINIMUM_HOURS = 0;

// The four destinations the table prices. LaGuardia and JFK share a column.
const DESTINATIONS = [
  { key: 'ewr',    zone: 'Newark',    label: 'Newark Liberty Airport (EWR)', ny: false, test: /\bnewark\s*(liberty)?\s*(international)?\s*airport\b|\bewr\b/i },
  // "New York" on its own is how Google labels a Manhattan address once the
  // street and the state have been stripped off ("350 5th Ave, New York, NY").
  { key: 'manh',   zone: 'Manhattan', label: 'Manhattan / New York City',    ny: true,  test: /\bmanhattan\b|^\s*new york\s*$|\bnew york,?\s*ny\b|\bnyc\b/i },
  { key: 'lgajfk', zone: 'LaGuardia', label: 'LaGuardia Airport (LGA)',      ny: true,  test: /\blaguardia\b|\blga\b/i },
  // Google writes it out in full: "John F Kennedy International Airport".
  { key: 'lgajfk', zone: 'JFK',       label: 'JFK Airport',                  ny: true,  test: /\bjfk\b|\bjohn f\.?\s*kennedy\b|\bkennedy\s+(international\s+)?airport\b/i },
];

// One row per town. `names` holds every spelling worth matching — Google
// formats addresses its own way, and the source list abbreviates ("W. Orange",
// "Seaside Hghts"). Longest match wins, so "South Bound Brook" beats
// "Bound Brook" and "New Providence" beats "Union".
const TOWN_FARES = [
  { town: 'Allentown',        names: ['allentown'],                              ewr: 150, manh: 210, lgajfk: 260 },
  { town: 'Asbury Park',      names: ['asbury park'],                            ewr: 120, manh: 180, lgajfk: 230 },
  { town: 'Avenel',           names: ['avenel'],                                 ewr: 75,  manh: 135, lgajfk: 185 },
  { town: 'Basking Ridge',    names: ['basking ridge'],                          ewr: 105, manh: 165, lgajfk: 215 },
  { town: 'Bayonne',          names: ['bayonne'],                                ewr: 80,  manh: 140, lgajfk: 190 },
  { town: 'The Hills',        names: ['the hills'],                              ewr: 110, manh: 170, lgajfk: 220 },
  { town: 'Bedminster',       names: ['bedminster'],                             ewr: 115, manh: 175, lgajfk: 220 },
  { town: 'Belle Mead',       names: ['belle mead', 'bellmead'],                 ewr: 130, manh: 190, lgajfk: 240 },
  { town: 'Berkeley Heights', names: ['berkeley heights'],                       ewr: 80,  manh: 140, lgajfk: 185 },
  { town: 'Bound Brook',      names: ['bound brook'],                            ewr: 80,  manh: 150, lgajfk: 190 },
  { town: 'Bernardsville',    names: ['bernardsville'],                          ewr: 115, manh: 175, lgajfk: 225 },
  { town: 'Branchburg',       names: ['branchburg'],                             ewr: 115, manh: 175, lgajfk: 225 },
  { town: 'Bridgewater',      names: ['bridgewater'],                            ewr: 115, manh: 165, lgajfk: 215 },
  { town: 'Chatham',          names: ['chatham'],                                ewr: 80,  manh: 140, lgajfk: 185 },
  { town: 'Chester',          names: ['chester'],                                ewr: 145, manh: 200, lgajfk: 250 },
  { town: 'Clinton',          names: ['clinton'],                                ewr: 150, manh: 210, lgajfk: 260 },
  { town: 'Convent Station',  names: ['convent station'],                        ewr: 90,  manh: 150, lgajfk: 200 },
  { town: 'Dunellen',         names: ['dunellen'],                               ewr: 85,  manh: 145, lgajfk: 195 },
  { town: 'East Hanover',     names: ['east hanover'],                           ewr: 85,  manh: 150, lgajfk: 195 },
  // ---- WESTCHESTER, added 23 Oct. Priced in the JFK band rather than by
  // distance: it is under thirty miles but every mile of it crosses the city
  // and a bridge, which is where the time actually goes. A Pelham job was
  // once hand-priced at $408 and the customer walked.
  // ONE NUMBER IN ALL THREE COLUMNS, and that is not laziness.
  //
  // Westchester is forty miles and an hour from New Providence before the
  // customer is even in the car, and that hour is the same whether they are
  // going to Newark, Manhattan or JFK. The deadhead is the job; the leg the
  // passenger rides is the short part. Pricing the columns apart would be
  // pricing a difference that isn't there.
  //
  // `nyPickup` makes the Suburban cost $50 more rather than $35, the same as
  // any other run that crosses the city — see SUV_FEE_NY.
  { town: 'Pelham',           names: ['pelham'],           ewr: 185, manh: 185, lgajfk: 185, nyPickup: true },
  { town: 'New Rochelle',     names: ['new rochelle'],     ewr: 185, manh: 185, lgajfk: 185, nyPickup: true },
  { town: 'Mount Vernon',     names: ['mount vernon'],     ewr: 185, manh: 185, lgajfk: 185, nyPickup: true },
  { town: 'Yonkers',          names: ['yonkers'],          ewr: 185, manh: 185, lgajfk: 185, nyPickup: true },
  // Thin once the deadhead north is counted - see the note in the pricing doc.
  { town: 'East Rutherford',  names: ['east rutherford'],  ewr: 90,  manh: 120, lgajfk: 170 },
  { town: 'Edison',           names: ['edison'],                                 ewr: 75,  manh: 130, lgajfk: 180 },
  { town: 'Far Hills',        names: ['far hills'],                              ewr: 115, manh: 165, lgajfk: 225 },
  { town: 'Flanders',         names: ['flanders'],                               ewr: 125, manh: 185, lgajfk: 235 },
  { town: 'Flemington',       names: ['flemington'],                             ewr: 130, manh: 190, lgajfk: 240 },
  { town: 'Florham Park',     names: ['florham park'],                           ewr: 80,  manh: 140, lgajfk: 190 },
  { town: 'Gillette',         names: ['gillette'],                               ewr: 85,  manh: 145, lgajfk: 195 },
  { town: 'Gladstone',        names: ['gladstone', 'gladestone'],                ewr: 130, manh: 190, lgajfk: 235 },
  { town: 'Green Brook',      names: ['green brook', 'greenbrook'],              ewr: 90,  manh: 150, lgajfk: 195 },
  { town: 'Green Village',    names: ['green village'],                          ewr: 95,  manh: 155, lgajfk: 200 },
  { town: 'Hillsborough',     names: ['hillsborough'],                           ewr: 120, manh: 180, lgajfk: 230 },
  { town: 'Hoboken',          names: ['hoboken'],                                ewr: 80,  manh: 140, lgajfk: 190 },
  { town: 'Jersey City',      names: ['jersey city'],                            ewr: 75,  manh: 125, lgajfk: 185 },
  { town: 'Lebanon',          names: ['lebanon'],                                ewr: 130, manh: 190, lgajfk: 240 },
  { town: 'Liberty Corner',   names: ['liberty corner'],                         ewr: 110, manh: 170, lgajfk: 215 },
  { town: 'Livingston',       names: ['livingston'],                             ewr: 80,  manh: 140, lgajfk: 190 },
  { town: 'Long Valley',      names: ['long valley'],                            ewr: 95,  manh: 155, lgajfk: 205 },
  { town: 'Madison',          names: ['madison'],                                ewr: 105, manh: 165, lgajfk: 215 },
  { town: 'Martinsville',     names: ['martinsville'],                           ewr: 115, manh: 175, lgajfk: 225 },
  { town: 'Meyersville',      names: ['meyersville'],                            ewr: 95,  manh: 145, lgajfk: 205 },
  { town: 'Mendham',          names: ['mendham'],                                ewr: 125, manh: 185, lgajfk: 235 },
  { town: 'Mountain Lakes',   names: ['mountain lakes'],                         ewr: 125, manh: 185, lgajfk: 235 },
  { town: 'Millburn',         names: ['millburn'],                               ewr: 75,  manh: 135, lgajfk: 185 },
  { town: 'Millington',       names: ['millington'],                             ewr: 95,  manh: 150, lgajfk: 200 },
  { town: 'Morristown',       names: ['morristown'],                             ewr: 100, manh: 160, lgajfk: 210 },
  // Added 18 Oct after a real booking the table could not price. It sits
  // between Parsippany ($85) and Morristown ($100) on the map and on the
  // clock, so it is priced between them.
  { town: 'Morris Plains',    names: ['morris plains'],                          ewr: 95,  manh: 155, lgajfk: 205 },
  { town: 'Mountainside',     names: ['mountainside'],                           ewr: 75,  manh: 135, lgajfk: 185 },
  { town: 'Murray Hill',      names: ['murray hill', 'murray hills'],            ewr: 75,  manh: 135, lgajfk: 185 },
  { town: 'New Brunswick',    names: ['new brunswick'],                          ewr: 95,  manh: 145, lgajfk: 205 },
  { town: 'New Providence',   names: ['new providence'],                         ewr: 75,  manh: 135, lgajfk: 185 },
  { town: 'New Vernon',       names: ['new vernon'],                             ewr: 95,  manh: 155, lgajfk: 205 },
  { town: 'Plainfield',       names: ['plainfield'],       ewr: 85,  manh: 145, lgajfk: 195 },
  { town: 'North Plainfield', names: ['north plainfield', 'n. plainfield'],      ewr: 85,  manh: 140, lgajfk: 190 },
  { town: 'Orange',           names: ['orange'],           ewr: 80,  manh: 140, lgajfk: 190 },
  { town: 'Oldwick',          names: ['oldwick'],                                ewr: 110, manh: 170, lgajfk: 220 },
  { town: 'Parsippany',       names: ['parsippany'],                             ewr: 85,  manh: 145, lgajfk: 195 },
  { town: 'Peapack',          names: ['peapack'],                                ewr: 130, manh: 190, lgajfk: 240 },
  { town: 'Phillipsburg',     names: ['phillipsburg', 'philipsburg'],            ewr: 180, manh: 240, lgajfk: 290 },
  { town: 'Piscataway',       names: ['piscataway'],                             ewr: 100, manh: 160, lgajfk: 210 },
  { town: 'Princeton',        names: ['princeton'],                              ewr: 155, manh: 215, lgajfk: 265 },
  // Parlin is a section of Sayreville, not a town of its own - same drive,
  // same price, and a customer who types their own address gets a number.
  { town: 'Sayreville',       names: ['sayreville', 'parlin'],                             ewr: 90,  manh: 150, lgajfk: 195 },
  { town: 'Scotch Plains',    names: ['scotch plains', 'scotch plain'],          ewr: 80,  manh: 140, lgajfk: 190 },
  { town: 'Seaside Heights',  names: ['seaside heights', 'seaside hghts'],       ewr: 185, manh: 245, lgajfk: 295 },
  { town: 'Short Hills',      names: ['short hills'],                            ewr: 85,  manh: 145, lgajfk: 195 },
  { town: 'South Bound Brook',names: ['south bound brook', 's. bound brook'],    ewr: 85,  manh: 145, lgajfk: 190 },
  { town: 'Springfield',      names: ['springfield'],                            ewr: 75,  manh: 135, lgajfk: 185 },
  { town: 'Somerville',       names: ['somerville'],                             ewr: 125, manh: 195, lgajfk: 235 },
  { town: 'South Plainfield', names: ['south plainfield', 's. plainfield'],      ewr: 85,  manh: 145, lgajfk: 195 },
  { town: 'Stirling',         names: ['stirling'],                               ewr: 90,  manh: 150, lgajfk: 200 },
  { town: 'Summit',           names: ['summit'],                                 ewr: 75,  manh: 135, lgajfk: 185 },
  { town: 'Trenton',          names: ['trenton'],                                ewr: 160, manh: 220, lgajfk: 270 },
  { town: 'Toms River',       names: ['toms river'],                             ewr: 175, manh: 235, lgajfk: 285 },
  // Settled 10 October at the SAME rate as Union, because it is the same
  // drive - it went onto the printed cards that week and was never added
  // here, so the website refused to price a town the cards quote. Linden
  // and Rahway are the same stretch and will be asked for next.
  //
  // KNOWN SIDE EFFECT: 'Roselle Park, NJ' now matches this row, because the
  // qualifier guard in findTown only looks at the word IN FRONT. Roselle
  // Park is its own borough but it is next door and the same drive to every
  // destination on the card, so $75/$135/$185 is the right answer rather than
  // a lucky one. Give it a row of its own the day the two prices differ.
  { town: 'Roselle',          names: ['roselle'],                                ewr: 75,  manh: 135, lgajfk: 185 },
  { town: 'Union',            names: ['union'],                                  ewr: 75,  manh: 135, lgajfk: 185 },
  { town: 'Warren',           names: ['warren'],                                 ewr: 95,  manh: 155, lgajfk: 205 },
  { town: 'Watchung',         names: ['watchung'],                               ewr: 90,  manh: 150, lgajfk: 200 },
  { town: 'West Orange',      names: ['west orange', 'w. orange'],               ewr: 85,  manh: 145, lgajfk: 195 },
  { town: 'Westfield',        names: ['westfield'],                              ewr: 85,  manh: 145, lgajfk: 195 },
  { town: 'Whippany',         names: ['whippany'],                               ewr: 85,  manh: 145, lgajfk: 195 },
  { town: 'Whitehouse',       names: ['whitehouse station', 'whitehouse'],       ewr: 145, manh: 205, lgajfk: 255 },
  { town: 'Woodbridge',       names: ['woodbridge'],                             ewr: 90,  manh: 150, lgajfk: 200 },
];

// Requested pickup time falls between 12:00 AM and 5:59 AM -> overnight.
// dateTimeLocal is the raw value of an <input type="datetime-local">, already
// the customer's own wall-clock time, so no timezone conversion here.
function isOvernightPickup(dateTimeLocal) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(dateTimeLocal || '');
  if (!m) return false;
  const hour = Number(m[4]);
  return hour >= 0 && hour < 6;
}

// Longest match wins. "New Providence, Union County" must not price as Union,
// and "South Bound Brook" must not price as Bound Brook.
// ---- READING AN ADDRESS -------------------------------------------------
//
// THE BUG THIS EXISTS TO PREVENT (found by audit, 2026-09-18): the old code
// scanned the WHOLE address string for a town name. In New Jersey, street
// names ARE town names, so:
//
//   "123 Madison Ave, Lakewood, NJ"  ->  priced as Madison, $105
//                                        Lakewood is 55 miles away
//   "45 Summit Ave, Hackensack, NJ"  ->  priced as Summit, $75
//   "9 Westfield Ave, Elizabeth, NJ" ->  priced as Westfield, $85
//   "10 Manhattan Ave, Union, NJ"    ->  priced as a MANHATTAN run, $135,
//                                        for a six-mile local hop
//   "Cranford, Union County, NJ"     ->  priced as Union, off the COUNTY name
//
// Every one of those is a wrong price on a real booking, in both directions,
// with nothing in the sheet looking odd afterwards.
//
// The fix: only ever look at the parts of an address that name a PLACE.
// Google formats addresses as comma-separated parts —
// "24 Gales Dr, New Providence, NJ 07974, USA" — so the street is the first
// part, and it goes in the bin along with the state, the ZIP, the country and
// anything ending in "County".

const QUALIFIERS = ['east', 'west', 'north', 'south', 'new', 'old', 'upper',
                    'lower', 'port', 'mount', 'mt', 'glen', 'little', 'big'];

// Deliberately NOT including "New York": that is how Google labels a
// Manhattan address ("350 5th Ave, New York, NY 10118"), and treating it as a
// state name threw the whole Manhattan destination away. The state itself
// always shows up as the two-letter "NY" in a formatted address.
const STATES = /^(nj|ny|pa|ct|de|md|new jersey|pennsylvania|connecticut|delaware|maryland)\b/i;

// The parts of an address that could name a town. Everything else is dropped.
function placeParts(text) {
  const raw = String(text || '').split(',').map((p) => p.trim()).filter(Boolean);
  if (!raw.length) return [];

  const kept = raw.filter((part) => {
    if (/^(usa|united states|us)$/i.test(part)) return false;
    if (/\bcounty\b/i.test(part)) return false;          // "Union County"
    if (STATES.test(part)) return false;                  // "NJ 07974", "New York"
    if (/^\d{5}(-\d{4})?$/.test(part)) return false;      // a bare ZIP
    return true;
  });

  // Street lines, dropped by shape rather than by position: a leading house
  // number, a unit, or a street-type word. "JFK Blvd" and "Springfield Ave"
  // are streets as surely as "24 Gales Dr" is, and each one would otherwise
  // be read as a place. Only dropped while something else survives — a bare
  // "Summit" typed on its own has to keep working.
  const street = /^\d|\b(apt|suite|ste|unit|floor|fl)\b|\b(st|street|ave|avenue|blvd|boulevard|rd|road|dr|drive|ln|lane|way|pkwy|parkway|ct|court|pl|place|ter|terrace|hwy|highway|cir|circle|trl|trail)\.?$/i;
  const places = kept.filter((part) => !street.test(part));
  return places.length ? places : kept;
}

// THE NAME OF A PLACE WE DO NOT HAVE A PRICE FOR.
//
// "Other" was the zone on every ride that was not an airport run or a local
// hop - Ahmed's New Providence to Neptune City run among them - and it is the
// one zone that tells him nothing. He gets a lot of these. Grouping them all
// under one label makes the revenue split by zone useless exactly where it
// would be most interesting: the routes outside the rate card.
//
// placeParts has already thrown away the state, the ZIP, the county and the
// street line, so what is left is the town. The LAST of them is the most
// town-like - "Shop Rite, Neptune City" names the shop first.
//
// Nothing here invents a price. The price is still whatever Ahmed agreed; this
// only gives the row a name he can add up by.
function placeName(text) {
  const parts = placeParts(text);
  if (!parts.length) return null;
  const name = parts[parts.length - 1].trim();
  if (!name || name.length > 40) return null;
  // Title-case it so "neptune city" typed in a hurry groups with "Neptune
  // City" typed properly - a zone that splits on capitals is two zones.
  return name.replace(/\s+/g, ' ')
             .replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
}

function findTown(text) {
  const parts = placeParts(text);
  if (!parts.length) return null;

  // every spelling of every town, so a qualified pair can be checked for
  const known = new Set();
  for (const row of TOWN_FARES) for (const n of row.names) known.add(n);

  let best = null, bestLen = 0;

  for (const part of parts) {
    const hay = ` ${part.toLowerCase().replace(/\s+/g, ' ')} `;
    for (const row of TOWN_FARES) {
      for (const name of row.names) {
        let from = 0, idx;
        while ((idx = hay.indexOf(name, from)) !== -1) {
          from = idx + 1;
          const before = hay[idx - 1] || ' ';
          const after = hay[idx + name.length] || ' ';
          if (/[a-z]/.test(before) || /[a-z]/.test(after)) continue;  // mid-word
          if (name.length <= bestLen) continue;

          // "East Orange" must not be priced as "Orange". West Orange and
          // North Plainfield have rows of their own, so they survive this
          // and win on length.
          const lead = hay.slice(0, idx).trim().split(' ').pop().replace(/[^a-z]/g, '');
          if (QUALIFIERS.includes(lead) && !known.has(`${lead} ${name}`)) continue;

          best = row; bestLen = name.length;
        }
      }
    }
  }
  return best;
}

function findDestination(text) {
  // Street names carry airport names too: "100 JFK Blvd, Jersey City" is a
  // Jersey City address, not a JFK run, and "10 Manhattan Ave, Union" is a
  // local hop. Same filtering as findTown, for the same reason.
  const parts = placeParts(text);
  if (!parts.length) return null;
  for (const dest of DESTINATIONS) {
    if (parts.some((part) => dest.test.test(part))) return dest;
  }
  return null;
}


// A route with no listed price still has a destination most of the time — it
// is the TOWN that's missing, not the airport. Carrying the zone through means
// a hand-quoted JFK run still counts as JFK at year-end instead of landing in
// "Other" and quietly understating what the airports earn.
function noMatch(overnight, note, zone) {
  return {
    matched: false,
    label: null,
    zone: zone || 'Other',
    newYork: false,
    fare: null,
    toll: null,
    tollEstimated: false,
    cardFee: null,
    cardFeeLabel: null,
    cardFeeRate: null,
    rideFare: null,
    total: null,
    totalDisplay: '',
    tipSuggested: null,
    display: note,
  };
}

// pickup/dropoff pick the route, vehicle decides the SUV surcharge, dateTime
// decides the overnight fee, and payMethod decides the card fee added on top.
// Builds the result for a price settled by hand. Used wherever an agreed fare
// is given, because the routes you most often agree by phone are precisely the
// ones with no listed price — so it has to work when the town is unknown, not
// only when it is known.
// ---- THE CARD FEE COVERS THE TIP TOO, WHEN THE TIP IS KNOWN ----
//
// Ahmed's instruction, 30 October: "Square takes his percentage from the
// total so you add the card fee on the total." He is right about the
// mechanics - Square's cut is taken from the whole amount swiped, tip
// included - so a fee worked out on fare and tolls alone leaves his own
// money covering Square's cut of the gratuity.
//
// But a tip that has not been left yet cannot be charged a fee. So `tip` is
// an OVERRIDE, not an assumption: the booking page quotes fare and tolls as
// it always did, because at that moment the customer has decided nothing,
// and the dispatch passes the real figure once there is one. Give it a tip
// and the fee covers the tip; give it none and nothing changes.
function agreedResult(agreed, toll, payMethod, label, setCard, zone, tip) {
  const rideFare = agreed + toll;
  const auto = cardFeeFor(payMethod, rideFare + (tip || 0));
  // A hand-set card fee wins, including a deliberate zero — waiving it is a
  // real decision and has to be expressible.
  const cardAmount = setCard !== null && setCard !== undefined ? setCard : (auto ? auto.amount : null);
  const total = Math.round((rideFare + (cardAmount || 0)) * 100) / 100;

  const bits = [`$${agreed} fare`];
  if (toll) bits.push(`$${toll} tolls`);
  if (cardAmount) bits.push(`$${cardAmount.toFixed(2)} ${auto ? auto.label : 'card'} fee`);

  return {
    matched: true, label: label || 'Agreed by phone', zone: zone || 'Other', newYork: false,
    agreedFare: agreed, fare: agreed,
    toll: toll || null, tollEstimated: Boolean(toll),
    cardFee: cardAmount,
    cardFeeLabel: cardAmount ? (auto ? auto.label : 'Card') : null,
    cardFeeRate: cardAmount && auto ? `${(auto.rate * 100).toFixed(1)}% + $${auto.fixed.toFixed(2)}` : null,
    rideFare, total,
    totalDisplay: `$${total.toFixed(2).replace(/\.00$/, '')}`,
    tipSuggested: Math.round(agreed * 0.2),
    display: `$${total.toFixed(2).replace(/\.00$/, '')} flat (${bits.join(' + ')})`,
    driverDisplay: `$${total.toFixed(2).replace(/\.00$/, '')} flat (${bits.join(' + ')})`,
  };
}

// `agreedFare` overrides the DRIVING charge — base, vehicle fee and overnight
// all together — for a price settled on the phone. It does not override the
// toll or the card fee, because those are pass-throughs: the bridge and Square
// charge what they charge whatever was agreed. They are added on top and shown
// separately, so the number Ahmed typed stays visible as the number he typed.
// `overrides` lets a person replace ANY line of the bill, not just the total:
//   { fare, toll, cardFee }
// Each is optional. Whatever is left out is calculated as normal, so changing
// the toll alone leaves the rate card in charge of the fare, and waiving the
// card fee leaves everything else untouched.
//
// This started life as a single "agreed fare" number. That was not enough:
// Ahmed's real tolls differ from the table, customers get the card fee waived,
// and a price settled on the phone still needs the toll on top. A plain number
// is still accepted and means { fare }.
// A job charged BY THE HOUR rather than A to B. It is priced before the route
// is even looked at, because the route is not what is being sold: an evening
// held open, several stops, a driver waiting. No minimum, and the rate now
// depends on the car - see HOURLY_RATE_SUV above.
//
// ONE THING THIS DOES NOT HANDLE, and it has to be said out loud on the phone:
// a job that ENDS somewhere far away. The hourly rate assumes the car comes
// back. Hold the car all day and finish in Philadelphia and there are two hours
// of driving home with nobody paying for it - which is the whole reason the
// Philadelphia flat fare is $300 rather than four hours of hourly. On those,
// run the clock from leaving New Providence to getting back to New Providence,
// and put it in as an agreed fare rather than through this function.
//
// The tolls still apply if one end is New York — the bridge does not care how
// the fare was worked out — so the destination is still read, only for that.
function hourlyResult(hours, dest, payMethod, setCard, tip, rate) {
  const hourly = rate || HOURLY_RATE_SUV;
  const driving = Math.round(hourly * hours * 100) / 100;
  const toll = dest ? ((TOLLS[dest.key] || {}).standard || 0) : 0;
  const rideFare = driving + toll;
  const auto = cardFeeFor(payMethod, rideFare + (tip || 0));
  const cardAmount = (setCard !== null && setCard !== undefined) ? setCard : (auto ? auto.amount : null);
  const total = Math.round((rideFare + (cardAmount || 0)) * 100) / 100;

  const money = (n) => `$${Number(n).toFixed(2).replace(/\.00$/, '')}`;
  const bits = [`${money(driving)} fare`];
  if (toll) bits.push(`${money(toll)} tolls`);
  if (cardAmount) bits.push(`${money(cardAmount)} ${auto ? auto.label : 'card'} fee`);
  const shown = `${money(total)} flat (${bits.join(' + ')})`;

  const hoursLabel = `${hours} hour${hours === 1 ? '' : 's'} at $${hourly}/hr`;

  return {
    matched: true,
    label: `Hourly — ${hoursLabel}`,
    zone: 'Hourly',
    newYork: Boolean(dest && dest.ny),
    agreedFare: null,
    hours,
    hourlyAmount: driving,
    fare: driving,
    toll: toll || null,
    tollEstimated: Boolean(toll),
    cardFee: cardAmount,
    cardFeeLabel: cardAmount ? (auto ? auto.label : 'Card') : null,
    cardFeeRate: cardAmount && auto ? `${(auto.rate * 100).toFixed(1)}% + $${auto.fixed.toFixed(2)}` : null,
    rideFare,
    total,
    totalDisplay: money(total),
    tipSuggested: Math.round(driving * 0.2),
    display: shown,
    driverDisplay: shown,
  };
}

function priceRide(pickup, dropoff, vehicle, dateTime, payMethod, overrides) {
  const ov = (typeof overrides === 'object' && overrides !== null) ? overrides : { fare: overrides };
  const setFare = numOrNull(ov.fare);
  const setToll = numOrNull(ov.toll);
  const setCard = numOrNull(ov.cardFee);
  // Only set once a real tip exists - see the note above agreedResult.
  const setTip = numOrNull(ov.tip);
  const stopCharge = stopsCharge(ov.stops, pickup);
  const stops = stopCharge.count;
  const stopFee = stopCharge.fee;
  const anySet = setFare !== null || setToll !== null || setCard !== null;
  const agreed = setFare;
  const isSedan = pricesAsSedan(vehicle);
  const overnight = isOvernightPickup(dateTime) ? OVERNIGHT_FEE : 0;

  const overnightNote = overnight ? ` + $${overnight} overnight` : '';
  // A STOP SOMEWHERE WE DO NOT PRICE IS A FARE WE DO NOT PRICE.
  //
  // Ahmed's instruction: "if not listed just make same as we do if the fare
  // not listed." Guessing $10 for a detour to a town that is not on the card
  // would be inventing a number, and the same detour might be five minutes or
  // an hour. So the quote stops and says so, exactly as it does for an unknown
  // route - unless a price has already been agreed by hand, in which case his
  // number stands and the stop is inside it.
  if (stopCharge.unlisted.length && !anySet) {
    return noMatch(overnight,
      `${stopCharge.unlisted.join(' and ')} ${stopCharge.unlisted.length === 1 ? 'is' : 'are'} ` +
      `not on the rate card, so this one is priced by hand.${overnightNote}`);
  }

  const destAtPickup = findDestination(pickup);
  const destAtDropoff = findDestination(dropoff);

  // Hourly wins over the rate card. Somebody who has booked three hours is not
  // buying a trip to an airport even if the airport is one of the stops.
  const hours = numOrNull(ov.hours);
  if (hours && hours > 0 && setFare === null) {
    return hourlyResult(hours, destAtDropoff || destAtPickup, payMethod, setCard, setTip,
                        hourlyRateFor(vehicle));
  }

  // Exactly one end should be an airport or Manhattan. Both ends being
  // destinations (EWR to JFK) isn't in the table and gets quoted by hand.
  let dest = null;
  let townSide = null;
  if (destAtDropoff && !destAtPickup) { dest = destAtDropoff; townSide = pickup; }
  else if (destAtPickup && !destAtDropoff) { dest = destAtPickup; townSide = dropoff; }

  if (dest) {
    const tollFor = TOLLS[dest.key] || { standard: 0, overnight: 0 };
    const destToll = overnight ? tollFor.overnight : tollFor.standard;

    const town = findTown(townSide);
    if (!town) {
      // No listed price — but if one was agreed on the phone, that IS the
      // price, and the toll for this destination still applies.
      if (anySet) return agreedResult(agreed !== null ? agreed : 0, setToll !== null ? setToll : destToll, payMethod, `Agreed — ${dest.label}`, setCard, dest.zone, setTip);
      return noMatch(overnight, `${dest.label} — no listed price for that town. Quote it by hand, then tell Claude the number and it gets added.${overnightNote}`, dest.zone);
    }

    // One driving charge, not a stack of fees.
    //
    // Ahmed's decision, 2026-09-18: the customer, the driver and the sheet all
    // see the same four numbers — fare, tolls, card fee, total. The SUV
    // surcharge and the overnight charge are added here and never shown apart.
    //
    // A $35 city premium was added to every Manhattan, LaGuardia and JFK price
    // earlier the same day and taken back out again the same evening, at
    // Ahmed's call. The prices below are the originals. Nothing else changed
    // with it: the premium only ever lived in this table, which is exactly why
    // reversing it was one edit and not a hunt through five files. The reason is that a number living in two places is a
    // number that can disagree with itself: the old sedan New York fee sat in
    // the code AND in the table, and New York sedan trips were billed twice
    // for weeks before anyone noticed. Tolls and the card fee stay on their
    // own lines because Ahmed does not set them — those are pass-throughs.
    const base = town[dest.key];
    // EITHER END IN NEW YORK, not just the destination.
    //
    // The bigger Suburban surcharge is there because the run crosses the city
    // and its bridges. A Pelham pickup heading to Newark crosses exactly the
    // same ground as a Newark pickup heading to Pelham, so reading only the
    // destination charged the Westchester towns $35 for a $50 drive.
    const crossesNY = dest.ny || town.nyPickup;
    const vehicleFee = isSedan ? 0 : (crossesNY ? SUV_FEE_NY : SUV_FEE);

    const toll = destToll;

    if (anySet) return agreedResult(agreed !== null ? agreed : (base + vehicleFee + overnight), setToll !== null ? setToll : toll, payMethod, `Agreed — ${town.town} to ${dest.label}`, setCard, dest.zone, setTip);
    const driving = base + vehicleFee + overnight + stopFee;

    // The card fee is worked out on everything going through the card,
    // INCLUDING the toll — Square takes its percentage of the whole amount
    // swiped, so leaving the toll out would quietly under-recover the fee.
    const rideFare = driving + toll;
    const card = cardFeeFor(payMethod, rideFare + (setTip || 0));
    const total = Math.round((rideFare + (card ? card.amount : 0)) * 100) / 100;

    // The tip is on the DRIVING, not on the toll and not on the processor's
    // cut. Nobody tips twenty per cent of a bridge.
    const tippable = driving;

    const parts = [`$${driving} fare`];
    if (toll) parts.push(`$${toll} tolls`);
    if (card) parts.push(`$${card.amount.toFixed(2)} ${card.label} fee`);
    // Said out loud on the bill. A fare that is $30 higher than the rate card
    // with nothing explaining why is the kind of thing a customer queries.
    const stopNote = stops ? `includes $${stopFee} for ${stops} stop${stops === 1 ? '' : 's'}` : '';

    return {
      matched: true,
      label: `${town.town} — ${dest.label}`,
      zone: dest.zone,
      newYork: Boolean(dest.ny),
      agreedFare: agreed,
      fare: driving,
      stops,
      stopFee: stopFee || null,
      toll: toll || null,
      tollEstimated: Boolean(toll),
      cardFee: card ? card.amount : null,
      cardFeeLabel: card ? card.label : null,
      cardFeeRate: card ? `${(card.rate * 100).toFixed(1)}% + $${card.fixed.toFixed(2)}` : null,
      rideFare,
      total,
      totalDisplay: `$${total.toFixed(2).replace(/\.00$/, '')}`,
      tipSuggested: Math.round(tippable * 0.2),
      display: `$${total.toFixed(2).replace(/\.00$/, '')} flat (${parts.join(' + ')})${stopNote ? `, ${stopNote}` : ''}`,
      driverDisplay: `$${total.toFixed(2).replace(/\.00$/, '')} flat (${parts.join(' + ')})${stopNote ? `, ${stopNote}` : ''}`,
    };
  }

  // No airport or Manhattan involved. Both ends listed towns -> local rate.
  const townA = findTown(pickup);
  const townB = findTown(dropoff);
  if (townA && townB && anySet) {
    return agreedResult(agreed !== null ? agreed : 0, setToll !== null ? setToll : 0, payMethod,
                        `Agreed — ${townA.town} to ${townB.town}`, setCard, 'Local', setTip);
  }
  if (townA && townB) {
    const [loBase, hiBase] = LOCAL_RANGE;
    const lo = loBase + stopFee;
    const hi = hiBase + stopFee;
    return {
      matched: true,
      label: `Local — ${townA.town} to ${townB.town}`,
      zone: 'Local',
      newYork: false,
      // A range, not a number — the overnight charge is inside the figures
      // below rather than on a line of its own.
      fare: null,
      toll: LOCAL_TOLL || null,
      tollEstimated: false,
      // A range has no single number to take a percentage of, so the card fee
      // is worked out once the exact fare is agreed.
      cardFee: null,
      cardFeeLabel: null,
      cardFeeRate: null,
      rideFare: null,
      total: null,
      totalDisplay: `$${lo + overnight}–${hi + overnight} flat (all-inclusive)`,
      tipSuggested: Math.round((((lo + hi) / 2) + overnight) * 0.2),
      display: `$${lo + overnight}–${hi + overnight} flat (local, all-inclusive, either vehicle${overnight ? `, includes $${overnight} overnight` : ''})`,
    };
  }

  // Nothing matched at all, but a price was agreed — no destination, so no
  // toll to add.
  //
  // The zone is the end we have NO price for, because that is the thing worth
  // counting. Neptune City to New Providence filed under "New Providence"
  // would hide the shore run inside a town we already serve.
  const fromName = placeName(pickup);
  const toName = placeName(dropoff);
  const offCard = (!townA && fromName) ? fromName : (!townB && toName) ? toName : null;
  const zoneName = offCard || toName || fromName || 'Other';
  const routeLabel = (fromName && toName)
    ? `Agreed — ${fromName} to ${toName}`
    : 'Agreed by phone';

  if (anySet) return agreedResult(agreed !== null ? agreed : 0, setToll !== null ? setToll : 0, payMethod, routeLabel, setCard, zoneName, setTip);

  return noMatch(overnight, `No listed price for this route. Quote it by hand, or $${hourlyRateFor(vehicle)}/hr (no minimum) if it isn't a straight A-to-B trip.${overnightNote}`, zoneName);
}

// ---- DISCOUNTS ----
//
// A discount comes off the DRIVING charge and off nothing else. Two rules
// decide that, and both are about money actually moving:
//
//   The toll is never discounted. The bridge charges what the bridge charges,
//   and knocking money off it means Ahmed pays the difference to the Port
//   Authority out of his own pocket rather than giving the customer a gift.
//
//   The card fee is worked out AFTER the discount, never before. Square takes
//   its percentage of what is actually swiped, so a $20 discount has to shrink
//   the fee too. Discounting after the fee would have him handing a processor
//   a cut of money he never collected.
//
// The discount can never be larger than the driving charge — a $50 credit on a
// $35 local run takes the fare to zero and stops there. The leftover stays on
// the customer's balance for next time rather than turning into cash.
//
// Two versions of the breakdown come back. `display` says the discount out
// loud, and that one is for Ahmed. `driverDisplay` folds it silently into the
// fare, and that is the one the driver and the calendar see, because a driver
// reading "$15 discount" next to a number he has to collect is a question he
// should never have to ask.
function applyDiscount(result, discountRaw, payMethod, setCard, tip) {
  const asked = numOrNull(discountRaw);
  if (!asked) return result;

  // A local range or an unmatched route has no single number to take money
  // off. Record what was asked for so nothing is silently lost, and let the
  // price get settled first.
  if (typeof result.rideFare !== 'number' || !isFinite(result.rideFare)) {
    return Object.assign({}, result, {
      discount: asked,
      discountApplied: 0,
      discountNote: 'Settle the fare first — a discount needs a number to come off.',
    });
  }

  const toll = result.toll || 0;
  const driving = Math.round((result.rideFare - toll) * 100) / 100;
  const applied = Math.round(Math.min(asked, Math.max(0, driving)) * 100) / 100;
  const unused = Math.round((asked - applied) * 100) / 100;

  const newDriving = Math.round((driving - applied) * 100) / 100;
  const rideFare = Math.round((newDriving + toll) * 100) / 100;

  const auto = cardFeeFor(payMethod, rideFare + (tip || 0));
  // A hand-set card fee survives the discount. Waiving the fee is a separate
  // decision and the discount has no business undoing it.
  const cardAmount = (setCard !== null && setCard !== undefined)
    ? setCard
    : (auto ? auto.amount : null);
  const total = Math.round((rideFare + (cardAmount || 0)) * 100) / 100;

  const money = (n) => `$${Number(n).toFixed(2).replace(/\.00$/, '')}`;
  const tail = [];
  if (toll) tail.push(`${money(toll)} tolls`);
  if (cardAmount) tail.push(`${money(cardAmount)} ${result.cardFeeLabel || (auto ? auto.label : 'card')} fee`);

  const openWith = `${money(driving)} fare − ${money(applied)} discount`;
  const quietly = `${money(newDriving)} fare`;

  return Object.assign({}, result, {
    discount: asked,
    discountApplied: applied,
    discountUnused: unused || 0,
    discountNote: unused
      ? `${money(unused)} of the credit is more than the fare — it stays on their balance.`
      : null,
    fareBeforeDiscount: driving,
    fare: newDriving,
    rideFare,
    cardFee: cardAmount,
    cardFeeLabel: cardAmount ? (result.cardFeeLabel || (auto ? auto.label : 'Card')) : null,
    cardFeeRate: cardAmount && auto ? `${(auto.rate * 100).toFixed(1)}% + $${auto.fixed.toFixed(2)}` : result.cardFeeRate,
    total,
    totalDisplay: `${money(total)} flat`,
    // The tip follows what they actually pay for the driving, not what it
    // would have been. Nobody tips on a discount they were given.
    tipSuggested: Math.round(newDriving * 0.2),
    display: `${money(total)} flat (${[openWith].concat(tail).join(' + ')})`,
    driverDisplay: `${money(total)} flat (${[quietly].concat(tail).join(' + ')})`,
  });
}

// The public estimator. It prices the ride exactly as it always has, then
// takes the discount off the answer.
function estimateFare(pickup, dropoff, vehicle, dateTime, payMethod, overrides) {
  const ov = (typeof overrides === 'object' && overrides !== null) ? overrides : { fare: overrides };
  const priced = priceRide(pickup, dropoff, vehicle, dateTime, payMethod, ov);
  // Anything that never had a discount still needs driverDisplay, or the
  // calendar has nothing to print.
  const base = Object.assign({ discount: 0, discountApplied: 0, driverDisplay: priced.display }, priced);
  return applyDiscount(base, ov.discount, payMethod, numOrNull(ov.cardFee), numOrNull(ov.tip));
}

// ---- A ROUND TRIP IS ONE RIDE ----
//
// Ahmed's instruction, 4 November: "when i make a new ride has round trip or
// some one through the website i want them to be one ride in the dispatch one
// ride in the sheet." It used to be two of everything - two sheet rows, two
// ride cards, two Completed buttons - on the reasoning that each leg is a
// separate journey on the road. One row is what he actually wants to look at,
// and collapsing it fixes four things two rows got wrong:
//
//   * TWO CARD FEES. Each leg paid its own 15c fixed charge, so one swipe was
//     billed 30c of fixed fee. One job, one fee.
//   * THE DISCOUNT CAP WAS PER LEG. A $50 credit against a $35 outbound took
//     $35 and left $15 stranded as "unused" while the return leg sat there
//     with fare to spend it on. The credit now meets the whole job.
//   * THE TIP WAS ROUNDED TWICE. 20% of each leg separately.
//   * AN UNPRICED RETURN LEG CAME BACK AS $0. The old second row was priced
//     with { toll: 0 }, and a toll override is enough to make priceRide take
//     the agreed-fare path - which, with no agreed fare and no listed price
//     for the town, returns a fare of ZERO and calls it matched. A round trip
//     to a town that isn't on the rate card quietly charged for one leg. This
//     function never overrides the toll, so `matched` stays truthful.
//
// WHAT IS STILL CHARGED ONCE: the toll, and the $10 first ride. `fare` is the
// driving charge with the toll already excluded, so the two legs are simply
// added and the toll is taken from the legs rather than from an override.
//
// THE TOLL IS THE LARGER OF THE TWO, not the outbound's. On the ordinary
// there-and-back they are the same number. When the return starts somewhere
// else - out to JFK, home from Manhattan - the job still crosses the bigger
// crossing, and billing the smaller one would have Ahmed paying the Port
// Authority the difference himself.
//
// AN AGREED FARE COVERS THE WHOLE JOB. A number typed into Agreed fare, a
// typed-over toll or a typed-over card fee is a statement about this booking,
// not about its first half, so the return leg is not priced and nothing is
// added on top. Pricing leg two over an agreed number would bill twice for a
// figure Ahmed said out loud on the phone.
function roundTripFare(pickup, dropoff, vehicle, dateTime, payMethod, overrides, ret) {
  const ov = (typeof overrides === 'object' && overrides !== null) ? overrides : { fare: overrides };
  const when = ret && String(ret.returnDateTime || '').trim();
  if (!when) return estimateFare(pickup, dropoff, vehicle, dateTime, payMethod, ov);

  const bPick = String((ret && ret.returnPickup) || '').trim() || dropoff;
  const bDrop = String((ret && ret.returnDropoff) || '').trim() || pickup;
  const leg = { from: bPick, to: bDrop, dateTime: when };

  const setFare = numOrNull(ov.fare);
  const setToll = numOrNull(ov.toll);
  const setCard = numOrNull(ov.cardFee);
  const setTip = numOrNull(ov.tip);

  if (setFare !== null || setToll !== null || setCard !== null) {
    const one = estimateFare(pickup, dropoff, vehicle, dateTime, payMethod, ov);
    return Object.assign({}, one, { roundTrip: true, returnLeg: leg });
  }

  // The outbound is priced WITHOUT the discount: the discount belongs to the
  // job and has to be capped against both legs together, so applyDiscount puts
  // it on at the end - exactly the shape estimateFare itself uses.
  const out = estimateFare(pickup, dropoff, vehicle, dateTime, payMethod,
                           Object.assign({}, ov, { discount: 0 }));
  const back = estimateFare(bPick, bDrop, vehicle, when, payMethod, {});

  // Either leg unpriced means the JOB is unpriced. A half-priced round trip is
  // not a quote, and saying so is what matched:false is for.
  const priced = (r) => r && r.matched && typeof r.fare === 'number' && isFinite(r.fare);
  if (!priced(out) || !priced(back)) {
    const which = !priced(out) ? 'the way out' : 'the way back';
    return {
      matched: false,
      roundTrip: true,
      returnLeg: leg,
      label: null,
      zone: (out && out.zone) || (back && back.zone) || null,
      agreedFare: null,
      fare: null,
      toll: null,
      cardFee: null,
      rideFare: null,
      total: null,
      totalDisplay: null,
      tipSuggested: null,
      discount: 0,
      discountApplied: 0,
      display: `Round trip — ${which} has no listed price. Quote the pair by hand, then tell Claude the number and it gets added.`,
      driverDisplay: 'Round trip — priced by hand.',
    };
  }

  const money = (n) => `$${Number(n).toFixed(2).replace(/\.00$/, '')}`;
  const driving = Math.round((out.fare + back.fare) * 100) / 100;
  const toll = Math.max(out.toll || 0, back.toll || 0);
  const rideFare = Math.round((driving + toll) * 100) / 100;
  const auto = cardFeeFor(payMethod, rideFare + (setTip || 0));
  const cardAmount = auto ? auto.amount : null;
  const total = Math.round((rideFare + (cardAmount || 0)) * 100) / 100;

  const parts = [`${money(driving)} fare, there and back`];
  if (toll) parts.push(`${money(toll)} tolls`);
  if (cardAmount) parts.push(`${money(cardAmount)} ${auto.label} fee`);
  const shown = `${money(total)} flat (${parts.join(' + ')})`;

  const merged = {
    matched: true,
    roundTrip: true,
    returnLeg: leg,
    outboundFare: out.fare,
    returnFare: back.fare,
    label: `${out.label} — round trip`,
    zone: out.zone,
    newYork: Boolean(out.newYork || back.newYork),
    agreedFare: null,
    fare: driving,
    stops: out.stops,
    stopFee: out.stopFee,
    toll: toll || null,
    tollEstimated: Boolean(toll),
    cardFee: cardAmount,
    cardFeeLabel: auto ? auto.label : null,
    cardFeeRate: auto ? `${(auto.rate * 100).toFixed(1)}% + $${auto.fixed.toFixed(2)}` : null,
    rideFare,
    total,
    totalDisplay: money(total),
    tipSuggested: Math.round(driving * 0.2),
    display: shown,
    driverDisplay: shown,
    discount: 0,
    discountApplied: 0,
    hourlyAmount: out.hourlyAmount || 0,
    hours: out.hours || 0,
  };

  return applyDiscount(merged, ov.discount, payMethod, null, setTip);
}

module.exports = {
  estimateFare,
  roundTripFare,
  isOvernightPickup,
  findTown,
  findDestination,
  placeParts,
  TOWN_FARES,
  DESTINATIONS,
  LOCAL_RANGE,
  HOURLY_RATE,
  HOURLY_RATE_SUV,
  HOURLY_RATE_SEDAN,
  hourlyRateFor,
  HOURLY_MINIMUM_HOURS,
  SUV_FEE,
  SUV_FEE_NY,
  pricesAsSedan,
  OVERNIGHT_FEE,
  TOLLS,
};
