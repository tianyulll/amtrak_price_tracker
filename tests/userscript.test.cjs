const assert = require("node:assert/strict");
const test = require("node:test");

const {
  canonicalDate,
  clockMinutes,
  evaluateThresholds,
  filterFaresForManualScan,
  filterFaresByWindow,
  formatTime24,
  minimumFarePrice,
  pageCountFromText,
  parseCardText,
  windowMinuteValue,
} = require("../trackline-amtrak.user.js");

const CARD = `
NYP to PHL
Lowest Fare
179
Northeast Regional
DEPARTS
12:11
a
1h 28m
ARRIVES
1:39
a
Trip Details
Coach
from
$
10
Business
from
$
70
Private Rooms
Not Offered
`;

test("parses each offered fare class from an Amtrak card", () => {
  const fares = parseCardText(CARD);
  assert.deepEqual(
    fares.map((fare) => [fare.fareClass, fare.price]),
    [["Coach", 10], ["Business", 70]],
  );
  assert.equal(fares[0].trainNumber, "179");
  assert.equal(fares[0].departureTime, "12:11 AM");
});

test("normalizes numeric and named travel dates", () => {
  assert.equal(canonicalDate("09/15/2026"), "2026-09-15");
  assert.equal(canonicalDate("Tuesday, September 15, 2026"), "2026-09-15");
});

test("filters departures within normal and overnight windows", () => {
  const fares = [
    { departureTime: "6:00 AM" },
    { departureTime: "6:45 AM" },
    { departureTime: "11:30 PM" },
    { departureTime: "1:15 AM" },
  ];
  assert.equal(clockMinutes("12:00 AM"), 0);
  assert.deepEqual(filterFaresByWindow(fares, "6", "6"), [fares[0], fares[1]]);
  assert.deepEqual(filterFaresByWindow(fares, "06:15", "06:50"), [fares[1]]);
  assert.deepEqual(filterFaresByWindow(fares, "22", "2"), [fares[2], fares[3]]);
  assert.deepEqual(filterFaresByWindow(fares, "", ""), fares);
  assert.equal(formatTime24("12:11 AM"), "00:11");
  assert.equal(formatTime24("11:30 PM"), "23:30");
  assert.equal(windowMinuteValue("6:05"), "05");
  assert.equal(windowMinuteValue(""), "00");
});

test("alerts once at the target and again only after crossing back below", () => {
  const [fare] = parseCardText(CARD);
  const first = evaluateThresholds({}, [fare], 12);
  assert.equal(first.hits.length, 1);

  const stillBelow = evaluateThresholds(first.nextStates, [{ ...fare, price: 9 }], 12);
  assert.equal(stillBelow.hits.length, 0);

  const above = evaluateThresholds(stillBelow.nextStates, [{ ...fare, price: 14 }], 12);
  assert.equal(above.hits.length, 0);
  const crossed = evaluateThresholds(above.nextStates, [{ ...fare, price: 11 }], 12);
  assert.equal(crossed.hits.length, 1);

  const absent = evaluateThresholds(crossed.nextStates, [], 12);
  const returned = evaluateThresholds(absent.nextStates, [{ ...fare, price: 11 }], 12);
  assert.equal(returned.hits.length, 1);
});

test("calculates pagination from Amtrak's result summary", () => {
  assert.equal(pageCountFromText("Showing 1 - 10 of 10"), 1);
  assert.equal(pageCountFromText("Showing 1 - 10 of 57"), 6);
  assert.equal(pageCountFromText("Showing 11 - 20 of 27"), 3);
  assert.equal(pageCountFromText("No pagination summary"), 1);
});

test("applies the departure window before target-price evaluation", () => {
  const [parsedFare] = parseCardText(CARD);
  const morningFare = {
    ...parsedFare,
    key: parsedFare.key.replace("12:11 AM", "6:00 AM"),
    departureTime: "6:00 AM",
  };
  const overnightFare = {
    ...morningFare,
    key: morningFare.key.replace("12:11 AM", "11:30 PM"),
    departureTime: "11:30 PM",
    price: 20,
  };
  const matching = filterFaresByWindow([morningFare, overnightFare], "22", "2");
  assert.deepEqual(matching, [overnightFare]);
  assert.deepEqual(
    evaluateThresholds({}, matching, 25).hits.map((fare) => fare.departureTime),
    ["11:30 PM"],
  );
});

test("manual scans apply both the hour window and optional price ceiling", () => {
  const fares = [
    { departureTime: "6:00 AM", price: 10 },
    { departureTime: "11:30 PM", price: 20 },
    { departureTime: "1:15 AM", price: 30 },
  ];
  assert.deepEqual(filterFaresForManualScan(fares, "22", "2", 25), [fares[1]]);
  assert.deepEqual(filterFaresForManualScan(fares, "22", "2", null), [fares[1], fares[2]]);
  assert.equal(minimumFarePrice(filterFaresByWindow(fares, "22", "2")), 20);
  assert.equal(minimumFarePrice([]), null);
});
