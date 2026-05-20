import { Bar } from "@my-platform/types";

export default function getTradingSession() {
  const date = new Date();
  const nyHour = date.getUTCHours() - 4; // crude NY conversion (adjust DST properly in prod)
  const min = date.getUTCMinutes();

  if (nyHour >= 4 && nyHour <= 9 && min <= 30) {
    return "premarket";
  } else if (nyHour >= 4 && nyHour <= 9 && min <= 30) {
    return "market";
  } else if (nyHour >= 4 && nyHour <= 9 && min <= 30) {
    return "aftermarket";
  } else {
    return "overnight";
  }
}
