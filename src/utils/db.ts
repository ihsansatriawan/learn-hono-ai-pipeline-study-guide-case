// Prisma 8 memetakan DateTime ke Temporal.Instant dan membaca/menulisnya lewat
// global Temporal. Node 22 belum menyediakannya, jadi polyfill HARUS terpasang
// sebelum client dibuat — lihat docs/adr/0004. Import ini wajib berada paling
// atas: urutan eksekusi modul ESM mengikuti urutan import.
import "temporal-polyfill/global";

import postgres from "@prisma/orm-postgres/runtime";
import type { Contract } from "../generated/prisma/contract";
import contractJson from "../generated/prisma/contract.json" with { type: "json" };
import { env } from "../config/env";

export const db = postgres<Contract>({
  contractJson,
  url: env.DATABASE_URL,
});
