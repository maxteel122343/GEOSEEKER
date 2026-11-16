/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express from "express";
import { createServer } from "http";
import { createServer as createViteServer } from "vite";
import path from "path";
import { GoogleGenAI, Type } from "@google/genai";
import { ZONES } from "./src/constants";

function stripHttpOptions(val: any): any {
  if (!val || typeof val !== "object") return val;
  if (Array.isArray(val)) return val.map(stripHttpOptions);
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(val)) {
    if (
      k === "httpOptions" ||
      k === "http_options" ||
      k === "__proto__" ||
      k === "constructor" ||
      k === "prototype" ||
      k === "cachedContent" ||
      k === "cached_content" ||
      k === "fileSearch" ||
      k === "file_search" ||
      k === "corpora" ||
      k === "semanticRetriever" ||
      k === "semantic_retriever"
    ) continue;
    if ((k === "fileData" || k === "file_data") && v && typeof v === "object") {
      const rawU = (v as any).fileUri ?? (v as any).file_uri;
      const u = typeof rawU === "string" ? rawU.trim() : "";
      if (!/^https:\/\/(?:www\.|m\.)?(?:youtube\.com|youtu\.be)\//i.test(u)) continue;
    }
    out[k] = stripHttpOptions(v);
  }
  return out;
}


async function startServer() {
  const app = express();
  app.set("trust proxy", 2);
  const httpServer = createServer(app);
  const PORT = Number(process.env.PORT) || 3000;

  app.use(express.json({ limit: "10mb" }));
  app.use((req, _res, next) => {
    if (req.body && typeof req.body === "object") {
      req.body = stripHttpOptions(req.body);
    }
    next();
  });

  // API routes
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/api/streetview", async (req, res) => {
    try {
      const { lat, lng, key } = req.query;
      const sLat = String(lat ?? "").trim();
      const sLng = String(lng ?? "").trim();
      const sKey = String(key ?? "").trim();
      const nLat = Number(sLat);
      const nLng = Number(sLng);
      if (
        !sLat || !sLng || !sKey ||
        !/^-?\d+(?:\.\d+)?$/.test(sLat) ||
        !/^-?\d+(?:\.\d+)?$/.test(sLng) ||
        !Number.isFinite(nLat) || !Number.isFinite(nLng) ||
        nLat < -90 || nLat > 90 || nLng < -180 || nLng > 180 ||
        !/^[A-Za-z0-9_-]{20,128}$/.test(sKey)
      ) {
        return res.status(400).json({ error: "Invalid lat, lng, or key" });
      }
      const urlObj = new URL("https://maps.googleapis.com/maps/api/streetview");
      urlObj.searchParams.set("size", "600x400");
      urlObj.searchParams.set("location", `${nLat},${nLng}`);
      urlObj.searchParams.set("key", sKey);
      const response = await fetch(urlObj.toString(), { redirect: "error" });
      if (!response.ok) {
        throw new Error(`Failed to fetch image: ${response.statusText}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const base64 = buffer.toString("base64");
      res.json({ base64 });
    } catch (error) {
      console.error("Error fetching streetview:", error);
      res.status(500).json({ error: "Failed to fetch streetview image" });
    }
  });

  app.post("/api/hide", async (req, res): Promise<any> => {
    const { zoneId } = req.body || {};
    const zone = ZONES[(zoneId as keyof typeof ZONES) || "global"] || ZONES.global;
    const bounds = zone.bounds;

    const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
    if (!apiKey) {
      return res.status(503).json({
        error: "API key is not configured. Please add your GEMINI_API_KEY in Settings > Secrets.",
      });
    }

    let prompt = `You are playing a game of GeoGuesser/Hide and Seek. You need to pick a hiding spot within the following zone: ${zone.name}.`;
    if (bounds) {
      prompt += ` The bounds are roughly: North ${bounds.north}, South ${bounds.south}, East ${bounds.east}, West ${bounds.west}.`;
    }
    prompt += ` Pick a random, interesting location (like a landmark, a park, or a street) within this area. Return ONLY a JSON object with 'lat', 'lng', and 'message' properties. The 'message' should be a cryptic but playful and cheeky hint about where you are hiding. Have fun with it!`;

    try {
      const ai = new GoogleGenAI({ apiKey });
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              lat: { type: Type.NUMBER },
              lng: { type: Type.NUMBER },
              message: { type: Type.STRING },
            },
            required: ["lat", "lng", "message"],
          },
        },
      });

      const text = response.text;
      if (text) {
        const data = JSON.parse(text);
        return res.json({
          lat: data.lat,
          lng: data.lng,
          message: data.message || "I'm hiding somewhere in this zone! Come find me!",
        });
      }
    } catch (error) {
      console.error("Error getting hiding spot from Gemini:", error);
    }

    return res.json({
      ...zone.center,
      message: "I'm hiding somewhere in this zone! Come find me!",
    });
  });

  app.post("/api/hint", async (req, res): Promise<any> => {
    const { zoneId, hiderLocation, previousGuesses } = req.body || {};
    if (!hiderLocation || typeof hiderLocation.lat !== "number" || typeof hiderLocation.lng !== "number") {
      return res.status(400).json({ error: "Invalid hiderLocation." });
    }

    const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
    if (!apiKey) {
      return res.status(503).json({
        error: "API key is not configured. Please add your GEMINI_API_KEY in Settings > Secrets.",
      });
    }

    const zone = ZONES[(zoneId as keyof typeof ZONES) || "global"] || ZONES.global;
    const guesses = Array.isArray(previousGuesses) ? previousGuesses : [];

    let prompt = `You are hiding at latitude ${hiderLocation.lat}, longitude ${hiderLocation.lng} in ${zone.name}.`;
    prompt += ` The seeker has made ${guesses.length} guesses so far.\n`;
    guesses.forEach((g: any, i: number) => {
      prompt += `Guess ${i + 1} was ${Number(g.distance || 0).toFixed(2)} km away.\n`;
    });
    prompt += `Provide a short, cryptic, playful, and cheeky hint to help them find you. Do not give away the exact location. Have fun taunting them a little bit! Return ONLY a JSON object with a 'hint' property.`;

    try {
      const ai = new GoogleGenAI({ apiKey });
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              hint: { type: Type.STRING },
            },
            required: ["hint"],
          },
        },
      });

      const text = response.text;
      if (text) {
        const data = JSON.parse(text);
        return res.json({ hint: data.hint || "Keep looking! You'll never find me!" });
      }
    } catch (error) {
      console.error("Error getting hint from Gemini:", error);
    }

    return res.json({ hint: "You're getting warmer... or colder! Who knows!" });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(["/server.cjs", "/server.cjs.map"], (_req: any, res: any) => res.status(404).end());
    app.use(express.static(distPath));
    app.use((_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
