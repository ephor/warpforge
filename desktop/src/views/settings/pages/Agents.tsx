import AccountsPanel from "@/components/AccountsPanel";
import AgentSetupPanel from "@/components/AgentSetupPanel";

import { Section } from "../primitives";

export default function AgentsPage() {
  return (
    <div className="flex flex-col gap-8">
      <Section title="Agents" padded>
        <AgentSetupPanel />
      </Section>

      <Section title="Accounts & usage">
        <AccountsPanel />
      </Section>
    </div>
  );
}
