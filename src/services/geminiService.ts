/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { ZONES } from "../constants";

export async function geminiHide(
  zoneId: string
): Promise<{ lat: number; lng: number; message: string }> {
  const zone = ZONES[zoneId as keyof typeof ZONES] || ZONES.global;

  try {
    const response = await fetch("/api/hide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ zoneId }),
    });
    if (response.ok) {
      const data = await response.json();
      if (typeof data.lat === "number" && typeof data.lng === "number") {
        return {
          lat: data.lat,
          lng: data.lng,
          message: data.message || "I'm hiding somewhere in this zone! Come find me!",
        };
      }
    }
  } catch (error) {
    console.error("Error getting hiding spot from server:", error);
  }

  // Fallback to center of zone if server call fails
  return {
    ...zone.center,
    message: "I'm hiding somewhere in this zone! Come find me!",
  };
}

export async function geminiProvideHint(
  zoneId: string,
  hiderLocation: { lat: number; lng: number },
  previousGuesses: { lat: number; lng: number; distance: number; bearing: number }[]
): Promise<string> {
  try {
    const response = await fetch("/api/hint", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ zoneId, hiderLocation, previousGuesses }),
    });
    if (response.ok) {
      const data = await response.json();
      if (data?.hint) {
        return data.hint;
      }
    }
  } catch (error) {
    console.error("Error getting hint from server:", error);
  }

  return "You're getting warmer... or colder! Who knows!";
}
