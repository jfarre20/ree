import { router } from "../server";
import { streamsRouter } from "./streams";
import { uploadsRouter } from "./uploads";

export const appRouter = router({
  streams: streamsRouter,
  uploads: uploadsRouter,
});

export type AppRouter = typeof appRouter;
