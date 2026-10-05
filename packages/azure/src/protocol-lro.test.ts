import { describe, expect, test } from "bun:test";
import * as API from "@distilled.cloud/core/api";
import * as S from "@distilled.cloud/core/schema";
import { runValidationModes } from "@distilled.cloud/core/testing";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { Credentials, DEFAULT_API_BASE_URL } from "./credentials.ts";
import {
  AzureParseError,
  RoleAssignmentNotFound,
  StorageAccountNotFound,
} from "./errors.ts";
import { AzureProtocol } from "./protocol.ts";
import * as T from "./traits.ts";

const credentials = Layer.succeed(
  Credentials,
  Effect.succeed({
    bearerToken: Redacted.make("test"),
    subscriptionId: "00000000-0000-0000-0000-000000000000",
    apiBaseUrl: DEFAULT_API_BASE_URL,
  }),
);

const input = S.Struct({}).pipe(T.Http({ method: "PUT", uri: "/test" }));
const output = S.Struct({
  status: S.Number.pipe(T.ResponseCode()),
  azureAsyncOperation: S.optional(
    S.String.pipe(T.Header("Azure-AsyncOperation")),
  ),
  location: S.optional(S.String.pipe(T.Header("Location"))),
  retryAfter: S.optional(S.String.pipe(T.Header("Retry-After"))),
  name: S.optional(S.String),
});
const operation = API.make(() => ({ input, output, protocol: AzureProtocol }));

const run = (status: number, body: string, headers: Record<string, string>) =>
  runValidationModes(operation({}).pipe(Effect.provide(credentials)), {
    status,
    body,
    headers,
  });

describe("Azure ARM success response metadata", () => {
  test("202 without a body retains polling headers and status in both validation modes", async () => {
    const result = await run(202, "", {
      "Azure-AsyncOperation": "https://management.azure.com/operations/123",
      Location: "https://management.azure.com/resources/123",
      "Retry-After": "7",
    });
    const expected = {
      status: 202,
      azureAsyncOperation: "https://management.azure.com/operations/123",
      location: "https://management.azure.com/resources/123",
      retryAfter: "7",
    };
    expect(result.lenient).toMatchObject({
      _tag: "Success",
      success: expected,
    });
    expect(result.strict).toMatchObject({ _tag: "Success", success: expected });
  });

  test("201 with a body retains its fields, status, and only the headers present", async () => {
    const result = await run(201, '{"name":"created"}', {
      location: "https://management.azure.com/resources/created",
    });
    const expected = {
      name: "created",
      status: 201,
      location: "https://management.azure.com/resources/created",
    };
    expect(result.lenient).toMatchObject({
      _tag: "Success",
      success: expected,
    });
    expect(result.strict).toMatchObject({ _tag: "Success", success: expected });
    if (result.strict._tag === "Success") {
      expect(result.strict.success).toEqual(expected);
    }
  });

  test("strict mode still rejects an invalid body after projecting metadata", async () => {
    const result = await run(201, '{"name":42}', { "Retry-After": "3" });
    expect(result.lenient._tag).toBe("Success");
    expect(result.strict._tag).toBe("Failure");
    if (result.strict._tag === "Failure") {
      expect(result.strict.failure).toBeInstanceOf(AzureParseError);
    }
  });

  test("strict mode accepts a numeric Retry-After header when modeled as a number", async () => {
    const numericOutput = S.Struct({
      retryAfter: S.Number.pipe(T.Header("Retry-After")),
    });
    const numericOperation = API.make(() => ({
      input,
      output: numericOutput,
      protocol: AzureProtocol,
    }));
    const result = await runValidationModes(
      numericOperation({}).pipe(Effect.provide(credentials)),
      { status: 202, body: "", headers: { "Retry-After": "7" } },
    );
    expect(result.strict).toMatchObject({
      _tag: "Success",
      success: { retryAfter: 7 },
    });
  });
});

describe("Azure ARM resource-specific errors", () => {
  test("404 role assignment errors are typed", async () => {
    const result = await run(
      404,
      JSON.stringify({
        error: {
          code: "RoleAssignmentNotFound",
          message: "The role assignment is not found",
        },
      }),
      {},
    );
    expect(result.strict._tag).toBe("Failure");
    if (result.strict._tag === "Failure")
      expect(result.strict.failure).toBeInstanceOf(RoleAssignmentNotFound);
  });

  test("404 storage account errors are typed", async () => {
    const result = await run(
      404,
      JSON.stringify({
        error: {
          code: "StorageAccountNotFound",
          message: "The storage account is not found",
        },
      }),
      {},
    );
    expect(result.strict._tag).toBe("Failure");
    if (result.strict._tag === "Failure")
      expect(result.strict.failure).toBeInstanceOf(StorageAccountNotFound);
  });
});
