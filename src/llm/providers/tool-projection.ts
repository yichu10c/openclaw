import { projectRuntimeToolInputSchema } from "../../agents/tool-schema-projection.js";
import type { Tool } from "../types.js";

export type ProjectedProviderTool = {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
};

type ProviderToolField = "name" | "description" | "parameters";

type ProviderToolReadResult =
  | {
      ok: true;
      value: unknown;
    }
  | {
      ok: false;
    };

function readProviderToolField(
  tool: Pick<Tool, ProviderToolField>,
  field: ProviderToolField,
): ProviderToolReadResult {
  try {
    return { ok: true, value: tool[field] };
  } catch {
    return { ok: false };
  }
}

export function projectProviderTools(
  tools: readonly Pick<Tool, ProviderToolField>[],
): ProjectedProviderTool[] {
  return tools.flatMap((tool) => {
    const nameRead = readProviderToolField(tool, "name");
    if (!nameRead.ok || typeof nameRead.value !== "string" || nameRead.value.trim() === "") {
      return [];
    }

    const parametersRead = readProviderToolField(tool, "parameters");
    if (!parametersRead.ok) {
      return [];
    }

    const parametersProjection = projectRuntimeToolInputSchema(
      parametersRead.value,
      `${nameRead.value}.parameters`,
    );
    if (parametersProjection.violations.length > 0) {
      return [];
    }

    const descriptionRead = readProviderToolField(tool, "description");
    const description =
      descriptionRead.ok && typeof descriptionRead.value === "string"
        ? descriptionRead.value
        : undefined;

    return [
      {
        name: nameRead.value,
        ...(description !== undefined ? { description } : {}),
        parameters: parametersProjection.schema as Record<string, unknown>,
      },
    ];
  });
}
