"use client";

import { createTRPCReact } from "@trpc/react-query";
import type { AppRouter } from "./routers/index";

export const trpc = createTRPCReact<AppRouter>();
