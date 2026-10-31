import { describe, expect, it } from "vitest";
import { CliError, mergeTestFields, parseBoolArg, parseJsonObjectArg } from "../src/shared/cli.js";

describe("mergeTestFields (--reporter / --test-fields precedence)", () => {
  it("layers config → reporter → test-fields blob", () => {
    expect(
      mergeTestFields({ customfield_1: 170 }, "abc-123", { customfield_2: "x" }),
    ).toEqual({ customfield_1: 170, reporter: { id: "abc-123" }, customfield_2: "x" });
  });

  it("an explicit reporter in --test-fields wins over the --reporter flag", () => {
    expect(mergeTestFields(undefined, "flag-id", { reporter: { id: "blob-id" } })).toEqual({
      reporter: { id: "blob-id" },
    });
  });

  it("ignores an empty/whitespace reporter (unset pipeline parameter)", () => {
    expect(mergeTestFields({ a: 1 }, "   ", undefined)).toEqual({ a: 1 });
    expect(mergeTestFields(undefined, undefined, undefined)).toEqual({});
  });
});

describe("parseBoolArg (--derive-requirements / --adversarial-critique)", () => {
  it("parses truthy/falsy spellings", () => {
    for (const v of ["true", "1", "yes", "on", "TRUE", " On "]) expect(parseBoolArg(v, "--x")).toBe(true);
    for (const v of ["false", "0", "no", "off", "FALSE"]) expect(parseBoolArg(v, "--x")).toBe(false);
  });
  it("returns undefined for absent/empty (fall back to config)", () => {
    expect(parseBoolArg(undefined, "--x")).toBeUndefined();
    expect(parseBoolArg("", "--x")).toBeUndefined();
    expect(parseBoolArg("   ", "--x")).toBeUndefined();
  });
  it("throws on an unrecognized value", () => {
    expect(() => parseBoolArg("maybe", "--x")).toThrow(CliError);
  });
});

describe("parseJsonObjectArg (--test-fields)", () => {
  it("parses a JSON object into a record", () => {
    expect(parseJsonObjectArg('{"customfield_15714":170}', "--test-fields")).toEqual({ customfield_15714: 170 });
  });

  it("supports nested/structured values", () => {
    expect(parseJsonObjectArg('{"customfield_1":{"id":"170"},"labels":["a"]}', "--test-fields")).toEqual({
      customfield_1: { id: "170" },
      labels: ["a"],
    });
  });

  it("returns undefined for absent or empty/whitespace input", () => {
    expect(parseJsonObjectArg(undefined, "--test-fields")).toBeUndefined();
    expect(parseJsonObjectArg("", "--test-fields")).toBeUndefined();
    expect(parseJsonObjectArg("   ", "--test-fields")).toBeUndefined();
  });

  it("throws CliError on invalid JSON", () => {
    expect(() => parseJsonObjectArg("{not json}", "--test-fields")).toThrow(CliError);
  });

  it("throws CliError when the JSON is not an object (array/scalar)", () => {
    expect(() => parseJsonObjectArg("[1,2]", "--test-fields")).toThrow(/must be a JSON object/);
    expect(() => parseJsonObjectArg("170", "--test-fields")).toThrow(/must be a JSON object/);
    expect(() => parseJsonObjectArg('"x"', "--test-fields")).toThrow(/must be a JSON object/);
  });
});
