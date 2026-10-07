/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as alerts from "../alerts.js";
import type * as alertsNode from "../alertsNode.js";
import type * as auth from "../auth.js";
import type * as cash from "../cash.js";
import type * as cashNode from "../cashNode.js";
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
import type * as pilot from "../pilot.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  alerts: typeof alerts;
  alertsNode: typeof alertsNode;
  auth: typeof auth;
  cash: typeof cash;
  cashNode: typeof cashNode;
  crons: typeof crons;
  http: typeof http;
  jobRunner: typeof jobRunner;
  jobs: typeof jobs;
  keeper: typeof keeper;
  keeperData: typeof keeperData;
  "lib/handlers": typeof lib_handlers;
  "lib/jwt": typeof lib_jwt;
  ops: typeof ops;
  opsNode: typeof opsNode;
  pilot: typeof pilot;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
