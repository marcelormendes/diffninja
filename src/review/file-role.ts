/**
 * Path-shape classification of test files, shared by the evidence scan and the
 * report order. It is a deterministic fact about the path only: it says nothing
 * about coverage, whether the file runs, or whether its change is harmless.
 * Documentation is deliberately not a role here: prose can carry normative
 * instructions, so it is ranked by its observations like any other source.
 */

/** A directory whose name marks test code, at any depth. */
const TEST_DIRECTORY = /(?:^|\/)(?:tests?|__tests__|specs?)\//;

/** File names that mark test code by convention, in any directory. */
const TEST_FILE_NAMES: readonly RegExp[] = [
  // foo.test.ts, foo.spec.jsx, and tsd type tests such as index.test-d.ts
  /\.(?:test|spec)(?:-d)?\.[cm]?[jt]sx?$/,
  // a module named test or tests, such as a package's root test.js
  /(?:^|\/)tests?\.[cm]?[jt]sx?$/,
  // pytest discovery: test_*.py and *_test.py
  /(?:^|\/)test_[^/]+\.py$/,
  /_test\.py$/,
  // Go, Ruby
  /_test\.go$/,
  /_(?:spec|test)\.rb$/,
  // JUnit / xUnit / XCTest class naming: FooTest.java, FooTests.cs
  /(?:^|\/)[^/]+Tests?\.(?:java|kt|cs|swift)$/,
];

/** True when the path looks like test code by directory or file-name convention. */
export function testLikeFile(file: string): boolean {
  const path = file.replace(/\\/g, "/");
  return TEST_DIRECTORY.test(path) || TEST_FILE_NAMES.some((pattern) => pattern.test(path));
}
