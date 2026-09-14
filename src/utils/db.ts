// Prisma 8 maps DateTime to Temporal.Instant and reads/writes it through the
// global Temporal. Node 22 does not ship it yet, so the polyfill MUST be in
// place before the client is created — see docs/adr/0004. This import has to
// stay at the very top: ESM module execution follows import order.
import "temporal-polyfill/global";

import postgres from "@prisma/orm-postgres/runtime";
import type { Contract } from "../generated/prisma/contract";
import contractJson from "../generated/prisma/contract.json" with { type: "json" };
import { env } from "../config/env";

export const db = postgres<Contract>({
  contractJson,
  url: env.DATABASE_URL,
});
