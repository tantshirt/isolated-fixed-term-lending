/* eslint-disable */
  /**
   * Generated `api` utility.
   *
   * THIS CODE IS AUTOMATICALLY GENERATED.
   *
   * To regenerate, run `npx convex dev`.
   * @module
   */
  
  import type { ApiFromModules, FilterApi, FunctionReference } from "convex/server";
  import type * as auth from "../auth.js";
import type * as crons from "../crons.js";
import type * as http from "../http.js";
import type * as jobRunner from "../jobRunner.js";
import type * as jobs from "../jobs.js";
import type * as keeper from "../keeper.js";
import type * as keeperData from "../keeperData.js";
import type * as lib_handlers from "../lib/handlers.js";
import type * as lib_jwt from "../lib/jwt.js";
import type * as ops from "../ops.js";
import type * as opsNode from "../opsNode.js";

  /**
   * A utility for referencing Convex functions in your app's API.
   *
   * Usage:
   * ```js
   * const myFunctionReference = api.myModule.myFunction;
   * ```
   */
  declare const fullApi: ApiFromModules<{
    "auth": typeof auth,
"crons": typeof crons,
"http": typeof http,
"jobRunner": typeof jobRunner,
"jobs": typeof jobs,
"keeper": typeof keeper,
"keeperData": typeof keeperData,
"lib/handlers": typeof lib_handlers,
"lib/jwt": typeof lib_jwt,
"ops": typeof ops,
"opsNode": typeof opsNode,
  }>;
  export declare const api: FilterApi<typeof fullApi, FunctionReference<any, "public">>;
  export declare const internal: FilterApi<typeof fullApi, FunctionReference<any, "internal">>;
  