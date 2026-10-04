import { describe, expect, test } from "bun:test";
import { runValidationModes } from "@distilled.cloud/core/testing";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { Credentials, DEFAULT_API_BASE_URL } from "./credentials.ts";
import * as Retry from "./retry.ts";
import {
  CreateStorageAccount,
  DeleteStorageAccount,
} from "./services/storage.ts";

const credentials = Layer.succeed(
  Credentials,
  Effect.succeed({
    bearerToken: Redacted.make("mock-token"),
    subscriptionId: "00000000-0000-0000-0000-000000000000",
    apiBaseUrl: DEFAULT_API_BASE_URL,
  }),
);

const request = {
  subscriptionId: "00000000-0000-0000-0000-000000000000",
  resourceGroupName: "rg",
  accountName: "account123",
};

const run = (status: number, headers: Record<string, string>) =>
  runValidationModes(
    DeleteStorageAccount(request).pipe(Retry.none, Effect.provide(credentials)),
    (req) => {
      expect(req.method).toBe("DELETE");
      expect(req.url).toBe(
        "https://management.azure.com/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/account123?api-version=2026-06-01",
      );
      expect(req.headers.authorization).toBe("Bearer mock-token");
      return { status, headers, body: "" };
    },
  );

describe("generated Azure storage LRO response", () => {
  test("an empty 202 create returns polling metadata without requiring a completed resource body", async () => {
    const result = await runValidationModes(
      CreateStorageAccount({
        ...request,
        location: "eastus",
        kind: "StorageV2",
        sku: { name: "Standard_LRS" },
      }).pipe(Retry.none, Effect.provide(credentials)),
      {
        status: 202,
        body: "",
        headers: {
          "Azure-AsyncOperation":
            "https://management.azure.com/operations/create",
          "Retry-After": "5",
        },
      },
    );
    for (const response of [result.lenient, result.strict]) {
      expect(response).toMatchObject({
        _tag: "Success",
        success: {
          statusCode: 202,
          azureAsyncOperation: "https://management.azure.com/operations/create",
          retryAfter: "5",
        },
      });
    }
  });

  test("202 exposes status and modeled polling headers in both modes", async () => {
    const result = await run(202, {
      "Azure-AsyncOperation": "https://management.azure.com/operations/123",
      Location: "https://management.azure.com/operations/123/result",
      "Retry-After": "7",
    });
    const expected = {
      statusCode: 202,
      azureAsyncOperation: "https://management.azure.com/operations/123",
      location: "https://management.azure.com/operations/123/result",
      retryAfter: "7",
    };
    expect(result.lenient).toMatchObject({
      _tag: "Success",
      success: expected,
    });
    expect(result.strict).toMatchObject({ _tag: "Success", success: expected });
  });

  test("204 exposes its status without inventing absent headers", async () => {
    const result = await run(204, {});
    expect(result.lenient).toMatchObject({
      _tag: "Success",
      success: { statusCode: 204 },
    });
    expect(result.strict).toMatchObject({
      _tag: "Success",
      success: { statusCode: 204 },
    });
    if (result.strict._tag === "Success") {
      expect(result.strict.success).toEqual({ statusCode: 204 });
    }
  });
});
