import { useEffect, useState } from "react";
import { builtinCapabilities } from "../../server/capabilities/definitions.js";
import { withBuiltinCapabilityUsage, type CapabilityDefinition } from "../lib/capabilities";
import { loadWorkflowCapabilities } from "../lib/api";
export function useCapabilities() {
  const [capabilities, setCapabilities] = useState<CapabilityDefinition[]>(builtinCapabilities);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    loadWorkflowCapabilities().then((result) => { if (active) { setCapabilities(withBuiltinCapabilityUsage(result.capabilities)); setError(""); } }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : "能力目录加载失败");
    });
    return () => { active = false; };
  }, []);
  return { capabilities, error };
}
