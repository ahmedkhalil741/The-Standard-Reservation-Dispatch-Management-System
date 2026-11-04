// The loyalty rules, in one place.
//
// Ahmed's specification, 2026-09-18. The whole thing rests on one idea that
// did not exist in this codebase before: a ride can be COMPLETED. Until now
// every count happened the moment somebody booked, so a cancellation, a
// no-show and a finished airport run were identical to the code. Points are
// awarded when a ride is marked Completed on the dispatch page — never at
// booking time.
//
// ---- THE LADDER ----
//   New       first booking, no completed ride yet. 0 points.
//   Regular   1–9 points. One completed ride, one point.
//   Loyal ⭐  10 points. Never expires, never demotes.
//
// Cancelled, declined, refunded and no-show rides earn nothing.
// Points never expire and are never spent — see the note on credits below.
//
// ---- ACTIVITY IS SEPARATE FROM STATUS ----
// A Loyal customer who hasn't ridden in a year is still Loyal and still has
// every point. Activity only answers "have they been in the car lately":
// Active within 90 days of their last completed ride, Inactive after that,
// and back to Active the moment they complete another.
//
// ---- WHY POINTS AND CREDITS ARE TWO DIFFERENT THINGS ----
// If redeeming a reward subtracted points, the customer's history would go
// backwards and they could lose Loyal status by using it. So lifetime_points
// only ever goes up, and credit_owed is a separate running balance. John
// reaches 10 rides: 10 points, Loyal, $15 credit. He spends the $15. He still
// has 10 points and is still Loyal, and at 20 he earns another $15.
//
// ---- OFFERS ARE NOT SENT AUTOMATICALLY ----
// Ahmed's decision: the system works out what has been earned and tells him.
// He sends it. No money leaves on its own while the programme is this young.

const LOYAL_POINTS = 10;      // points that earn the star
const ACTIVITY_DAYS = 90;     // completed ride within this many days = Active

const STATUS_NEW = 'New';
const STATUS_REGULAR = 'Regular';
const STATUS_LOYAL = 'Loyal';

const ACTIVE = 'Active';
const INACTIVE = 'Inactive';

// What a completed ride earns. Ahmed's settings, 2026-09-18.
// Taken off the FIRST ride at booking, not earned on it. The flyers, the
// business cards and the car magnets have always said "$10 first ride", and
// a promise printed on paper is the one the business has to keep. So a phone
// number we have never driven books ten dollars cheaper, and creditEarned
// below no longer grants anything for ride one — otherwise the same person
// gets ten off ride one and ten more on ride two, which is twenty for a
// promise of ten.
const FIRST_RIDE_CREDIT = 10;   // off their first ride, applied at booking
const LOYALTY_CREDIT = 15;      // once, on reaching Loyal at 10 rides
const REPEAT_CREDIT = 10;       // every 10 after that — 20, 30, 40…
const REFERRAL_CREDIT = 10;     // to the referrer, once the new rider completes
const WIN_BACK_CREDIT = 10;     // offered to someone who has gone quiet
const BIRTHDAY_CREDIT = 15;     // offered on their birthday

// Reaching Loyal is worth more than staying loyal, which is the point of a
// milestone. $15 once, $10 each time after.

// Loyal is a floor, not a level — once earned it is never taken away, even if
// the sheet is edited by hand afterwards.
function statusFor(points, previousStatus) {
  const wasLoyal = String(previousStatus || '').trim().toLowerCase().includes('loyal');
  if (wasLoyal || points >= LOYAL_POINTS) return STATUS_LOYAL;
  if (points >= 1) return STATUS_REGULAR;
  return STATUS_NEW;
}

// `lastRide` is a plain "YYYY-MM-DD". Anything unreadable counts as Inactive
// rather than silently Active — a wrong "Active" is the misleading one.
function activityFor(lastRide, today = new Date()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(lastRide || ''));
  if (!m) return INACTIVE;
  const then = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const now = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const days = Math.floor((now - then) / 86400000);
  return days <= ACTIVITY_DAYS ? ACTIVE : INACTIVE;
}

// What a completed ride earned, if anything — by the RANGE of points it moved
// through rather than by where it landed.
//
// THE BUG THIS EXISTS TO PREVENT. A round trip is one ride and two points as
// of 4 November (Ahmed's call: the customer was driven twice, so they get
// credit for twice). The old test was `pointsAfter % 10 === 0`, which only ever
// sees a total it lands exactly on. A customer on 9 points booking a round trip
// goes 9 → 11, steps straight over ten, and would never have been given the $15
// the ladder promises — silently, and for the rest of their time as a customer,
// since 21, 31 and 41 miss every milestone too.
//
// Checking the range catches the milestone wherever inside it the jump lands.
// A two-point move can cross at most one ten, so one answer is still enough.
function creditEarnedAcross(pointsBefore, pointsAfter) {
  const before = Math.max(0, parseInt(pointsBefore, 10) || 0);
  const after = Math.max(0, parseInt(pointsAfter, 10) || 0);
  if (after <= before) return null;
  const milestone = Math.floor(after / LOYAL_POINTS) * LOYAL_POINTS;
  // Ride one earns nothing, because ride one was already ten dollars cheaper.
  // See FIRST_RIDE_CREDIT above.
  if (milestone === 0 || milestone <= before) return null;
  return milestone === LOYAL_POINTS
    ? { amount: LOYALTY_CREDIT, reason: 'reached Loyal — 10 rides' }
    : { amount: REPEAT_CREDIT, reason: `${milestone} rides` };
}

