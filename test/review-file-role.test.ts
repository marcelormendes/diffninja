import { describe, expect, test } from "vitest";
import { testLikeFile } from "../src/review/file-role.js";

describe("testLikeFile", () => {
  test.each([
    "test/res.send.js",
    "tests/test_api.py",
    "src/__tests__/a.ts",
    "spec/models/user_spec.rb",
    "src/a.test.ts",
    "src/a.spec.jsx",
    "index.test-d.ts",
    "test.js",
    "packages/core/tests.mjs",
    "test_client.py",
    "httpx/client_test.py",
    "pkg/server_test.go",
    "app/models/user_test.rb",
    "src/main/java/FooTest.java",
    "Sources/FooTests.swift",
    "C:\\repo\\tests\\a.cs",
  ])("recognizes %s as a test file", (file) => {
    expect(testLikeFile(file)).toBe(true);
  });

  test.each([
    "index.js",
    "index.d.ts",
    "readme.md",
    "docs/testing.md",
    "src/latest.js",
    "src/contest.ts",
    "lib/attestation.py",
    "src/Contest.java",
    "src/testing/utils.ts",
    ".github/workflows/test.yml",
  ])("does not treat %s as a test file", (file) => {
    expect(testLikeFile(file)).toBe(false);
  });
});
