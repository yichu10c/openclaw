import { describe, expect, it } from "vitest";
import { sanitizeResponsesImagePayload } from "./responses-image-payload-sanitizer.js";

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=";

describe("Responses image payload sanitizer", () => {
  it("replaces malformed input_image data URLs before sending Responses payloads", () => {
    const sanitized = sanitizeResponsesImagePayload({
      input: [
        {
          type: "function_call_output",
          call_id: "call_1",
          output: [{ type: "input_image", image_url: "data:image/jpeg;base64,not base64!" }],
        },
      ],
    });

    expect(sanitized.input).toEqual([
      {
        type: "function_call_output",
        call_id: "call_1",
        output: [
          {
            type: "input_text",
            text: "[omitted image payload: invalid inline image data]",
          },
        ],
      },
    ]);
  });

  it("canonicalizes valid inline image payloads and keeps URL image references", () => {
    const sanitized = sanitizeResponsesImagePayload({
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_image", image_url: `data:image/jpeg;base64,\n${PNG_1X1}` },
            { type: "input_image", image_url: "https://example.test/image.png" },
          ],
        },
      ],
    });

    expect(sanitized.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_image", image_url: `data:image/png;base64,${PNG_1X1}` },
          { type: "input_image", image_url: "https://example.test/image.png" },
        ],
      },
    ]);
  });

  it("omits circular tool output payloads before sending Responses payloads", () => {
    const output: Record<string, unknown> = {
      type: "function_call_output",
      call_id: "call_fuzzplugin_payload",
      output: [],
    };
    (output.output as unknown[]).push(output);

    const sanitized = sanitizeResponsesImagePayload({
      input: [output],
    });

    expect(sanitized.input).toEqual([
      {
        type: "function_call_output",
        call_id: "call_fuzzplugin_payload",
        output: [
          {
            type: "input_text",
            text: "[omitted image payload: circular reference]",
          },
        ],
      },
    ]);
    expect(() => JSON.stringify(sanitized)).not.toThrow();
  });

  it("keeps input array-shaped when omitting circular array payloads", () => {
    const input: unknown[] = [];
    input.push(input);

    const sanitized = sanitizeResponsesImagePayload({
      input,
    });

    expect(sanitized.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "[omitted image payload: circular reference]",
          },
        ],
      },
    ]);
    expect(() => JSON.stringify(sanitized)).not.toThrow();
  });

  it("does not preserve circular fields when canonicalizing valid inline image payloads", () => {
    const image: Record<string, unknown> = {
      type: "input_image",
      image_url: `data:image/jpeg;base64,\n${PNG_1X1}`,
    };
    image.fuzzplugin = image;

    const sanitized = sanitizeResponsesImagePayload({
      input: [
        {
          type: "message",
          role: "user",
          content: [image],
        },
      ],
    });

    expect(sanitized.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_image",
            image_url: `data:image/png;base64,${PNG_1X1}`,
            fuzzplugin: {
              type: "input_text",
              text: "[omitted image payload: circular reference]",
            },
          },
        ],
      },
    ]);
    expect(() => JSON.stringify(sanitized)).not.toThrow();
  });

  it("omits unreadable nested payload objects before sending Responses payloads", () => {
    const metadata: Record<string, unknown> = {};
    Object.defineProperty(metadata, "fuzzplugin", {
      enumerable: true,
      get() {
        throw new Error("fuzzplugin payload read failed");
      },
    });

    const sanitized = sanitizeResponsesImagePayload({
      input: [
        {
          type: "message",
          role: "user",
          content: "inspect fuzzplugin metadata",
          metadata,
        },
      ],
    });

    expect(sanitized.input).toEqual([
      {
        type: "message",
        role: "user",
        content: "inspect fuzzplugin metadata",
        metadata: {
          type: "input_text",
          text: "[omitted image payload: unreadable payload]",
        },
      },
    ]);
  });

  it("uses a valid top-level input item when an input item is unreadable", () => {
    const inputItem: Record<string, unknown> = {
      role: "user",
    };
    Object.defineProperty(inputItem, "type", {
      enumerable: true,
      get() {
        throw new Error("fuzzplugin input item read failed");
      },
    });

    const sanitized = sanitizeResponsesImagePayload({
      input: [inputItem],
    });

    expect(sanitized.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "[omitted image payload: unreadable payload]",
          },
        ],
      },
    ]);
  });

  it("omits non-JSON-compatible primitive object fields", () => {
    const sanitized = sanitizeResponsesImagePayload({
      input: [
        {
          type: "message",
          role: "user",
          content: "inspect fuzzplugin primitive metadata",
          metadata: {
            count: 1n,
            marker: Symbol("fuzzplugin"),
            validate: () => true,
            missing: undefined,
            score: Number.POSITIVE_INFINITY,
          },
        },
      ],
    });

    expect(sanitized.input).toEqual([
      {
        type: "message",
        role: "user",
        content: "inspect fuzzplugin primitive metadata",
        metadata: {
          score: null,
        },
      },
    ]);
    expect(() => JSON.stringify(sanitized)).not.toThrow();
  });

  it("replaces non-JSON-compatible primitive array entries", () => {
    const sanitized = sanitizeResponsesImagePayload({
      input: [
        {
          type: "message",
          role: "user",
          content: [1n, Symbol("fuzzplugin"), () => true, undefined, Number.NaN],
        },
      ],
    });

    expect(sanitized.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "[omitted image payload: non-JSON-compatible value]",
          },
          {
            type: "input_text",
            text: "[omitted image payload: non-JSON-compatible value]",
          },
          {
            type: "input_text",
            text: "[omitted image payload: non-JSON-compatible value]",
          },
          {
            type: "input_text",
            text: "[omitted image payload: non-JSON-compatible value]",
          },
          null,
        ],
      },
    ]);
    expect(() => JSON.stringify(sanitized)).not.toThrow();
  });
});
