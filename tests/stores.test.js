import test from "node:test";
import assert from "node:assert/strict";
import { deduplicateStores } from "../src/repository.js";

function store(id, values = {}) {
  return {
    id,
    retailer: "Carrefour",
    name: "Carrefour Express",
    address: "Torino",
    latitude: 45.07,
    longitude: 7.71,
    distance_km: 0.5,
    selected: false,
    analysis_status: "not_started",
    source_url: null,
    ...values,
  };
}

test("store reconciliation keeps reliable branches and removes duplicate or incomplete chain records", () => {
  const rows = [
    store("belgio-live", { address: "Corso Belgio, Torino", latitude: 45.0729, longitude: 7.7137, distance_km: 0.15, selected: true, analysis_status: "ready", source_url: "https://www.carrefour.it/volantino/belgio/1278" }),
    store("casale-incomplete", { latitude: 45.0683, longitude: 7.7137, distance_km: 0.56, source_url: "https://www.carrefour.it/punti-vendita/casale.html" }),
    store("cadore", { name: "Carrefour", address: "Corso Cadore 41C, Torino", latitude: 45.0734, longitude: 7.7249, distance_km: 0.73 }),
    store("belgio-seed", { name: "Carrefour Market · Corso Belgio", address: "Corso Belgio 173, Torino", latitude: 45.0797, longitude: 7.7082, distance_km: 0.8, selected: true, analysis_status: "unsupported" }),
    store("unknown-incomplete", { latitude: 45.0669, longitude: 7.7095, distance_km: 0.85 }),
    store("coop-only", { retailer: "Coop", name: "Coop", latitude: 45.075, longitude: 7.7227, distance_km: 0.6 }),
  ];

  const reconciled = deduplicateStores(rows);
  assert.deepEqual(reconciled.filter((row) => row.retailer === "Carrefour").map((row) => row.id), ["belgio-live", "cadore"]);
  assert.ok(reconciled.some((row) => row.id === "coop-only"));
});