// The one-point version, kept because most rides are one ride. Identical to
// what this function has always returned.
function creditEarned(pointsAfter) {
  const after = Math.max(0, parseInt(pointsAfter, 10) || 0);
  return creditEarnedAcross(after - 1, after);
}

// What the NEXT credit is, and how many rides away. Called with the total they
// have now, so the after-the-ride text can always name something to aim at.
//
// This exists because the message used to go silent after ten rides. Someone
// who had just become Loyal was told their balance and nothing else, as though
// the programme had finished. It has not: every tenth ride after that is worth
// another $10, and a customer who is never told that has no reason to count.
function nextMilestone(points) {
  const p = Math.max(0, parseInt(points, 10) || 0);
  if (p < LOYAL_POINTS) {
    return { ridesAway: LOYAL_POINTS - p, amount: LOYALTY_CREDIT, becomesLoyal: true };
  }
  return { ridesAway: LOYAL_POINTS - (p % LOYAL_POINTS), amount: REPEAT_CREDIT, becomesLoyal: false };
}

// Has this year's birthday offer already gone out?
//
// THE BUG THIS FIXES. The birthday list looks seven days ahead, so the same
// person appeared in Ahmed's morning email seven mornings running with nothing
// recording that he had already texted them. The marker is just a year,
// written the moment the offer is actually granted. An unreadable or empty
// marker counts as NOT offered, which is the safe direction to be wrong in:
// he sees the name and decides, rather than a birthday passing in silence.
function birthdayOfferedThisYear(marker, today = new Date()) {
  const m = String(marker || '').match(/\d{4}/);
  return !!m && Number(m[0]) === today.getUTCFullYear();
}

// Someone has gone quiet if their last completed ride is past the 90-day line
// but not so far past that a win-back note would be strange. Anyone further
// gone has already been offered one — the window stops the same customer being
// chased every single day.
const WIN_BACK_WINDOW_DAYS = 30;

function daysSince(dateStr, today = new Date()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr || ''));
  if (!m) return null;
  const then = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const now = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.floor((now - then) / 86400000);
}

function justWentQuiet(lastRide, today = new Date()) {
  const days = daysSince(lastRide, today);
  if (days === null) return false;
  return days > ACTIVITY_DAYS && days <= ACTIVITY_DAYS + WIN_BACK_WINDOW_DAYS;
}

// A birthday coming up in the next few days, so there is time to send
// something before it passes. Stored as MM-DD or any date — only month and day
// are read, and the year is ignored on purpose: a birth year is more than this
// business needs to know.
function birthdayWithin(birthday, days, today = new Date()) {
  // Read whatever shape it was typed in — 9/20, 09-20, 2026-09-20, 1990-09-19,
  // 9-20-1990. Only the month and day are used; the birth YEAR is deliberately
  // ignored and never needed, because a customer's age is more than a car
  // service has any business holding.
  const nums = String(birthday || '').match(/\d+/g);
  if (!nums || nums.length < 2) return false;

  let month, day;
  if (nums[0].length === 4 && nums.length >= 3) {       // 2026-09-20
    month = Number(nums[1]); day = Number(nums[2]);
  } else {                                              // 9/20, 09-20, 9-20-1990
    month = Number(nums[0]); day = Number(nums[1]);
  }
  if (!month || !day || month > 12 || day > 31) return false;

  for (let i = 0; i <= days; i++) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + i));
    if (d.getUTCMonth() + 1 === month && d.getUTCDate() === day) return true;
  }
  return false;
}

// The one-line summary that belongs on every reservation, so whoever is
// looking at a ride knows who they're carrying.
function standingLine({ name, status, activity, points, completedRides }) {
  const star = status === STATUS_LOYAL ? ' ⭐' : '';
  return `${name || 'Customer'} — ${status}${star} · ${activity} · ${points} point${points === 1 ? '' : 's'} · ${completedRides} completed ride${completedRides === 1 ? '' : 's'}`;
}

module.exports = {
  LOYAL_POINTS, ACTIVITY_DAYS,
  STATUS_NEW, STATUS_REGULAR, STATUS_LOYAL, ACTIVE, INACTIVE,
  FIRST_RIDE_CREDIT, LOYALTY_CREDIT, REPEAT_CREDIT, REFERRAL_CREDIT,
  WIN_BACK_CREDIT, BIRTHDAY_CREDIT, WIN_BACK_WINDOW_DAYS,
  statusFor, activityFor, creditEarned, creditEarnedAcross, standingLine, nextMilestone,
  birthdayOfferedThisYear,
  daysSince, justWentQuiet, birthdayWithin,
};
