import vinextHandler from "vinext/server/fetch-handler";
import { createWorkerEntrypoint } from "./create-worker";

export default createWorkerEntrypoint<Cloudflare.Env>(vinextHandler);
