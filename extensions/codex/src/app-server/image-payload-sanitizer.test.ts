import { describe, expect, it } from "vitest";
import {
  invalidInlineImageText,
  sanitizeCodexHistoryImagePayloads,
  sanitizeInlineImageDataUrl,
} from "./image-payload-sanitizer.js";

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=";

describe("Codex app-server image payload sanitizer", () => {
  it("drops malformed data URL image payloads", () => {
    expect(sanitizeInlineImageDataUrl("data:image/jpeg;base64,not base64!")).toBeUndefined();
  });

  it("canonicalizes valid data URL images with sniffed MIME type", () => {
    expect(sanitizeInlineImageDataUrl(`data:image/jpeg;base64,\n${PNG_1X1}`)).toBe(
      `data:image/png;base64,${PNG_1X1}`,
    );
  });

  it("formats the text replacement used for invalid images", () => {
    expect(invalidInlineImageText("codex user input")).toContain("invalid inline image data");
  });

  it("scrubs invalid image blocks from mirrored history values", () => {
    expect(
      sanitizeCodexHistoryImagePayloads(
        [
          {
            role: "toolResult",
            content: [{ type: "image", mimeType: "image/jpeg", data: "not base64!" }],
          },
        ],
        "codex mirrored history",
      ),
    ).toEqual([
      {
        role: "toolResult",
        content: [
          {
            type: "text",
            text: "[codex mirrored history] omitted image payload: invalid inline image data",
          },
        ],
      },
    ]);
  });

  it("preserves URL-backed image blocks from mirrored history values", () => {
    expect(
      sanitizeCodexHistoryImagePayloads(
        [
          {
            role: "user",
            content: [{ type: "image", url: "https://example.test/fuzzplugin.png" }],
          },
        ],
        "codex mirrored history",
      ),
    ).toEqual([
      {
        role: "user",
        content: [{ type: "image", url: "https://example.test/fuzzplugin.png" }],
      },
    ]);
  });

  it("omits unreadable synthetic mirrored history fields", () => {
    const value: Record<string, unknown> = {
      plugin: "fuzzplugin",
      content: [{ type: "text", text: "visible" }],
    };
    Object.defineProperty(value, "unreadable", {
      enumerable: true,
      get() {
        throw new Error("fuzzplugin mirrored history read failed");
      },
    });

    expect(() => sanitizeCodexHistoryImagePayloads(value, "codex mirrored history")).not.toThrow();
    expect(sanitizeCodexHistoryImagePayloads(value, "codex mirrored history")).toEqual({
      plugin: "fuzzplugin",
      content: [{ type: "text", text: "visible" }],
    });
  });

  it("scrubs unreadable synthetic image payload fields", () => {
    const imageBlock: Record<string, unknown> = {
      type: "image",
      mimeType: "image/png",
    };
    Object.defineProperty(imageBlock, "data", {
      enumerable: true,
      get() {
        throw new Error("fuzzplugin image data read failed");
      },
    });

    const inputImageBlock: Record<string, unknown> = {
      type: "inputImage",
    };
    Object.defineProperty(inputImageBlock, "imageUrl", {
      enumerable: true,
      get() {
        throw new Error("mockplugin image URL read failed");
      },
    });

    expect(
      sanitizeCodexHistoryImagePayloads([imageBlock, inputImageBlock], "codex mirrored history"),
    ).toEqual([
      {
        type: "text",
        text: "[codex mirrored history] omitted image payload: invalid inline image data",
      },
      {
        type: "inputText",
        text: "[codex mirrored history] omitted image payload: invalid inline image data",
      },
    ]);
  });
});
