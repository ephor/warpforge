import AccountsPanel from "@/components/AccountsPanel";
import AgentSetupPanel from "@/components/AgentSetupPanel";

import { Section } from "../primitives";

export default function AgentsPage() {
  return (
    <div className="flex flex-col gap-8">
      <Section title="Agents">
        <div className="p-4">
          <AgentSetupPanel />
        </div>
      </Section>

      <Section title="Accounts & usage">
        <div className="p-4">
          <AccountsPanel />
        </div>
      </Section>
    </div>
  );
}
