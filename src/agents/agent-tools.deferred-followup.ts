import type { AnyAgentTool } from "./agent-tools.types.js";
import { describeExecTool, describeProcessTool } from "./bash-tools.descriptions.js";

export function applyDeferredFollowupToolDescriptions(
  tools: AnyAgentTool[],
  params?: { agentId?: string },
): AnyAgentTool[] {
  const toolNames = tools.map((tool) => safeToolName(tool));
  const hasCronTool = toolNames.some((name) => name === "cron");
  return tools.map((tool, index) => {
    const name = toolNames[index];
    if (name === "exec") {
      return {
        ...tool,
        description: describeExecTool({ agentId: params?.agentId, hasCronTool }),
      };
    }
    if (name === "process") {
      return {
        ...tool,
        description: describeProcessTool({ hasCronTool }),
      };
    }
    return tool;
  });
}

function safeToolName(tool: AnyAgentTool): string | undefined {
  try {
    return tool.name;
  } catch {
    return undefined;
  }
}
