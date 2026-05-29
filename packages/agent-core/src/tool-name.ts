import type { Tool } from "./llm.js";

export function readUsableToolName(tool: Pick<Tool, "name">): string | undefined {
  try {
    const name = tool.name;
    return typeof name === "string" && name.trim() !== "" ? name : undefined;
  } catch {
    return undefined;
  }
}

export function collectUsableToolNames(tools: readonly Pick<Tool, "name">[]): string[] {
  return tools.flatMap((tool) => {
    const name = readUsableToolName(tool);
    return name === undefined ? [] : [name];
  });
}

export function buildUsableToolMap<TTool extends Pick<Tool, "name">>(
  tools: readonly TTool[],
): Map<string, TTool> {
  const entries = tools.flatMap((tool): Array<[string, TTool]> => {
    const name = readUsableToolName(tool);
    return name === undefined ? [] : [[name, tool]];
  });
  return new Map(entries);
}

export function findToolByName<TTool extends Pick<Tool, "name">>(
  tools: readonly TTool[] | undefined,
  name: string,
): TTool | undefined {
  for (const tool of tools ?? []) {
    if (readUsableToolName(tool) === name) {
      return tool;
    }
  }
  return undefined;
}
